import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSettingsStore,
  openDb,
  SqliteGtdStore,
  type SettingsStore,
} from '@gtd/storage-sqlite';

let settings: SettingsStore | null = null;

/** 在 userData/data 开库并迁移(dev 后缀已在 index.ts 顶部生效)。 */
export function initStore(): SqliteGtdStore {
  const dir = join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  const db = openDb(join(dir, 'gtd.sqlite3'));
  settings = createSettingsStore(db);
  return new SqliteGtdStore(db);
}

/** 应用设置(非领域配置);须在 initStore 之后调用。 */
export function settingsStore(): SettingsStore {
  if (settings === null) throw new Error('settingsStore() 须在 initStore() 之后调用');
  return settings;
}
