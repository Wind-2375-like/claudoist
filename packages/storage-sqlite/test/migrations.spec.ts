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

describe('迁移 v18:task-repeat(D-37/INV-36)', () => {
  const insertTask = (
    db: ReturnType<typeof openDb>,
    id: string,
    extra = '',
    extraVals = '',
  ): void => {
    db.prepare(
      `INSERT INTO tasks (id,title,estimated_minutes,energy,priority,status,created_at,bucket,sort_order${extra})
       VALUES ('${id}','x',15,'medium',3,'active','2026-08-13','inbox',0${extraVals})`,
    ).run();
  };

  it('新列存在;存量行 repeat_* 全 NULL = 不循环(无回填,语义正确)', () => {
    const db = openDb(':memory:');
    insertTask(db, 't1');
    const r = db
      .prepare('SELECT repeat_unit, repeat_anchor, series_id FROM tasks WHERE id=?')
      .get('t1') as Record<string, unknown>;
    expect(r['repeat_unit']).toBeNull();
    expect(r['repeat_anchor']).toBeNull();
    expect(r['series_id']).toBeNull();
  });

  it('完整六列 + series_id 写入合法', () => {
    const db = openDb(':memory:');
    insertTask(
      db,
      't2',
      ',repeat_unit,repeat_every,repeat_from,repeat_weekdays,repeat_until,repeat_anchor,series_id',
      ",'week',1,'scheduled',8,'2026-12-31','2026-08-12','s1'",
    );
    expect(db.prepare("SELECT repeat_weekdays w FROM tasks WHERE id='t2'").get()).toEqual({ w: 8 });
  });

  it('跨列 CHECK:六类非法输入全部响亮拒绝(半套规则 = 整批 ROLLBACK,不是静默损坏)', () => {
    const db = openDb(':memory:');
    const bad: [string, string][] = [
      // 半套:有 unit 没 every/from/anchor
      [',repeat_unit', ",'day'"],
      // 有 every 没 unit
      [',repeat_every', ',3'],
      // week 却没掩码
      [',repeat_unit,repeat_every,repeat_from,repeat_anchor', ",'week',1,'scheduled','2026-08-12'"],
      // 非 week 却带掩码
      [
        ',repeat_unit,repeat_every,repeat_from,repeat_weekdays,repeat_anchor',
        ",'day',1,'scheduled',8,'2026-08-12'",
      ],
      // until 悬空(无规则)
      [',repeat_until', ",'2026-12-31'"],
      // 掩码越界
      [
        ',repeat_unit,repeat_every,repeat_from,repeat_weekdays,repeat_anchor',
        ",'week',1,'scheduled',128,'2026-08-12'",
      ],
    ];
    bad.forEach(([cols, vals], i) => {
      expect(
        () => insertTask(db, `bad${String(i)}`, cols, vals),
        `第 ${String(i)} 类该被拒`,
      ).toThrow();
    });
    // UPDATE 路同样生效:把合法行改成半套 → 拒
    insertTask(
      db,
      'ok',
      ',repeat_unit,repeat_every,repeat_from,repeat_anchor',
      ",'day',1,'scheduled','2026-08-12'",
    );
    expect(() => db.prepare("UPDATE tasks SET repeat_every=NULL WHERE id='ok'").run()).toThrow();
  });

  it('部分索引存在', () => {
    const db = openDb(':memory:');
    const idx = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toContain('idx_tasks_repeat');
    expect(idx).toContain('idx_tasks_series');
  });
});
