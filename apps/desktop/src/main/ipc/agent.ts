import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Clock, GtdStore } from '@gtd/domain';
import { toolManual } from '@gtd/agent-tools';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { authStatus } from '../agent/auth';
import { broadcastChanged } from './gtd';
import { ensureUserMemory, readUserMemory, writeUserMemory } from '../agent/userMemory';
import {
  deleteSkill,
  listSkills,
  readSkill,
  resetSkill,
  syncBuiltinSkills,
  writeSkill,
} from '../agent/skills';
import { agentStore, settingsStore } from '../db';
import {
  attachmentsDir,
  currentConversationId,
  destroySession,
  interruptTurn,
  send,
  sessionAlive,
  setEffort,
  setModel,
  setPermissionMode,
  setThinking,
  startSession,
  supportedModels,
} from '../agent/sessionManager';
import type { AgentImage } from '../agent/sessionManager';
import {
  createConversation,
  listConversations,
  removeConversation,
  titleFromFirstMessage,
  transcript,
} from '../agent/conversations';
import {
  ALWAYS_ALLOW_KEY,
  PERMISSION_MODE_KEY,
  readAlwaysAllow,
  readMode,
  respondPermission,
  type PermissionResponse,
} from '../agent/permissions';
import { buildCanUseTool, recordSdkMessage } from '../agent/bookkeeping';
import {
  isModeAvailable,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODES,
  type PermissionModeId,
} from '@gtd/agent-tools';

/**
 * Agent 通道。M8 只读;M9 加写工具 + 审批桥 + 审计;M10 加会话管理、用量账本、
 * effort/thinking、附件。
 *
 * 全部 SDKMessage 原样经 `agent:stream` 推给渲染层,流式状态机在渲染层(DESIGN §7)。
 * 审批走单独一对通道:`agent:permission.request`(主 → 渲)/ `agent:permission.respond`。
 */

const MAX_TURNS_KEY = 'agent.maxTurns';
const MAX_BUDGET_KEY = 'agent.maxBudgetUsd';
/** 上次会话的本地 conversation id,用于重启后续接 */
const LAST_CONV_KEY = 'agent.lastConversationId';
/** 用户选定的模型;缺省 = SDK 默认 */
const MODEL_KEY = 'agent.model';
const EFFORT_KEY = 'agent.effort';
const THINKING_KEY = 'agent.thinking';

type ThinkingMode = 'off' | 'hidden' | 'shown';

export function registerAgentIpc(store: GtdStore, clock: Clock): void {
  // 启动即同步内置 skill:否则用户没聊过天就点开 Skills 会看到空列表(此前只在会话
  // 启动时写)。幂等,且用户改过的不会被覆盖。
  syncBuiltinSkills(settingsStore());

  const broadcast = (channel: string, payload: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  };

  /** 用户偏好(CLAUDE.md)—— 在应用里改,不必开外部编辑器 */
  ipcMain.handle('agent:memory.read', () => ({
    path: ensureUserMemory().path,
    body: readUserMemory(),
  }));
  ipcMain.handle('agent:memory.write', (_e, p: { body: string }) => {
    writeUserMemory(p.body);
    return {};
  });

  /** Skills:内置 5 个 + 用户自建;内置被改过就不再被覆盖 */
  ipcMain.handle('agent:skills.list', () => listSkills(settingsStore()));
  /** 工具手册:用户写自己的 skill 时要知道有哪些工具、参数叫什么 */
  ipcMain.handle('agent:tools.manual', () => toolManual());
  ipcMain.handle('agent:skills.read', (_e, p: { name: string }) => ({ body: readSkill(p.name) }));
  ipcMain.handle('agent:skills.write', (_e, p: { name: string; body: string }) =>
    writeSkill(p.name, p.body),
  );
  ipcMain.handle('agent:skills.delete', (_e, p: { name: string }) => deleteSkill(p.name));
  ipcMain.handle('agent:skills.reset', (_e, p: { name: string }) =>
    resetSkill(p.name, settingsStore()),
  );

  /** 模型:列表与切换(仅活会话可用 —— setModel 是 streaming-input 专属) */
  ipcMain.handle('agent:models', () => supportedModels());
  ipcMain.handle('agent:model.set', async (_e, p: { model: string }) => {
    settingsStore().set(MODEL_KEY, p.model);
    return setModel(p.model);
  });
  ipcMain.handle('agent:effort.set', async (_e, p: { effort: EffortLevel }) => {
    settingsStore().set(EFFORT_KEY, p.effort);
    return setEffort(p.effort);
  });
  ipcMain.handle('agent:thinking.set', async (_e, p: { mode: ThinkingMode }) => {
    settingsStore().set(THINKING_KEY, p.mode);
    return setThinking(p.mode);
  });

  // ------------------------------------------------------------ 权限

  ipcMain.handle('agent:permission.modes', () => ({
    modes: PERMISSION_MODES.filter((m) => isModeAvailable(m, app.isPackaged)).map((m) => ({
      id: m,
      ...PERMISSION_MODE_LABELS[m],
    })),
    current: readMode(settingsStore()),
    alwaysAllow: readAlwaysAllow(settingsStore()),
  }));
  ipcMain.handle('agent:permission.setMode', async (_e, p: { mode: PermissionModeId }) => {
    if (!PERMISSION_MODES.includes(p.mode)) return { error: '未知权限模式' };
    if (!isModeAvailable(p.mode, app.isPackaged)) return { error: '该模式在打包版中不可用' };
    settingsStore().set(PERMISSION_MODE_KEY, p.mode);
    // 只读 ↔ 可写会改变工具面本身,必须重起会话才生效;其余模式即时生效
    await setPermissionMode(p.mode);
    return { needsRestart: sessionAlive() };
  });
  ipcMain.handle('agent:permission.respond', (_e, p: { id: string } & PermissionResponse) => {
    const { id, ...rest } = p;
    respondPermission(id, rest as PermissionResponse);
    return {};
  });
  ipcMain.handle('agent:permission.clearAlwaysAllow', () => {
    settingsStore().set(ALWAYS_ALLOW_KEY, []);
    return {};
  });

  // ------------------------------------------------------------ 审计

  ipcMain.handle('agent:audit.list', (_e, p: { conversationId?: string | null }) =>
    agentStore().listAudit(p.conversationId ?? null, 300),
  );

  // ------------------------------------------------------------ 会话

  ipcMain.handle('agent:conversations.list', () =>
    listConversations(currentConversationId() ?? settingsStore().get<string>(LAST_CONV_KEY)),
  );
  ipcMain.handle('agent:conversations.transcript', async (_e, p: { id: string }) => {
    const row = agentStore().getConversation(p.id);
    if (!row || row.sdkSessionId === null) return { items: [] };
    return { items: await transcript(row.sdkSessionId) };
  });
  ipcMain.handle('agent:conversations.delete', async (_e, p: { id: string }) => {
    if (currentConversationId() === p.id) destroySession();
    const r = await removeConversation(p.id);
    if (settingsStore().get<string>(LAST_CONV_KEY) === p.id) {
      settingsStore().set(LAST_CONV_KEY, null);
    }
    return r;
  });
  ipcMain.handle('agent:usage.totals', () => agentStore().totals());

  // ------------------------------------------------------------ 附件

  /**
   * 拖入/选中的文件复制进 userData/attachments/<uuid>/,返回绝对路径。
   * **不授权文件原来的目录** —— 那等于把 agent 放进用户的下载目录乃至整个家目录。
   */
  ipcMain.handle('agent:attachments.add', (_e, p: { paths: string[] }) => {
    const out: { path: string; name: string }[] = [];
    for (const src of p.paths) {
      try {
        const dir = join(attachmentsDir(), crypto.randomUUID());
        mkdirSync(dir, { recursive: true });
        const dest = join(dir, basename(src));
        copyFileSync(src, dest);
        out.push({ path: dest, name: basename(src) });
      } catch (e) {
        process.stderr.write(`[attachments] 复制失败 ${src}: ${String(e)}\n`);
      }
    }
    return { files: out };
  });
  ipcMain.handle('agent:attachments.pick', async () => {
    const win = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    const r = await (win
      ? dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
      : dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] }));
    return { paths: r.canceled ? [] : r.filePaths };
  });

  // ------------------------------------------------------------ 状态与会话生命周期

  ipcMain.handle('agent:status', () => {
    const s = settingsStore();
    const convId = currentConversationId() ?? s.get<string>(LAST_CONV_KEY);
    const conv = convId !== null ? agentStore().getConversation(convId) : null;
    return {
      ...authStatus(),
      memoryPath: ensureUserMemory().path,
      alive: sessionAlive(),
      maxTurns: s.get<number>(MAX_TURNS_KEY) ?? 40,
      maxBudgetUsd: s.get<number>(MAX_BUDGET_KEY) ?? 5,
      lastConversationId: s.get<string>(LAST_CONV_KEY),
      conversationId: convId,
      model: s.get<string>(MODEL_KEY),
      effort: s.get<EffortLevel>(EFFORT_KEY),
      thinking: s.get<ThinkingMode>(THINKING_KEY) ?? 'hidden',
      permissionMode: readMode(s),
      alwaysAllow: readAlwaysAllow(s),
      // 用量:本会话取会话行,总账取全表 —— 渲染层重挂载不会把账清零
      usage: {
        costUsd: conv?.totalCostUsd ?? 0,
        inputTokens: conv?.totalInputTokens ?? 0,
        outputTokens: conv?.totalOutputTokens ?? 0,
      },
      totals: agentStore().totals(),
    };
  });

  ipcMain.handle(
    'agent:session.start',
    (_e, p: { resume?: boolean; conversationId?: string; fork?: boolean }) => {
      const s = settingsStore();
      const mode = readMode(s);
      const model = s.get<string>(MODEL_KEY);

      // 要续接哪条?显式指定 > 上次那条 > 新建
      let convId = p.conversationId ?? null;
      if (convId === null && p.resume === true) convId = s.get<string>(LAST_CONV_KEY);
      const existing = convId !== null ? agentStore().getConversation(convId) : null;
      const resumeSdkId = existing?.sdkSessionId ?? null;

      // fork:原会话保持不动,新建一条本地行,SDK 侧用 resume + forkSession
      const conversationId =
        p.fork === true || existing === null
          ? createConversation(
              model ?? 'default',
              p.fork === true ? (convId ?? undefined) : undefined,
            )
          : existing.id;
      s.set(LAST_CONV_KEY, conversationId);

      // plan 模式**根本不注册写工具**:纵深防御 —— 即使审批逻辑写错了,工具也不存在
      const writeDeps =
        mode === 'plan'
          ? undefined
          : {
              store,
              deps: { clock, idGen: { next: (): string => crypto.randomUUID() } },
              onChanged: (): void => broadcastChanged('agent'),
            };

      startSession(
        {
          deps: { store, clock },
          ...(writeDeps !== undefined ? { write: writeDeps } : {}),
          settings: s,
          conversationId,
          permissionMode: mode,
          canUseTool: buildCanUseTool({
            store,
            settings: s,
            conversationId: () => currentConversationId() ?? conversationId,
          }),
          maxTurns: s.get<number>(MAX_TURNS_KEY) ?? 40,
          maxBudgetUsd: s.get<number>(MAX_BUDGET_KEY) ?? 5,
          ...(model !== null ? { model } : {}),
          ...(s.get<EffortLevel>(EFFORT_KEY) !== null
            ? { effort: s.get<EffortLevel>(EFFORT_KEY)! }
            : {}),
          ...(resumeSdkId !== null ? { resume: resumeSdkId } : {}),
          ...(p.fork === true && resumeSdkId !== null ? { forkSession: true } : {}),
        },
        (ev) => {
          if (ev.type === 'message') recordSdkMessage(conversationId, ev.payload);
          broadcast('agent:stream', ev);
        },
      );
      return { started: true, conversationId };
    },
  );

  ipcMain.handle(
    'agent:send',
    (_e, p: { text: string; images?: AgentImage[]; attachments?: string[] }) => {
      const convId = currentConversationId();
      if (convId !== null) titleFromFirstMessage(convId, p.text);
      return send(p.text, p.images ?? [], p.attachments ?? []);
    },
  );

  ipcMain.handle('agent:interrupt', async () => {
    await interruptTurn();
    return {};
  });

  ipcMain.handle('agent:session.destroy', () => {
    destroySession();
    return {};
  });

  /** 新开会话:忘掉上次那条,下次 start 就是全新的 */
  ipcMain.handle('agent:session.new', () => {
    destroySession();
    settingsStore().set(LAST_CONV_KEY, null);
    return {};
  });
}
