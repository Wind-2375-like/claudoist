import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations/index';

/**
 * `PRAGMA user_version` 迁移器:幂等,只前进(docs/DESIGN.md §2.2)。
 * 多进程安全(CLI 与 App 同库并发,§6.7):每个迁移用 BEGIN IMMEDIATE 先取写锁,
 * 并在事务内**重读**版本 —— 竞态落败方发现版本已前进则跳过,而不是重放 SQL 崩溃。
 */
export function migrate(db: DatabaseSync): void {
  const version = (): number =>
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (const m of MIGRATIONS) {
    if (m.version <= version()) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (m.version <= version()) {
        // 另一进程在我们等锁期间已完成此迁移
        db.exec('COMMIT');
        continue;
      }
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function schemaVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}
