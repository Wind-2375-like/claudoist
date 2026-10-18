import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db';
import { MIGRATIONS } from '../src/migrations/index';

/**
 * 迁移 v22(2026-10-18 用户要求模型列表与 VSCode 插件一致、Opus 用 5.5):
 * SDK 0.3.301 的目录改用不带 [1m] 的别名,`opus[1m]` → `opus`(Opus 5.5)、
 * `claude-fable-5-1[1m]` → `fable`(仍是 5.1)。只改 `agent.model` 这一个键。
 */
describe('迁移 v21 → v22(agent.model:对齐 Claude Code 2.1.301 的模型目录)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtd-mig22-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const setup = (saved: string, fromVersion = 21): string => {
    const path = join(dir, `v${fromVersion}-${saved.replace(/[^a-z0-9]/gi, '_')}.sqlite3`);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = WAL');
    for (const m of MIGRATIONS.slice(0, fromVersion)) raw.exec(m.sql);
    raw.exec(`PRAGMA user_version = ${fromVersion}`);
    raw
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
      .run('agent.model', JSON.stringify(saved));
    // 对照:别的键哪怕值长得一样也不许被碰
    raw
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
      .run('agent.effort', JSON.stringify('opus[1m]'));
    raw.close();
    return path;
  };
  const read = (db: DatabaseSync, key: string): unknown =>
    JSON.parse(
      (
        db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as {
          value_json: string;
        }
      ).value_json,
    );

  it('opus[1m] → opus;user_version 到位', () => {
    const db = openDb(setup('opus[1m]'));
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      MIGRATIONS.length,
    );
    expect(read(db, 'agent.model')).toBe('opus');
    expect(read(db, 'agent.effort')).toBe('opus[1m]');
    db.close();
  });

  it('Fable 5.1(带不带 [1m])→ fable', () => {
    for (const m of ['claude-fable-5-1[1m]', 'claude-fable-5-1']) {
      const db = openDb(setup(m));
      expect(read(db, 'agent.model')).toBe('fable');
      db.close();
    }
  });

  it('从 v20 的 claude-fable-5[1m] 一路升上来,落在 fable', () => {
    const db = openDb(setup('claude-fable-5[1m]', 20));
    expect(read(db, 'agent.model')).toBe('fable');
    db.close();
  });

  it('新目录里本来就有的值原样不动', () => {
    for (const m of ['default', 'sonnet', 'haiku', 'opus', 'fable', 'claude-opus-5']) {
      const db = openDb(setup(m));
      expect(read(db, 'agent.model')).toBe(m);
      db.close();
    }
  });
});
