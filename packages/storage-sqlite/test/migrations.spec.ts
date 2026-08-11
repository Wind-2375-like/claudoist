import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/migrations/index';
import { migrate, schemaVersion } from '../src/migrate';
import { openDb } from '../src/db';

// D-30:contexts 已并入 labels,迁移 v11 删表
const EXPECTED_TABLES = [
  'inbox_items',
  'projects',
  'tasks',
  'waiting_for',
  'list_items',
  'labels',
  'task_labels',
  'filters',
  'reminders',
  'conversations',
  'agent_audit',
  'settings',
];

describe('迁移:user_version 迁移器', () => {
  it('空库完整迁移:全部表存在,版本推进到最新', () => {
    const db = openDb(':memory:');
    expect(schemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of EXPECTED_TABLES) expect(tables).toContain(t);
  });

  it('重复迁移幂等', () => {
    const db = openDb(':memory:');
    const v = schemaVersion(db);
    migrate(db);
    migrate(db);
    expect(schemaVersion(db)).toBe(v);
  });

  it('迁移版本号严格递增且不重复', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...new Set(versions)].sort((a, b) => a - b));
  });

  it('外键约束开启', () => {
    const db = openDb(':memory:');
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
    // FK 生效:引用不存在 context 的 task 必须被拒
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (id,title,context_id,estimated_minutes,energy,priority,status,created_at) VALUES ('t','x','ghost',15,'medium',3,'active','2026-08-08')",
        )
        .run(),
    ).toThrow();
  });
});
