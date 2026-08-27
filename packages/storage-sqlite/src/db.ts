import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate';

/**
 * 打开数据库并迁移到最新版本。文件库启用 WAL;所有连接强制外键约束。
 * main 进程持有唯一连接(单写者,docs/DESIGN.md §4.2)。
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    // CLI(§6.7)与 App 同库并发:写锁冲突时等待而非立即 SQLITE_BUSY
    db.exec('PRAGMA busy_timeout = 2000');
  }
  // 迁移在外键约束关闭下进行 —— 表重建类迁移(v4)必须如此;完成后再开启。
  // 注意 node:sqlite 的 DatabaseSync 默认开启 FK(与裸 SQLite 相反),必须显式 OFF。
  db.exec('PRAGMA foreign_keys = OFF');
  migrate(db);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
