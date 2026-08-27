import { describe, expect, it } from 'vitest';
import { updateProject } from '../src/usecases/projects';
import { tasksWithInheritedDeadline } from '../src/rules/deadlineInheritance';
import { applyToSnapshot } from '../src/index';
import { isUsecaseError } from '../src/usecases/types';
import { deps, project, snapshot, task } from './helpers';

/**
 * INV-12(D-21 收窄到行动):继承是 copy-on-create/move,不是活引用。
 * 编辑项目 deadline 时一次性提示"旧值相同"的行动;
 * 仅显式 propagateDeadline:true 才连带更新 —— 绝不静默级联。
 */
describe('INV-12 copy-on-create 与编辑传播(仅项目→行动)', () => {
  const base = snapshot({
    projects: [project({ id: 'p1', deadline: '2026-09-01' })],
    tasks: [
      task({ id: 't1', projectId: 'p1', deadline: '2026-09-01' }), // 与旧值相同 → 传播对象
      task({ id: 't2', projectId: 'p1', deadline: '2026-08-15' }), // 自定义 → 不动
      task({ id: 't3', projectId: 'p1', deadline: '2026-09-01', status: 'done' }), // 非 active → 不动
      task({ id: 't4', projectId: null, deadline: '2026-09-01' }), // 别处 → 不动
    ],
  });

  it('规则:传播对象 = 与旧值相同的 active 行动', () => {
    expect(tasksWithInheritedDeadline(base, 'p1', '2026-09-01')).toEqual(['t1']);
    expect(tasksWithInheritedDeadline(base, 'p1', null)).toEqual([]);
  });

  it('不带 propagateDeadline:只改项目,consequences 报告可传播行动', () => {
    const r = updateProject(base, deps(), { id: 'p1', patch: { deadline: '2026-10-01' } });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.tasksWithInheritedDeadline).toEqual(['t1']);
    expect(r.consequences.propagated).toBeUndefined();
    const after = applyToSnapshot(base, r.commands);
    expect(after.projects[0]!.deadline).toBe('2026-10-01');
    expect(after.tasks.find((t) => t.id === 't1')!.deadline).toBe('2026-09-01'); // 未动
  });

  it('带 propagateDeadline:true:同一命令批连带更新该批行动(INV-17)', () => {
    const r = updateProject(base, deps(), {
      id: 'p1',
      patch: { deadline: '2026-10-01' },
      propagateDeadline: true,
    });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.propagated).toBe(true);
    const after = applyToSnapshot(base, r.commands);
    expect(after.tasks.find((t) => t.id === 't1')!.deadline).toBe('2026-10-01');
    expect(after.tasks.find((t) => t.id === 't2')!.deadline).toBe('2026-08-15');
    expect(after.tasks.find((t) => t.id === 't3')!.deadline).toBe('2026-09-01');
    expect(after.tasks.find((t) => t.id === 't4')!.deadline).toBe('2026-09-01');
  });

  it('改名不触发任何传播计算;清除 deadline(null)合法', () => {
    const r1 = updateProject(base, deps(), { id: 'p1', patch: { outcome: '新名字' } });
    if (isUsecaseError(r1)) throw new Error(r1.error);
    expect(r1.consequences.tasksWithInheritedDeadline).toBeUndefined();
    const r2 = updateProject(base, deps(), { id: 'p1', patch: { deadline: null } });
    if (isUsecaseError(r2)) throw new Error(r2.error);
    expect(applyToSnapshot(base, r2.commands).projects[0]!.deadline).toBeNull();
  });
});
