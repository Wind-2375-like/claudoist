import type { DatabaseSync } from 'node:sqlite';

/**
 * 键值设置存储(M6c-2):用 schema 里既有的 `settings` 表(key / value_json)。
 * 用途是**非领域**的应用配置(如"哪些 Google 日历要显示"、同步游标),因此不进
 * GtdSnapshot、不走 Command —— domain 不该知道这些东西的存在。
 *
 * 注意:凭据/token **不放这里**(DB 会被 CLI 读、会随备份走),它们在主进程用
 * Electron safeStorage 单独加密落盘。
 */
export interface SettingsStore {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export function createSettingsStore(db: DatabaseSync): SettingsStore {
  return {
    get<T>(key: string): T | null {
      const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
        { value_json: string } | undefined;
      if (row === undefined) return null;
      try {
        return JSON.parse(row.value_json) as T;
      } catch {
        // 手改坏了的值不该让应用起不来
        return null;
      }
    },
    set(key: string, value: unknown): void {
      db.prepare(
        'INSERT INTO settings (key, value_json) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      ).run(key, JSON.stringify(value));
    },
    delete(key: string): void {
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    },
  };
}
