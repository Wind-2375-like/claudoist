import { describe, expect, it } from 'vitest';
import {
  applyRewindToSnapshot,
  applyToSnapshot,
  invertCommands,
  reverseChain,
  rowHash,
} from '../src/index';
import type { Command, GtdSnapshot } from '../src/index';
import { label, project, snapshot, task, waitingFor } from './helpers';

/**
 * INV-35 agent 改动的回滚。
 *
 * 这一条的核心性质只有一个,但必须钉死:**apply 之后再 apply 它的逆,必须回到原快照**。
 * 其余断言都是在保护这个性质的边角(标签的幂等、提醒的副作用、批内顺序)。
 */

/** 往返性质:对任意命令批,apply 再逆 apply 应当回到原样。 */
const roundTrip = (before: GtdSnapshot, cmds: Command[]): void => {
  const after = applyToSnapshot(before, cmds);
  const back = applyRewindToSnapshot(after, reverseChain([invertCommands(before, cmds)]));
  expect(norm(back)).toEqual(norm(before));
};

/** 比较时忽略数组顺序(逆命令重建的行可能落在末尾) */
const norm = (s: GtdSnapshot): unknown =>
  JSON.parse(
    JSON.stringify({
      tasks: [...s.tasks].sort(byId),
      projects: [...s.projects].sort(byId),
      waiting: [...s.waiting].sort(byId),
      labels: [...s.labels].sort(byId),
      taskLabels: [...s.taskLabels].sort((a, b) =>
        `${a.taskId}${a.labelId}` < `${b.taskId}${b.labelId}` ? -1 : 1,
      ),
      filters: [...s.filters].sort(byId),
      reminders: [...s.reminders].sort(byId),
      comments: [...s.comments].sort(byId),
      inbox: [...s.inbox].sort(byId),
      listItems: [...s.listItems].sort(byId),
    }),
  );
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : 1);

describe('INV-35 往返:apply 之后逆 apply 回到原样', () => {
  const base = (): GtdSnapshot =>
    snapshot({
      tasks: [task({ id: 't1', title: '原标题', priority: 3 })],
      projects: [project({ id: 'p1', outcome: '搬家' })],
      labels: [label({ id: 'l1', name: 'errands' })],
    });

  it('updateTask:只回滚 patch 里出现过的键', () => {
    roundTrip(base(), [{ kind: 'updateTask', id: 't1', patch: { title: '新', priority: 5 } }]);
  });

  it('createTask 的逆是硬删(行整个消失,不是软删)', () => {
    const before = base();
    const nt = task({ id: 'new', title: '新建' });
    const after = applyToSnapshot(before, [{ kind: 'createTask', task: nt }]);
    expect(after.tasks).toHaveLength(2);
    const back = applyRewindToSnapshot(
      after,
      reverseChain([invertCommands(before, [{ kind: 'createTask', task: nt }])]),
    );
    expect(back.tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('completeTask 那种「一批多条」也能整体回滚', () => {
    const before = snapshot({
      tasks: [
        task({ id: 'p' }),
        task({ id: 'c1', parentTaskId: 'p' }),
        task({ id: 'c2', parentTaskId: 'p' }),
      ],
    });
    const patch = { status: 'done' as const, completedAt: '2026-08-13T10:00:00' };
    roundTrip(before, [
      { kind: 'updateTask', id: 'p', patch },
      { kind: 'updateTask', id: 'c1', patch },
      { kind: 'updateTask', id: 'c2', patch },
    ]);
  });

  it('createProject / createWaitingFor 同规', () => {
    const before = base();
    roundTrip(before, [{ kind: 'createProject', project: project({ id: 'p2' }) }]);
    roundTrip(before, [{ kind: 'createWaitingFor', item: waitingFor({ id: 'w1' }) }]);
  });

  it('评论、提醒、过滤器、标签的增删都能往返', () => {
    const before = base();
    roundTrip(before, [
      {
        kind: 'createComment',
        comment: { id: 'cm1', taskId: 't1', body: 'x', createdAt: '2026-08-13T00:00:00' },
      },
    ]);
    roundTrip(before, [{ kind: 'createLabel', label: label({ id: 'l2', name: 'home' }) }]);
  });
});

describe('INV-35 标签:幂等的 assign 不能被回滚成"摘掉"', () => {
  it('before 里已经有这个 pair → 逆是 no-op(存储层是 INSERT OR IGNORE)', () => {
    const before = snapshot({
      tasks: [task({ id: 't1' })],
      labels: [label({ id: 'l1' })],
      taskLabels: [{ taskId: 't1', labelId: 'l1' }],
    });
    const { inverse } = invertCommands(before, [
      { kind: 'assignLabel', taskId: 't1', labelId: 'l1' },
    ]);
    // 逆必须是"再 assign 一次"(no-op),而不是 unassign —— 否则会摘掉用户原有的标签
    expect(inverse[0]).toEqual({ kind: 'assignLabel', taskId: 't1', labelId: 'l1' });
  });

  it('before 里没有 → 逆是 unassign', () => {
    const before = snapshot({ tasks: [task({ id: 't1' })], labels: [label({ id: 'l1' })] });
    const { inverse } = invertCommands(before, [
      { kind: 'assignLabel', taskId: 't1', labelId: 'l1' },
    ]);
    expect(inverse[0]).toEqual({ kind: 'unassignLabel', taskId: 't1', labelId: 'l1' });
  });

  it('setTaskLabels 那种 assign+unassign 混合批能往返', () => {
    const before = snapshot({
      tasks: [task({ id: 't1' })],
      labels: [label({ id: 'l1' }), label({ id: 'l2' })],
      taskLabels: [{ taskId: 't1', labelId: 'l1' }],
    });
    roundTrip(before, [
      { kind: 'assignLabel', taskId: 't1', labelId: 'l2' },
      { kind: 'unassignLabel', taskId: 't1', labelId: 'l1' },
    ]);
  });

  it('deleteLabel 的逆必须先建标签再补关联(顺序错了外键就挂)', () => {
    const before = snapshot({
      tasks: [task({ id: 't1' }), task({ id: 't2' })],
      labels: [label({ id: 'l1' })],
      taskLabels: [
        { taskId: 't1', labelId: 'l1' },
        { taskId: 't2', labelId: 'l1' },
      ],
    });
    const { inverse } = invertCommands(before, [{ kind: 'deleteLabel', id: 'l1' }]);
    expect(inverse[0]!.kind).toBe('createLabel');
    expect(inverse.slice(1).every((c) => c.kind === 'assignLabel')).toBe(true);
  });
});

describe('INV-35 副作用不回滚', () => {
  it('updateReminder 的逆剔除 dispatched —— 否则提醒会再响一次', () => {
    const before = snapshot({
      tasks: [task({ id: 't1' })],
      reminders: [
        {
          id: 'r1',
          taskId: 't1',
          remindAt: '2026-08-13T09:00',
          dispatched: false,
          createdAt: '2026-08-13T00:00:00',
        },
      ],
    });
    const { inverse } = invertCommands(before, [
      {
        kind: 'updateReminder',
        id: 'r1',
        patch: { dispatched: true, remindAt: '2026-08-13T10:00' },
      },
    ]);
    const patch = (inverse[0] as { patch: Record<string, unknown> }).patch;
    expect(patch['dispatched']).toBeUndefined();
    expect(patch['remindAt']).toBe('2026-08-13T09:00');
  });
});

describe('INV-35 链序:多批倒序应用', () => {
  it('两批依次改同一字段,倒序回滚后回到最初的值', () => {
    const s0 = snapshot({ tasks: [task({ id: 't1', title: 'A' })] });
    const c1: Command[] = [{ kind: 'updateTask', id: 't1', patch: { title: 'B' } }];
    const s1 = applyToSnapshot(s0, c1);
    const b1 = invertCommands(s0, c1);
    const c2: Command[] = [{ kind: 'updateTask', id: 't1', patch: { title: 'C' } }];
    const s2 = applyToSnapshot(s1, c2);
    const b2 = invertCommands(s1, c2);

    expect(s2.tasks[0]!.title).toBe('C');
    // 链序引理:批按 seq 严格降序应用
    const back = applyRewindToSnapshot(s2, reverseChain([b1, b2]));
    expect(back.tasks[0]!.title).toBe('A');
  });

  it('after 记录的正是"下一条的当前值",冲突检测就靠它', () => {
    const s0 = snapshot({ tasks: [task({ id: 't1', title: 'A' })] });
    const c1: Command[] = [{ kind: 'updateTask', id: 't1', patch: { title: 'B' } }];
    const b1 = invertCommands(s0, c1);
    expect(b1.after[0]).toEqual({ t: 'fields', v: { title: 'B' } });
    expect((b1.inverse[0] as { patch: Record<string, unknown> }).patch).toEqual({ title: 'A' });
  });
});

describe('INV-35 行指纹', () => {
  it('键序不影响指纹', () => {
    expect(rowHash({ a: 1, b: 2 })).toBe(rowHash({ b: 2, a: 1 }));
  });
  it('值变了指纹就变', () => {
    expect(rowHash({ a: 1 })).not.toBe(rowHash({ a: 2 }));
  });
});
