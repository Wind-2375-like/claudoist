import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db';
import { SqliteGtdStore } from '../src/store';
import { MIGRATIONS } from '../src/migrations/index';

/**
 * 迁移 0004(D-21)升级路径回归:存量 v3 库(层级项目)→ v4
 * (projects 表重建去 parent_id、子项目升顶层、tasks.parent_task_id、task_comments)。
 * 关键前提:node:sqlite 默认开启 FK,openDb 必须在迁移前显式 OFF(表重建)。
 */
describe('迁移 v3 → v4(项目平面化 + 子任务 + 评论)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtd-mig-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('存量层级数据展平且 FK 存活;新列/新表可写', () => {
    const path = join(dir, 'v3.sqlite3');
    // 造一个停在 v3 的库:父子项目 + 挂在子项目上的任务
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = WAL');
    for (const m of MIGRATIONS.slice(0, 3)) raw.exec(m.sql);
    raw.exec('PRAGMA user_version = 3');
    raw.exec(`INSERT INTO contexts (id, name, sort_order, created_at) VALUES ('c1','@x',0,'T')`);
    raw.exec(
      `INSERT INTO projects (id, outcome, parent_id, created_at) VALUES ('p1','父',NULL,'T')`,
    );
    raw.exec(
      `INSERT INTO projects (id, outcome, deadline, parent_id, created_at) VALUES ('p2','子','2026-09-01','p1','T')`,
    );
    raw.exec(
      `INSERT INTO tasks (id, title, context_id, project_id, created_at, bucket) VALUES ('t1','任务','c1','p2','T','project')`,
    );
    raw.close();

    const db = openDb(path); // 触发 v4 及后续迁移(至最新版本)
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    expect(version).toBe(MIGRATIONS.length); // 迁移到最新
    const projCols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(projCols).not.toContain('parent_id');
    // v5:tasks 获得 sort_order
    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(taskCols).toContain('sort_order');

    const store = new SqliteGtdStore(db);
    const snap = store.snapshot();
    expect(snap.projects.map((p) => p.id).sort()).toEqual(['p1', 'p2']); // 子项目升顶层,数据保留
    expect(snap.projects.find((p) => p.id === 'p2')!.deadline).toBe('2026-09-01');
    expect(snap.tasks[0]!.projectId).toBe('p2'); // 任务 FK 指向存活
    expect(snap.tasks[0]!.parentTaskId).toBeNull();

    // 新能力可写:子任务 + 评论;且 FK 已重新开启(幽灵引用被拒)
    store.apply(
      [
        {
          kind: 'createTask',
          task: {
            id: 't2',
            title: '子任务',
            estimatedMinutes: 15,
            energy: 'medium',
            priority: 3,
            projectId: 'p2',
            deadline: null,
            status: 'active',
            createdAt: 'T',
            completedAt: null,
            deletedAt: null,
            description: '',
            scheduledDate: null,
            bucket: 'project',
            parentTaskId: 't1',
            sortOrder: 0,
            startTime: null,
            durationMinutes: null,
            externalId: null,
            externalCalendarId: null,
            pushedEventId: null,
            pushedFingerprint: null,
            timeZone: null,
            repeat: null,
            seriesId: null,
            dayOrder: null,
          },
        },
        { kind: 'createComment', comment: { id: 'cm1', taskId: 't1', body: 'ok', createdAt: 'T' } },
      ],
      'user',
    );
    expect(store.snapshot().comments).toHaveLength(1);
    expect(() =>
      store.apply(
        [
          {
            kind: 'createComment',
            comment: { id: 'cm2', taskId: 'ghost', body: 'x', createdAt: 'T' },
          },
        ],
        'user',
      ),
    ).toThrow(); // FK ON
    db.close();
  });
});
