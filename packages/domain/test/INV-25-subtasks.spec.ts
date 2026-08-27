import { describe, expect, it } from 'vitest';
import { addSubtask, moveTask } from '../src/usecases/tasks';
import { taskDepth, descendantTaskIds } from '../src/rules/subtasks';
import { applyToSnapshot } from '../src/index';
import type { GtdSnapshot } from '../src/index';
import { isUsecaseError } from '../src/usecases/types';
import { ctx, deps, project, snapshot, task } from './helpers';

/**
 * INV-25(D-21):子任务深度 ≤5,容器与根一致、随根移动;
 * 移动子任务 = 先脱离父。
 */
describe('INV-25 子任务:深度、继承、随动', () => {
  const chain = (n: number): GtdSnapshot => {
    const tasks = [task({ id: 't1', contextId: 'c1' })];
    for (let i = 2; i <= n; i++) {
      tasks.push(task({ id: `t${i}`, contextId: 'c1', parentTaskId: `t${i - 1}` }));
    }
    return snapshot({ contexts: [ctx({ id: 'c1' })], tasks });
  };

  it('taskDepth:根=1,链式计数;防悬挂', () => {
    const snap = chain(3);
    expect(taskDepth(snap, 't1')).toBe(1);
    expect(taskDepth(snap, 't3')).toBe(3);
  });

  it('第 5 层可建、第 6 层被拒', () => {
    const at4 = chain(4);
    const ok = addSubtask(at4, deps(), { parentTaskId: 't4', title: '第五层' });
    expect(isUsecaseError(ok)).toBe(false);
    const at5 = chain(5);
    const bad = addSubtask(at5, deps(), { parentTaskId: 't5', title: '第六层' });
    expect('error' in bad && bad.error.includes('5')).toBe(true);
  });

  it('子任务继承父的 bucket/projectId/contextId', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' }), ctx({ id: 'c2' })],
      projects: [project({ id: 'p1', deadline: null })],
      tasks: [task({ id: 't1', contextId: 'c2', projectId: 'p1' })],
    });
    const r = addSubtask(snap, deps(), { parentTaskId: 't1', title: '子' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(snap, r.commands);
    const sub = after.tasks.find((t) => t.id === r.consequences.taskId)!;
    expect(sub.parentTaskId).toBe('t1');
    expect(sub.bucket).toBe('project');
    expect(sub.projectId).toBe('p1');
    expect(sub.contextId).toBe('c2');
  });

  it('移动根任务 = 整棵子树随动;挪入有 DDL 项目时无 DDL 成员静默继承(INV-10 move 版)', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      projects: [project({ id: 'p1', deadline: '2026-09-01' })],
      tasks: [
        task({ id: 't1', contextId: 'c1' }),
        task({ id: 't2', contextId: 'c1', parentTaskId: 't1' }),
        task({ id: 't3', contextId: 'c1', parentTaskId: 't2', deadline: '2026-08-20' }),
      ],
    });
    expect(descendantTaskIds(snap, 't1')).toEqual(['t2', 't3']);
    const r = moveTask(snap, deps(), { id: 't1', to: { bucket: 'project', projectId: 'p1' } });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(snap, r.commands);
    for (const id of ['t1', 't2', 't3']) {
      const t = after.tasks.find((x) => x.id === id)!;
      expect(t.bucket).toBe('project');
      expect(t.projectId).toBe('p1');
    }
    expect(after.tasks.find((x) => x.id === 't2')!.deadline).toBe('2026-09-01'); // 无 DDL → 继承
    expect(after.tasks.find((x) => x.id === 't3')!.deadline).toBe('2026-08-20'); // 有 DDL → 不动
  });

  it('移动子任务 = 先脱离父(连同其子树),consequences 标记', () => {
    const snap = chain(3);
    const r = moveTask(snap, deps(), { id: 't2', to: { bucket: 'someday' } });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.detachedFromParent).toBe(true);
    const after = applyToSnapshot(snap, r.commands);
    const t2 = after.tasks.find((x) => x.id === 't2')!;
    expect(t2.parentTaskId).toBeNull();
    expect(t2.bucket).toBe('someday');
    const t3 = after.tasks.find((x) => x.id === 't3')!;
    expect(t3.parentTaskId).toBe('t2'); // 自己的子树保持挂接
    expect(t3.bucket).toBe('someday'); // 且随动
  });

  it('父任务不存在 / 已删除 → 报错', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [task({ id: 'td', contextId: 'c1', status: 'deleted', deletedAt: 'T' })],
    });
    expect('error' in addSubtask(snap, deps(), { parentTaskId: 'ghost', title: 'x' })).toBe(true);
    expect('error' in addSubtask(snap, deps(), { parentTaskId: 'td', title: 'x' })).toBe(true);
  });
});
