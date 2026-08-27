import { describe, expect, it } from 'vitest';
import { statusSummary } from '../src/usecases/status';
import { ctx, deps, inboxItem, project, snapshot, task, waitingFor } from './helpers';

describe('uc-status statusSummary(§4.15 只读汇总)', () => {
  it('全区口径:计数、排序、分组、树、统计', () => {
    const snap = snapshot({
      contexts: [
        ctx({ id: 'c2', name: '@phone', sortOrder: 1 }),
        ctx({ id: 'c1', name: '@home', sortOrder: 0 }),
        ctx({ id: 'c3', name: '@gone', sortOrder: 2, archived: true }),
      ],
      inbox: [inboxItem({ id: 'i2', position: 5 }), inboxItem({ id: 'i1', position: 2 })],
      projects: [
        project({ id: 'pa', outcome: 'A' }),
        project({ id: 'pb', outcome: 'B' }),
        project({ id: 'pc', outcome: 'C', status: 'complete' }),
      ],
      tasks: [
        task({ id: 't1', contextId: 'c1', projectId: 'pb' }),
        task({ id: 't2', contextId: 'c2', projectId: null }),
        task({ id: 't3', contextId: 'c1', status: 'done' }),
        task({ id: 't4', contextId: 'c1', status: 'deleted' }),
      ],
      waiting: [waitingFor({ id: 'w1' }), waitingFor({ id: 'w2', resolved: true })],
      listItems: [
        { id: 's1', kind: 'someday', text: '学钢琴', createdAt: '2026-08-01T00:00:00' },
        { id: 'r1', kind: 'reference', text: '菜谱', createdAt: '2026-08-01T00:00:00' },
        { id: 'g1', kind: 'trash', text: '垃圾', createdAt: '2026-08-01T00:00:00' },
      ],
    });
    const { commands, consequences: s } = statusSummary(snap, deps());
    expect(commands).toEqual([]); // 纯读,无副作用

    // inbox:计数 + position 升序
    expect(s.inbox.count).toBe(2);
    expect(s.inbox.items.map((i) => i.id)).toEqual(['i1', 'i2']);

    // 项目:D-21 平面列表(active),complete 不列;带统计
    expect(s.projects.map((x) => x.project.id)).toEqual(['pa', 'pb']);
    expect(s.projects[1]!.stats.activeCount).toBe(1); // t1 在 pb
    expect(s.projects[1]!.stats.progress).toBe(0);

    // active Task 按 context 分组(sortOrder 升序;archived context 不列;done/deleted 不计)
    expect(s.tasksByContext.map((g) => g.context.id)).toEqual(['c1', 'c2']);
    expect(s.tasksByContext[0]!.tasks.map((x) => x.task.id)).toEqual(['t1']);
    expect(s.tasksByContext[0]!.tasks[0]!.projectBreadcrumb).toBe('B'); // 平面化:即项目名
    expect(s.tasksByContext[1]!.tasks[0]!.projectBreadcrumb).toBeNull();

    // 未解决 waiting;someday/reference;统计口径(§2.8)
    expect(s.waiting.map((w) => w.id)).toEqual(['w1']);
    expect(s.someday.map((i) => i.id)).toEqual(['s1']);
    expect(s.reference.map((i) => i.id)).toEqual(['r1']);
    expect(s.doneTaskCount).toBe(1);
    expect(s.completeProjectCount).toBe(1);
  });
});
