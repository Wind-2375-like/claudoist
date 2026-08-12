import { BrowserWindow, ipcMain } from 'electron';
import type { Clock, GtdStore } from '@gtd/domain';
import { toolManual } from '@gtd/agent-tools';
import { authStatus } from '../agent/auth';
import { ensureUserMemory, readUserMemory, writeUserMemory } from '../agent/userMemory';
import {
  deleteSkill,
  listSkills,
  readSkill,
  resetSkill,
  syncBuiltinSkills,
  writeSkill,
} from '../agent/skills';
import { settingsStore } from '../db';
import {
  destroySession,
  interruptTurn,
  sdkSessionId,
  send,
  sessionAlive,
  setModel,
  startSession,
  supportedModels,
} from '../agent/sessionManager';
import type { AgentImage } from '../agent/sessionManager';

/**
 * Agent 通道(M8 只读)。渲染层只能:看状态、起会话、发消息、中断、销毁。
 * 全部 SDKMessage 原样经 `agent:stream` 推过去,流式状态机在渲染层(DESIGN §7)。
 */

const MAX_TURNS_KEY = 'agent.maxTurns';
const MAX_BUDGET_KEY = 'agent.maxBudgetUsd';
/** 上次会话的 SDK session id,用于重启后续接 */
const LAST_SESSION_KEY = 'agent.lastSessionId';
/** 用户选定的模型;缺省 = SDK 默认 */
const MODEL_KEY = 'agent.model';
/** 本会话累计用量(账号与用量面板用) */
let usage = { inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0, turns: 0 };

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
  ipcMain.handle('agent:model.set', (_e, p: { model: string }) => {
    settingsStore().set(MODEL_KEY, p.model);
    return setModel(p.model);
  });

  ipcMain.handle('agent:status', () => {
    const s = settingsStore();
    return {
      ...authStatus(),
      memoryPath: ensureUserMemory().path,
      alive: sessionAlive(),
      maxTurns: s.get<number>(MAX_TURNS_KEY) ?? 40,
      maxBudgetUsd: s.get<number>(MAX_BUDGET_KEY) ?? 5,
      lastSessionId: s.get<string>(LAST_SESSION_KEY),
      model: s.get<string>(MODEL_KEY),
      usage,
    };
  });

  ipcMain.handle('agent:session.start', (_e, p: { resume?: boolean }) => {
    const s = settingsStore();
    const last = s.get<string>(LAST_SESSION_KEY);
    startSession(
      {
        deps: { store, clock },
        settings: s,
        ...(p.resume === true && last !== null ? { resume: last } : {}),
        maxTurns: s.get<number>(MAX_TURNS_KEY) ?? 40,
        maxBudgetUsd: s.get<number>(MAX_BUDGET_KEY) ?? 5,
        ...(s.get<string>(MODEL_KEY) !== null ? { model: s.get<string>(MODEL_KEY)! } : {}),
      },
      (ev) => {
        // session_id 一到手就落 settings —— 重启后才接得上
        const id = sdkSessionId();
        if (id !== null && s.get<string>(LAST_SESSION_KEY) !== id) s.set(LAST_SESSION_KEY, id);
        // 用量累计留在主进程:渲染层重挂载/切视图都不该把账清零
        if (ev.type === 'message') {
          const m = ev.payload as {
            type?: string;
            usage?: Record<string, number>;
            total_cost_usd?: number;
          };
          if (m.type === 'result') {
            const u = m.usage ?? {};
            usage = {
              inputTokens: usage.inputTokens + (u['input_tokens'] ?? 0),
              outputTokens: usage.outputTokens + (u['output_tokens'] ?? 0),
              cacheWrite: usage.cacheWrite + (u['cache_creation_input_tokens'] ?? 0),
              cacheRead: usage.cacheRead + (u['cache_read_input_tokens'] ?? 0),
              costUsd: usage.costUsd + (m.total_cost_usd ?? 0),
              turns: usage.turns + 1,
            };
          }
        }
        broadcast('agent:stream', ev);
      },
    );
    return { started: true };
  });

  ipcMain.handle('agent:send', (_e, p: { text: string; images?: AgentImage[] }) =>
    send(p.text, p.images ?? []),
  );

  ipcMain.handle('agent:interrupt', async () => {
    await interruptTurn();
    return {};
  });

  ipcMain.handle('agent:session.destroy', () => {
    destroySession();
    return {};
  });

  /** 新开会话:忘掉上次的 session id,下次 start 就是全新的 */
  ipcMain.handle('agent:session.new', () => {
    destroySession();
    settingsStore().set(LAST_SESSION_KEY, null);
    usage = { inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0, turns: 0 };
    return {};
  });
}
