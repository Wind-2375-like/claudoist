import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Clock, GtdStore, RewindStore } from '@gtd/domain';
import type { AccountUsageVM, GuardrailsVM } from '../../shared/viewModels';
import { toolManual } from '@gtd/agent-tools';
import type { WriteToolDeps } from '@gtd/agent-tools';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import { authStatus, localSnapshot } from '../agent/auth';
import { invalidateSnapshot, readModels, readSnapshot } from '../agent/probe';
import {
  readAccount,
  readCachedUsage,
  readContribution,
  readSubscriptionUsage,
} from '../agent/usageModel';
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
import { agentStore, rawDb, settingsStore } from '../db';
import { chainFrom, executeRewind, previewRewind } from '../agent/rewind';
import type { RewindAnchor } from '../agent/rewind';
import {
  attachmentsDir,
  currentConversationId,
  destroySession,
  interruptTurn,
  send,
  sessionAlive,
  sessionBusy,
  setEffort,
  setModel,
  setPermissionMode,
  setThinking,
  startSession,
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
const DEFAULT_MAX_TURNS = 40;
/** ⚠ 绝不能是 0:判定是「累计成本 >= 上限」,0 会让会话一开口就熄火 */
const DEFAULT_MAX_BUDGET = 5;
/** 上次会话的本地 conversation id,用于重启后续接 */
const LAST_CONV_KEY = 'agent.lastConversationId';
/** 用户选定的模型;缺省 = SDK 默认 */
const MODEL_KEY = 'agent.model';
const EFFORT_KEY = 'agent.effort';
const THINKING_KEY = 'agent.thinking';

type ThinkingMode = 'off' | 'hidden' | 'shown';

/**
 * 当前回合(INV-35)。`agent:send` 时置位,写工具靠它决定要不要记逆命令日志。
 * **只有聊天 agent 的写入经过这里** —— Google 同步走 ipc/google.ts,拿不到这个上下文,
 * 因此天然不会被卷进回滚。
 */
let currentTurn: { conversationId: string; turnId: string; anchorUuid: string | null } | null =
  null;

/** 排队消息的回合上下文:上一轮 result 到达时按序接棒(见 agent:send 与事件转发) */
const pendingTurnCtx: { conversationId: string; turnId: string; anchorUuid: string | null }[] = [];

/**
 * 读护栏值。**`null` 表示"不限",要翻译成"不传这个选项"** ——
 * 不能翻成 0:`maxBudgetUsd: 0` 会让会话一开口就熄火,`maxTurns: 0` 则被 SDK 当 falsy 丢掉
 * (行为等价但语义含糊)。所以这里返回 null 时,调用方**整个键都不放进 options**。
 */
function readGuardrail(
  s: { get<T>(k: string): T | null; has(k: string): boolean },
  key: string,
  fallback: number,
): number | null {
  // ⚠ 必须用 has() 区分「没设过」与「显式设成 null(不限)」——
  // `get(k) ?? fallback` 会把两者混为一谈,用户选的"不限"每次都被打回默认值
  if (!s.has(key)) return fallback;
  return s.get<number | null>(key);
}

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

  /**
   * 模型列表 —— **不需要活会话**。有会话就蹭,没有就起一个零 token 探针
   * (见 agent/probe.ts)。此前这里要求 `live` 存在,于是界面上写着
   * "先发一条消息,再回来切换模型" —— 那个限制是我们自己加的,SDK 侧不存在。
   */
  ipcMain.handle('agent:models', async () => {
    try {
      return await readModels();
    } catch (e) {
      process.stderr.write(`[agent] 读模型列表失败: ${String(e)}\n`);
      return [];
    }
  });

  /**
   * 切模型 = **双写**:先落盘(保证下次起会话用它),再热切(保证当前会话立刻变)。
   * 只做一半都会出 bug:只热切 → 重开会话变回去;只落盘 → 当前会话没变。
   * 热切失败**不回滚落盘部分** —— 用户的选择已经表达了,下次生效比丢掉好。
   */
  ipcMain.handle('agent:model.set', async (_e, p: { model: string }) => {
    settingsStore().set(MODEL_KEY, p.model);
    const r = await setModel(p.model);
    // 换模型会改变 effort 档位的可用性,缓存里的 models 需要重取
    invalidateSnapshot();
    return r;
  });
  ipcMain.handle('agent:effort.set', async (_e, p: { effort: EffortLevel }) => {
    settingsStore().set(EFFORT_KEY, p.effort);
    return setEffort(p.effort);
  });
  ipcMain.handle('agent:thinking.set', async (_e, p: { mode: ThinkingMode }) => {
    settingsStore().set(THINKING_KEY, p.mode);
    return setThinking(p.mode);
  });

  // ------------------------------------------------------------ 护栏

  const guardrails = (): GuardrailsVM => {
    const s = settingsStore();
    return {
      maxTurns: readGuardrail(s, MAX_TURNS_KEY, DEFAULT_MAX_TURNS),
      maxBudgetUsd: readGuardrail(s, MAX_BUDGET_KEY, DEFAULT_MAX_BUDGET),
      sessionAlive: sessionAlive(),
      sessionBusy: sessionBusy(),
    };
  };
  ipcMain.handle('agent:guardrails.get', () => guardrails());

  /**
   * 护栏只能在起会话时生效(maxTurns / maxBudgetUsd 是 spawn 期的 CLI flag,
   * 控制通道里没有对应方法)。⚠ `applyFlagSettings({maxTurns})` **会返回成功但什么都不做**
   * —— 那是个静默陷阱,别用。
   *
   * 主进程必须再校验一次:渲染层的控件约束绕得过去,而 `maxBudgetUsd: 0` 会让
   * 会话一开口就 `error_max_budget_usd`(判定是 `累计成本 >= 上限`),等于把会话砖了。
   */
  ipcMain.handle(
    'agent:guardrails.set',
    (_e, p: { maxTurns: number | null; maxBudgetUsd: number | null }) => {
      const t = p.maxTurns;
      if (t !== null && (!Number.isInteger(t) || t < 1 || t > 500)) {
        return { error: '工具往返上限须为 1–500 的整数,或留空表示不限' };
      }
      const b = p.maxBudgetUsd;
      if (b !== null && (!Number.isFinite(b) || b < 0.5 || b > 1000)) {
        return { error: '工作量刹车须为 0.5–1000,或留空表示不限' };
      }
      settingsStore().set(MAX_TURNS_KEY, t);
      settingsStore().set(MAX_BUDGET_KEY, b);
      return { ok: true, ...guardrails() };
    },
  );

  // ------------------------------------------------------------ 账号与用量

  /**
   * 三层取数:活会话(最快)→ 零 token 探针 → 本机缓存。
   * 每层各自 try/catch,**任何一层失败都不能让整页崩**。
   */
  ipcMain.handle(
    'agent:usage.snapshot',
    async (_e, p?: { force?: boolean }): Promise<AccountUsageVM> => {
      const s = settingsStore();
      const convId = currentConversationId() ?? s.get<string>(LAST_CONV_KEY);
      const conv = convId !== null ? agentStore().getConversation(convId) : null;
      const appLedger = {
        session: {
          costUsd: conv?.totalCostUsd ?? 0,
          inputTokens: conv?.totalInputTokens ?? 0,
          outputTokens: conv?.totalOutputTokens ?? 0,
        },
        totals: agentStore().totals(),
      };
      const apiKeyInEnv = typeof process.env['ANTHROPIC_API_KEY'] === 'string';

      try {
        const raw = await readSnapshot(p?.force === true);
        return {
          freshness: { source: raw.source, fetchedAtMs: Date.now(), cacheAgeMs: null },
          account: readAccount(raw.account, apiKeyInEnv),
          usage: readSubscriptionUsage(raw.usage),
          contribution: readContribution(raw.usage),
          appLedger,
          error: null,
        };
      } catch (e) {
        // 起不了子进程 / 断网 —— 退到本机缓存,至少把账号和上次的额度显示出来
        const local = localSnapshot();
        if (local === null) {
          return {
            freshness: { source: 'none', fetchedAtMs: null, cacheAgeMs: null },
            account: readAccount(null, apiKeyInEnv),
            usage: { available: false, unavailableReason: null, windows: [], extraUsage: null },
            contribution: null,
            appLedger,
            error: e instanceof Error ? e.message : String(e),
          };
        }
        return {
          freshness: {
            source: 'local-cache',
            fetchedAtMs: local.fetchedAtMs,
            cacheAgeMs: local.fetchedAtMs === null ? null : Date.now() - local.fetchedAtMs,
          },
          account: {
            method: local.email !== null ? 'claude-ai' : 'logged-out',
            methodLabel: local.email !== null ? 'Claude 账号' : '未登录',
            email: local.email,
            organization: local.organization,
            planLabel: local.plan,
            apiKeyInEnv,
          },
          usage: readCachedUsage(local.utilization),
          // behaviors 只在进程内扫本地 transcript 得到,缓存里没有
          contribution: null,
          appLedger,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  );

  ipcMain.handle('agent:usage.openBilling', async () => {
    await shell.openExternal('https://claude.ai/settings/usage');
    return {};
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
      busy: sessionBusy(),
      maxTurns: readGuardrail(s, MAX_TURNS_KEY, DEFAULT_MAX_TURNS),
      maxBudgetUsd: readGuardrail(s, MAX_BUDGET_KEY, DEFAULT_MAX_BUDGET),
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

  const startHandler = (
    _e: unknown,
    p: { resume?: boolean; conversationId?: string; fork?: boolean },
  ): { started: boolean; conversationId: string } => {
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
    // ⚠ 这里的**显式类型标注是必要的**,不是啰嗦:下面用的
    // `...(writeDeps !== undefined ? { write: writeDeps } : {})` 条件展开会让 TS
    // **不再检查缺字段**。`rewindContext` 当初就是这么漏掉的 —— 编译通过、agent 照常写数据、
    // 回滚日志一行不记,功能整个是死的却没有任何报错。
    const writeDeps: WriteToolDeps | undefined =
      mode === 'plan'
        ? undefined
        : {
            store,
            deps: { clock, idGen: { next: (): string => crypto.randomUUID() } },
            onChanged: (): void => broadcastChanged('agent'),
            // 只有聊天 agent 的写入记逆命令日志(INV-35);Google 同步走 ipc/google.ts,
            // 拿不到这个上下文,天然不会被卷进回滚
            rewindContext: () =>
              currentTurn === null ? null : { ...currentTurn, toolUseId: null },
          };

    pendingTurnCtx.length = 0; // 新会话:旧的排队回合作废
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
        ...(readGuardrail(s, MAX_TURNS_KEY, DEFAULT_MAX_TURNS) !== null
          ? { maxTurns: readGuardrail(s, MAX_TURNS_KEY, DEFAULT_MAX_TURNS)! }
          : {}),
        ...(readGuardrail(s, MAX_BUDGET_KEY, DEFAULT_MAX_BUDGET) !== null
          ? { maxBudgetUsd: readGuardrail(s, MAX_BUDGET_KEY, DEFAULT_MAX_BUDGET)! }
          : {}),
        ...(model !== null ? { model } : {}),
        ...(s.get<EffortLevel>(EFFORT_KEY) !== null
          ? { effort: s.get<EffortLevel>(EFFORT_KEY)! }
          : {}),
        ...(resumeSdkId !== null ? { resume: resumeSdkId } : {}),
        ...(p.fork === true && resumeSdkId !== null ? { forkSession: true } : {}),
      },
      (ev) => {
        if (ev.type === 'message') {
          recordSdkMessage(conversationId, ev.payload);
          // 一轮结束 → 排队的下一轮接棒回合上下文(与 sessionManager.pendingTurns 同步)
          if ((ev.payload as { type?: string }).type === 'result' && pendingTurnCtx.length > 0) {
            currentTurn = pendingTurnCtx.shift()!;
          }
        }
        broadcast('agent:stream', ev);
      },
    );
    return { started: true, conversationId };
  };

  ipcMain.handle('agent:session.start', startHandler);

  /**
   * 重起当前会话并**保留上下文**(resume 同一条 sdk session)。
   * 护栏改动只能靠这个生效 —— 它们是 spawn 期的 CLI flag。
   *
   * 刻意**不自动**触发:设置页是个模态弹层,用户可能只是随手拖了一下滑杆,
   * 静默销毁会话是不可逆的;而且正在回复时重起会把那一轮丢掉、用户看不到任何解释。
   */
  ipcMain.handle('agent:session.restart', (e) => {
    if (sessionBusy()) return { error: '正在回复中,等这一轮结束再重起' };
    const convId = currentConversationId() ?? settingsStore().get<string>(LAST_CONV_KEY);
    destroySession();
    return startHandler(e, convId !== null ? { conversationId: convId } : {});
  });

  ipcMain.handle(
    'agent:send',
    (_e, p: { text: string; images?: AgentImage[]; attachments?: string[] }) => {
      const convId = currentConversationId();
      if (convId !== null) titleFromFirstMessage(convId, p.text);
      const r = send(p.text, p.images ?? [], p.attachments ?? []);
      // 每条用户消息开一个新回合。turnId 本地生成(不依赖 SDK 的任何未公开行为),
      // anchorUuid 是我们自己塞给 SDK 的那个 uuid —— 它同时是 forkSession 的 upToMessageId。
      // **排队消息不能立刻顶掉 currentTurn**:上一轮还在跑,写工具的逆命令日志会被
      // 记到错误的回合上(INV-35)。排进 pendingTurnCtx,等上一轮 result 到达再接棒。
      let turnId: string | undefined;
      if (convId !== null && r.error === undefined) {
        const ctx = {
          conversationId: convId,
          turnId: crypto.randomUUID(),
          anchorUuid: r.messageUuid ?? null,
        };
        turnId = ctx.turnId;
        if (r.queued === true) pendingTurnCtx.push(ctx);
        else currentTurn = ctx;
      }
      return { ...r, turnId, queued: r.queued === true };
    },
  );

  // ------------------------------------------------------------ 回滚(INV-35)

  ipcMain.handle('agent:rewind.preview', (_e, a: RewindAnchor) => {
    const rows = chainFrom(rawDb(), a);
    if (rows.length === 0)
      return { entryCount: 0, tools: [], hardDeleteCount: 0, conflicts: [], foreignEntryCount: 0 };
    return previewRewind(store.snapshot(), rows, a.conversationId);
  });

  ipcMain.handle('agent:rewind.apply', (_e, a: RewindAnchor) => {
    if (sessionBusy()) return { error: '正在回复中,等这一轮结束再回滚' };
    const rows = chainFrom(rawDb(), a);
    if (rows.length === 0) return { error: '这一轮之后没有可撤销的改动' };
    try {
      const r = executeRewind(
        rawDb(),
        store as unknown as RewindStore,
        rows,
        new Date().toISOString(),
        join(app.getPath('userData'), 'rewind-backups'),
      );
      broadcastChanged('user');
      return { ok: true, entryCount: rows.length, backupPath: r.backupPath };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 从某条消息分叉:forkSession 是纯文件操作,零 token */
  ipcMain.handle(
    'agent:conversations.forkAt',
    async (e, p: { conversationId: string; messageUuid: string }) => {
      const row = agentStore().getConversation(p.conversationId);
      if (!row || row.sdkSessionId === null) return { error: '这条会话还没有可分叉的记录' };
      try {
        const { sessionId } = await forkSession(row.sdkSessionId, {
          dir: app.getPath('userData'),
          upToMessageId: p.messageUuid,
        });
        const newId = createConversation(row.model, p.conversationId);
        agentStore().setSdkSessionId(newId, sessionId);
        destroySession();
        settingsStore().set(LAST_CONV_KEY, newId);
        startHandler(e, { conversationId: newId });
        return { ok: true, conversationId: newId };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
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
