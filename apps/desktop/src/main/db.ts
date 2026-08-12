import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentStore,
  createSettingsStore,
  openDb,
  SqliteGtdStore,
  type AgentStore,
  type SettingsStore,
} from '@gtd/storage-sqlite';

let settings: SettingsStore | null = null;
let agent: AgentStore | null = null;

/** 在 userData/data 开库并迁移(dev 后缀已在 index.ts 顶部生效)。 */
export function initStore(): SqliteGtdStore {
  const dir = join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  const db = openDb(join(dir, 'gtd.sqlite3'));
  settings = createSettingsStore(db);
  agent = createAgentStore(db);
  return new SqliteGtdStore(db);
}

/** 应用设置(非领域配置);须在 initStore 之后调用。 */
export function settingsStore(): SettingsStore {
  if (settings === null) throw new Error('settingsStore() 须在 initStore() 之后调用');
  return settings;
}

/** 会话索引 + 工具审计(M9/M10);须在 initStore 之后调用。 */
export function agentStore(): AgentStore {
  if (agent === null) throw new Error('agentStore() 须在 initStore() 之后调用');
  return agent;
}
