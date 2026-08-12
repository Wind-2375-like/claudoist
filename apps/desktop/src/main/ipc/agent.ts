import { BrowserWindow, ipcMain } from 'electron';
import type { Clock, GtdStore } from '@gtd/domain';
import { authStatus } from '../agent/auth';
import { ensureUserMemory, openUserMemory } from '../agent/userMemory';
import { settingsStore } from '../db';
import {
  destroySession,
  interruptTurn,
  sdkSessionId,
  send,
  sessionAlive,
  startSession,
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

export function registerAgentIpc(store: GtdStore, clock: Clock): void {
  const broadcast = (channel: string, payload: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  };

  ipcMain.handle('agent:memory.open', async () => {
    await openUserMemory();
    return {};
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
    };
  });

  ipcMain.handle('agent:session.start', (_e, p: { resume?: boolean }) => {
    const s = settingsStore();
    const last = s.get<string>(LAST_SESSION_KEY);
    startSession(
      {
        deps: { store, clock },
        ...(p.resume === true && last !== null ? { resume: last } : {}),
        maxTurns: s.get<number>(MAX_TURNS_KEY) ?? 40,
        maxBudgetUsd: s.get<number>(MAX_BUDGET_KEY) ?? 5,
      },
      (ev) => {
        // session_id 一到手就落 settings —— 重启后才接得上
        const id = sdkSessionId();
        if (id !== null && s.get<string>(LAST_SESSION_KEY) !== id) s.set(LAST_SESSION_KEY, id);
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
    return {};
  });
}
