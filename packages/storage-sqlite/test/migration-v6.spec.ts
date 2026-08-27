import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db';
import { SqliteGtdStore } from '../src/store';
import { MIGRATIONS } from '../src/migrations/index';

/**
 * 迁移 0006(D-23/M6a 日历统一)升级路径回归:存量 v5 库(calendar_items +
 * 挂日历的 reminders)→ v6:日历项变带时间任务(id 复用)、提醒重挂任务、
 * reminders 重建去 calendar_item_id、calendar_items 表删除。
 */
describe('迁移 v5 → v6(日历统一:calendar_items → 带时间任务)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtd-mig6-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('日历数据搬迁为任务;提醒随迁;表删除;新时间字段可写', () => {
    const path = join(dir, 'v5.sqlite3');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = WAL');
    for (const m of MIGRATIONS.slice(0, 5)) raw.exec(m.sql);
    raw.exec('PRAGMA user_version = 5');
    raw.exec(`INSERT INTO contexts (id, name, sort_order, created_at) VALUES ('c1','@x',0,'T')`);
    raw.exec(`INSERT INTO projects (id, outcome, created_at) VALUES ('p1','发布','T')`);
    // 定时(挂项目)+ 全天 + 已完成 三种日历项;一条挂日历的提醒 + 一条挂任务的提醒
    raw.exec(
      `INSERT INTO calendar_items (id, title, date, time, project_id, done, created_at)
       VALUES ('cal1','组会','2026-08-10','15:00','p1',0,'T1'),
              ('cal2','健身','2026-08-10',NULL,NULL,0,'T2'),
              ('cal3','复诊','2026-08-01','09:00',NULL,1,'T0')`,
    );
    raw.exec(
      `INSERT INTO tasks (id, title, context_id, created_at) VALUES ('t1','普通任务','c1','T')`,
    );
    raw.exec(
      `INSERT INTO reminders (id, task_id, calendar_item_id, remind_at, created_at)
       VALUES ('r1', NULL, 'cal1', '2026-08-10T14:30', 'T'),
              ('r2', 't1', NULL, '2026-08-11T09:00', 'T')`,
    );
    raw.close();

    const db = openDb(path); // 触发 v6
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    expect(version).toBe(MIGRATIONS.length);

    // calendar_items 表已删除
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).not.toContain('calendar_items');

    const store = new SqliteGtdStore(db);
    const snap = store.snapshot();
    // 定时项 → 带时间任务(id 复用,bucket 随 project)
    const meeting = snap.tasks.find((t) => t.id === 'cal1')!;
    expect(meeting.title).toBe('组会');
    expect(meeting.scheduledDate).toBe('2026-08-10');
    expect(meeting.startTime).toBe('15:00');
    expect(meeting.projectId).toBe('p1');
    expect(meeting.bucket).toBe('project');
    expect(meeting.status).toBe('active');
    // 全天项 → startTime null,bucket inbox
    const gym = snap.tasks.find((t) => t.id === 'cal2')!;
    expect(gym.startTime).toBeNull();
    expect(gym.bucket).toBe('inbox');
    // 已完成项 → done + completedAt 回填
    const dentist = snap.tasks.find((t) => t.id === 'cal3')!;
    expect(dentist.status).toBe('done');
    expect(dentist.completedAt).not.toBeNull();
    // 提醒:cal1 的提醒重挂到迁移出的任务;任务提醒不动
    expect(snap.reminders.find((r) => r.id === 'r1')!.taskId).toBe('cal1');
    expect(snap.reminders.find((r) => r.id === 'r2')!.taskId).toBe('t1');
    // 迁移任务的 sortOrder 落在 10000+ 段(不与既有根组撞值),且按 created_at 稳定递增
    expect(dentist.sortOrder).toBe(10000); // T0 最早
    expect(meeting.sortOrder).toBe(10001); // T1
    expect(gym.sortOrder).toBe(10002); // T2

    // 新时间字段可写可读
    store.apply(
      [{ kind: 'updateTask', id: 't1', patch: { startTime: '08:30', durationMinutes: 45 } }],
      'user',
    );
    const t1 = store.snapshot().tasks.find((t) => t.id === 't1')!;
    expect(t1.startTime).toBe('08:30');
    expect(t1.durationMinutes).toBe(45);
    db.close();
  });

  it('有日历数据但零 context 的库:补 @migrated 兜底 context,迁移不失败', () => {
    // 历史 UI 允许不建 context 直接建日历项;无兜底则 NOT NULL(context_id) 使迁移
    // ROLLBACK、应用永远起不来(评审 HIGH 回归)
    const path = join(dir, 'v5-noctx.sqlite3');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = WAL');
    for (const m of MIGRATIONS.slice(0, 5)) raw.exec(m.sql);
    raw.exec('PRAGMA user_version = 5');
    raw.exec(
      `INSERT INTO calendar_items (id, title, date, time, done, created_at)
       VALUES ('calx','孤日历','2026-08-10','09:00',0,'T')`,
    );
    raw.close();

    const db = openDb(path);
    const store = new SqliteGtdStore(db);
    const snap = store.snapshot();
    const fallback = snap.contexts.find((c) => c.name === '@migrated');
    expect(fallback).toBeDefined();
    const migrated = snap.tasks.find((t) => t.id === 'calx')!;
    expect(migrated.contextId).toBe(fallback!.id);
    expect(migrated.startTime).toBe('09:00');
    db.close();
  });
});
