import { describe, expect, it } from 'vitest';
import { reorderTask, quickAddTask, addSubtask } from '../src/usecases/tasks';
import { nextSortOrder, nextRootSortOrder, siblingGroup } from '../src/rules/subtasks';
import { applyToSnapshot } from '../src/index';
import { isUsecaseError } from '../src/usecases/types';
import { ctx, deps, project, snapshot, task } from './helpers';

/** INV-27(D-24):手动排序 + 拖拽重排/嵌套。 */
describe('INV-27 sortOrder 与新建追加末尾', () => {
  it('quickAddTask 追加到同级组末尾;capture 逐条递增', () => {
    const base = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 't1', contextId: 'c1', bucket: 'inbox', sortOrder: 0 }),
        task({ id: 't2', contextId: 'c1', bucket: 'inbox', sortOrder: 1 }),
      ],
    });
    expect(nextSortOrder(base, { bucket: 'inbox', projectId: null, parentTaskId: null })).toBe(2);
    const r = quickAddTask(base, deps(), { title: '新', contextId: 'c1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createTask') throw new Error('expected createTask');
    expect(cmd.task.sortOrder).toBe(2);
  });

  it('addSubtask 追加到父的子任务组末尾(独立于顶层组)', () => {
    const base = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'p', contextId: 'c1' }),
        task({ id: 's1', contextId: 'c1', parentTaskId: 'p', sortOrder: 0 }),
      ],
    });
    const r = addSubtask(base, deps(), { parentTaskId: 'p', title: 's2' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createTask') throw new Error('expected createTask');
    expect(cmd.task.sortOrder).toBe(1);
  });
});

describe('INV-27 reorderTask 重排与嵌套', () => {
  const base = () =>
    snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'a', contextId: 'c1', bucket: 'inbox', sortOrder: 0 }),
        task({ id: 'b', contextId: 'c1', bucket: 'inbox', sortOrder: 1 }),
        task({ id: 'c', contextId: 'c1', bucket: 'inbox', sortOrder: 2 }),
      ],
    });

  const order = (snap: ReturnType<typeof base>) =>
    siblingGroup(snap, { bucket: 'inbox', projectId: null, parentTaskId: null })
      .filter((t) => t.parentTaskId === null)
      .sort((x, y) => x.sortOrder - y.sortOrder)
      .map((t) => t.id);

  it('把 c 移到 a 之前 → 顺序 c,a,b', () => {
    const snap = base();
    const r = reorderTask(snap, deps(), { id: 'c', parentTaskId: null, beforeId: 'a' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(order(applyToSnapshot(snap, r.commands))).toEqual(['c', 'a', 'b']);
  });

  it('省略 beforeId → 追加到末尾:把 a 移到末尾 → b,c,a', () => {
    const snap = base();
    const r = reorderTask(snap, deps(), { id: 'a', parentTaskId: null });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(order(applyToSnapshot(snap, r.commands))).toEqual(['b', 'c', 'a']);
  });

  it('拖成子任务:c 落到 a 下 → a.children=[c],顶层剩 a,b', () => {
    const snap = base();
    const r = reorderTask(snap, deps(), { id: 'c', parentTaskId: 'a' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(snap, r.commands);
    expect(after.tasks.find((t) => t.id === 'c')!.parentTaskId).toBe('a');
    expect(order(after)).toEqual(['a', 'b']);
  });

  it('拒绝:成环(拖到自身后代下)、超 5 层、跨 bucket、非活跃父', () => {
    // 成环:a → 子 sa;把 a 拖到 sa 下
    const cyc = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'a', contextId: 'c1' }),
        task({ id: 'sa', contextId: 'c1', parentTaskId: 'a' }),
      ],
    });
    expect('error' in reorderTask(cyc, deps(), { id: 'a', parentTaskId: 'sa' })).toBe(true);

    // 超 5 层:5 层链 t1..t5 + 独立 x(高度1);把 x 拖到 t5 下 → 6 层,拒绝
    const deepTasks = [task({ id: 't1', contextId: 'c1' })];
    for (let i = 2; i <= 5; i++)
      deepTasks.push(task({ id: `t${i}`, contextId: 'c1', parentTaskId: `t${i - 1}` }));
    deepTasks.push(task({ id: 'x', contextId: 'c1' }));
    const deep = snapshot({ contexts: [ctx({ id: 'c1' })], tasks: deepTasks });
    expect('error' in reorderTask(deep, deps(), { id: 'x', parentTaskId: 't5' })).toBe(true);

    // 跨 bucket:someday 任务拖到 inbox 任务下
    const cross = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'inb', contextId: 'c1', bucket: 'inbox' }),
        task({ id: 'sd', contextId: 'c1', bucket: 'someday' }),
      ],
    });
    expect('error' in reorderTask(cross, deps(), { id: 'sd', parentTaskId: 'inb' })).toBe(true);

    // 非活跃父
    const doneParent = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'dp', contextId: 'c1', status: 'done' }),
        task({ id: 'q', contextId: 'c1' }),
      ],
    });
    expect('error' in reorderTask(doneParent, deps(), { id: 'q', parentTaskId: 'dp' })).toBe(true);
  });

  it('beforeId===自身 视为无锚点(追加到末尾),不报错', () => {
    const snap = base();
    // 把 a 拖"到自身之前":应等价于省略 beforeId → 追加到末尾 b,c,a,而非报错
    const r = reorderTask(snap, deps(), { id: 'a', parentTaskId: null, beforeId: 'a' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(order(applyToSnapshot(snap, r.commands))).toEqual(['b', 'c', 'a']);
  });

  it('nextRootSortOrder:孤儿子任务根(父已 done)计入顶层展示集,顶层追加落到其后', () => {
    // p(done) 有活跃子任务 s(sortOrder=7,来自子任务组);顶层普通根只有 r(sortOrder=0)
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'r', contextId: 'c1', bucket: 'inbox', sortOrder: 0 }),
        task({ id: 'p', contextId: 'c1', bucket: 'inbox', status: 'done', sortOrder: 1 }),
        task({ id: 's', contextId: 'c1', bucket: 'inbox', parentTaskId: 'p', sortOrder: 7 }),
      ],
    });
    // 旧口径 nextSortOrder(parentTaskId=null) 只看 {r,p} → 2,会与孤儿根 s(7)撞序;
    // nextRootSortOrder 看展示根集 {r, s}(isTaskListRoot) → 8,保证追加落到末尾。
    expect(nextSortOrder(snap, { bucket: 'inbox', projectId: null, parentTaskId: null })).toBe(2);
    expect(nextRootSortOrder(snap, { bucket: 'inbox', projectId: null })).toBe(8);
    const r = quickAddTask(snap, deps(), { title: '新', contextId: 'c1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createTask') throw new Error('expected createTask');
    expect(cmd.task.sortOrder).toBe(8);
  });

  it('可相对孤儿根(父已 done)重排:beforeId=孤儿根不再误报"不在同级组"', () => {
    // r1(root active)、p(root done)、s(p 的活跃子任务 → isTaskListRoot 显示为顶层行)
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'r1', contextId: 'c1', bucket: 'inbox', sortOrder: 0 }),
        task({ id: 'p', contextId: 'c1', bucket: 'inbox', status: 'done', sortOrder: 1 }),
        task({ id: 's', contextId: 'c1', bucket: 'inbox', parentTaskId: 'p', sortOrder: 7 }),
      ],
    });
    // 把 r1 拖到孤儿根 s 之前:顶层组用 isTaskListRoot 口径含 s → 合法,不报错
    const r = reorderTask(snap, deps(), { id: 'r1', parentTaskId: null, beforeId: 's' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(snap, r.commands);
    const roots = after.tasks
      .filter((t) => t.status === 'active')
      .sort((x, y) => x.sortOrder - y.sortOrder)
      .map((t) => t.id);
    // r1 排在 s 之前,且整组(r1,s)重编号为连续 0..n-1(不再与旧值撞序)
    expect(roots).toEqual(['r1', 's']);
    expect(after.tasks.find((t) => t.id === 'r1')!.sortOrder).toBe(0);
    expect(after.tasks.find((t) => t.id === 's')!.sortOrder).toBe(1);
  });

  it('孤儿根顶层重排保留 done 父链接(父 reopen 后回归,INV-26 契约)', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'p', contextId: 'c1', bucket: 'inbox', status: 'done', sortOrder: 0 }),
        task({ id: 's', contextId: 'c1', bucket: 'inbox', parentTaskId: 'p', sortOrder: 0 }),
        task({ id: 'r', contextId: 'c1', bucket: 'inbox', sortOrder: 1 }),
      ],
    });
    // s 是孤儿根(父 p 已 done,显示为顶层行);顶层拖到 r 之前 = 纯排序,不摘父
    const r = reorderTask(snap, deps(), { id: 's', parentTaskId: null, beforeId: 'r' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(snap, r.commands);
    expect(after.tasks.find((t) => t.id === 's')!.parentTaskId).toBe('p'); // 链接保留
    // 排序生效:s 在 r 之前
    const active = after.tasks
      .filter((t) => t.status === 'active')
      .sort((x, y) => x.sortOrder - y.sortOrder)
      .map((t) => t.id);
    expect(active).toEqual(['s', 'r']);
    // 真正的 outdent(活跃父)仍然置 null:把 sa 从活跃父 a 拖到顶层
    const nested = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'a', contextId: 'c1', bucket: 'inbox', sortOrder: 0 }),
        task({ id: 'sa', contextId: 'c1', bucket: 'inbox', parentTaskId: 'a', sortOrder: 0 }),
      ],
    });
    const r2 = reorderTask(nested, deps(), { id: 'sa', parentTaskId: null });
    if (isUsecaseError(r2)) throw new Error(r2.error);
    expect(
      applyToSnapshot(nested, r2.commands).tasks.find((t) => t.id === 'sa')!.parentTaskId,
    ).toBe(null);
  });

  it('拖成子任务时项目一致:同项目内可嵌套', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      projects: [project({ id: 'p1' })],
      tasks: [
        task({ id: 'a', contextId: 'c1', projectId: 'p1', bucket: 'project' }),
        task({ id: 'b', contextId: 'c1', projectId: 'p1', bucket: 'project' }),
      ],
    });
    const r = reorderTask(snap, deps(), { id: 'b', parentTaskId: 'a' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(applyToSnapshot(snap, r.commands).tasks.find((t) => t.id === 'b')!.parentTaskId).toBe(
      'a',
    );
  });
});
