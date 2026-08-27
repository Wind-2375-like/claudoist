import { describe, expect, it } from 'vitest';
import { quickAddTask, addSubtask } from '../src/usecases/tasks';
import { inheritedTaskDeadline } from '../src/rules/deadlineInheritance';
import { applyToSnapshot } from '../src/index';
import { isUsecaseError } from '../src/usecases/types';
import { ctx, deps, project, snapshot, task } from './helpers';

/**
 * INV-10:行动级继承 —— 项目有 deadline 时,新行动无条件获得其副本
 * (静默,不询问、不提供改填入口;显式传入值亦被覆盖)。
 */
describe('INV-10 行动级 deadline 继承:静默复制,不询问', () => {
  const base = snapshot({
    contexts: [ctx({ id: 'c1' })],
    projects: [
      project({ id: 'p1', deadline: '2026-09-01' }),
      project({ id: 'p0', deadline: null }),
    ],
  });

  it('quickAddTask 挂到有 DDL 项目 → 无条件副本(显式值被覆盖),consequences 告知', () => {
    const r = quickAddTask(base, deps(), {
      title: '写初稿',
      contextId: 'c1',
      projectId: 'p1',
      deadline: '2026-12-31', // 显式值也被项目 DDL 覆盖(INVARIANTS M2 定案)
    });
    expect(isUsecaseError(r)).toBe(false);
    if (isUsecaseError(r)) return;
    expect(r.consequences.inheritedDeadline).toBe('2026-09-01');
    const after = applyToSnapshot(base, r.commands);
    expect(after.tasks[0]!.deadline).toBe('2026-09-01');
  });

  it('项目无 DDL → 用行动自己的 deadline(应询问的场景)', () => {
    expect(inheritedTaskDeadline(base, 'p0')).toBeNull();
    const r = quickAddTask(base, deps(), {
      title: 'x',
      contextId: 'c1',
      projectId: 'p0',
      deadline: '2026-10-01',
    });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.inheritedDeadline).toBeUndefined();
    expect(applyToSnapshot(base, r.commands).tasks[0]!.deadline).toBe('2026-10-01');
  });

  it('子任务同样继承项目 DDL(addSubtask,D-21)', () => {
    const withParent = snapshot({
      ...base,
      tasks: [task({ id: 't1', contextId: 'c1', projectId: 'p1', deadline: '2026-09-01' })],
    });
    const r = addSubtask(withParent, deps(), { parentTaskId: 't1', title: '子步骤' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.inheritedDeadline).toBe('2026-09-01');
  });

  it('无项目任务不继承任何东西', () => {
    const r = quickAddTask(base, deps(), { title: 'y', contextId: 'c1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.inheritedDeadline).toBeUndefined();
    expect(applyToSnapshot(base, r.commands).tasks[0]!.deadline).toBeNull();
  });
});
