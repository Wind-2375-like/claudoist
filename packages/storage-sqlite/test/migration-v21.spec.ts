import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/migrations/index';

/**
 * 迁移 v21(2026-09-11 用户要求「更新 fable 5 到 5.1」):保存的模型选择
 * claude-fable-5 → claude-fable-5-1。SDK 0.3.269 的模型目录把 Fable 5 移出了,
 * 旧值虽然后端仍接受,但设置面板里再也找不到它那一行。只改 `agent.model` 这一个键。
 */
describe('迁移 v20 → v21(agent.model:Fable 5 → 5.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtd-mig21-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const setup = (saved: string): string => {
    const path = join(dir, `v20-${saved.replace(/[^a-z0-9]/gi, '_')}.sqlite3`);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = WAL');
    for (const m of MIGRATIONS.slice(0, 20)) raw.exec(m.sql);
    raw.exec('PRAGMA user_version = 20');
    raw
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
      .run('agent.model', JSON.stringify(saved));
    // 对照:别的键、以及对话表里记录的历史模型,都不许被碰
    raw
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
      .run('agent.effort', JSON.stringify('claude-fable-5[1m]'));
    raw.close();
    return path;
  };
  // 只跑 v21 本身:openDb 会接着跑 v22(把 5.1 再改写成别名 fable),那归 migration-v22.spec 管
  const upToV21 = (path: string): DatabaseSync => {
    const db = new DatabaseSync(path);
    db.exec(MIGRATIONS[20]!.sql);
    return db;
  };
  const read = (db: DatabaseSync, key: string): unknown =>
    JSON.parse(
      (
        db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as {
          value_json: string;
        }
      ).value_json,
    );

  it('claude-fable-5[1m] → claude-fable-5-1[1m]', () => {
    const db = upToV21(setup('claude-fable-5[1m]'));
    expect(read(db, 'agent.model')).toBe('claude-fable-5-1[1m]');
    // 别的键哪怕值长得一样也不动
    expect(read(db, 'agent.effort')).toBe('claude-fable-5[1m]');
    db.close();
  });

  it('不带 [1m] 的裸 id 同样改写', () => {
    const db = upToV21(setup('claude-fable-5'));
    expect(read(db, 'agent.model')).toBe('claude-fable-5-1');
    db.close();
  });

  it('别的模型(opus / default / 已是 5.1)原样不动', () => {
    for (const m of ['opus[1m]', 'default', 'claude-fable-5-1[1m]']) {
      const db = upToV21(setup(m));
      expect(read(db, 'agent.model')).toBe(m);
      db.close();
    }
  });
});
