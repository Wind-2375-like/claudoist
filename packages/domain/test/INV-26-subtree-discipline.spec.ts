import { describe, expect, it } from 'vitest';
import { completeTask, deleteTask, reopenTask, restoreTask } from '../src/usecases/tasks';
import { addComment } from '../src/usecases/comments';
import { isTaskListRoot } from '../src/rules/subtasks';
import { applyToSnapshot } from '../src/index';
import { isUsecaseError } from '../src/usecases/types';
import { deps, snapshot, task } from './helpers';

/**
 * INV-26(D-22):完成向下级联(completedSubtaskCount);软删级联 active 子树
 * (deletedSubtaskCount,done 保留);恢复不级联,父在 Trash 时脱离;reopen 撤销完成。
 */
describe('INV-26 子树完成/删除纪律', () => {
  const base = snapshot({
    tasks: [
      task({ id: 't1' }),
      task({ id: 't2', parentTaskId: 't1' }),
      task({ id: 't3', parentTaskId: 't1' }),
      task({ id: 't4', parentTaskId: 't2' }),
    ],
  });

  it('完成父任务向下级联:整棵 active 子树一并 done,completedSubtaskCount=3', () => {
    const r = completeTask(base, deps(), { id: 't1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.completedSubtaskCount).toBe(3);
    const after = applyToSnapshot(base, r.commands);
    for (const id of ['t1', 't2', 't3', 't4']) {
      expect(after.tasks.find((t) => t.id === id)!.status).toBe('done');
    }
  });

  it('完成方向仅向下:完成一个子任务不改变父任务状态', () => {
    const r = completeTask(base, deps(), { id: 't4' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.completedSubtaskCount).toBe(0); // t4 无子任务
    const after = applyToSnapshot(base, r.commands);
    expect(after.tasks.find((t) => t.id === 't4')!.status).toBe('done');
    expect(after.tasks.find((t) => t.id === 't2')!.status).toBe('active'); // 父不动
    expect(after.tasks.find((t) => t.id === 't1')!.status).toBe('active');
  });

  it('级联只完成 active 后代:已 done 的后代不重复计入', () => {
    const withDone = snapshot({
      tasks: [
        task({ id: 't1' }),
        task({ id: 'td', parentTaskId: 't1', status: 'done', completedAt: 'T0' }),
        task({ id: 'ta', parentTaskId: 't1' }),
      ],
    });
    const r = completeTask(withDone, deps(), { id: 't1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.completedSubtaskCount).toBe(1); // 只 ta
    const after = applyToSnapshot(withDone, r.commands);
    expect(after.tasks.find((t) => t.id === 'td')!.completedAt).toBe('T0'); // 原完成时间不变
  });

  it('reopen 撤销完成:done → active、清 completedAt,仅当前任务不级联', () => {
    const comp = completeTask(base, deps(), { id: 't1' });
    if (isUsecaseError(comp)) throw new Error(comp.error);
    const done = applyToSnapshot(base, comp.commands);
    const r = reopenTask(done, deps(), { id: 't1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(done, r.commands);
    expect(after.tasks.find((t) => t.id === 't1')!.status).toBe('active');
    expect(after.tasks.find((t) => t.id === 't1')!.completedAt).toBeNull();
    expect(after.tasks.find((t) => t.id === 't2')!.status).toBe('done'); // 不级联重开
    expect('error' in reopenTask(done, deps(), { id: 't2' })).toBe(false); // done 可重开
    expect('error' in reopenTask(base, deps(), { id: 't1' })).toBe(true); // active 不可重开
  });

  it('reopen 守卫:父任务已删 → 脱离父(不孤儿化);父仅 done → 保留链接靠 isTaskListRoot 成行', () => {
    // 场景 A:先完成子 C,再删父 R(deleteTask 只级联 active,C 仍 done 挂在已删 R 上)
    const compC = completeTask(base, deps(), { id: 't4' });
    if (isUsecaseError(compC)) throw new Error(compC.error);
    let snap = applyToSnapshot(base, compC.commands); // t4 done
    const delParent = deleteTask(snap, deps(), { id: 't2' }); // 删 t4 的父 t2
    if (isUsecaseError(delParent)) throw new Error(delParent.error);
    snap = applyToSnapshot(snap, delParent.commands); // t2 deleted, t4 done+挂 deleted 父
    const rC = reopenTask(snap, deps(), { id: 't4' });
    if (isUsecaseError(rC)) throw new Error(rC.error);
    const afterA = applyToSnapshot(snap, rC.commands);
    const c = afterA.tasks.find((t) => t.id === 't4')!;
    expect(c.status).toBe('active');
    expect(c.parentTaskId).toBeNull(); // 脱离已删父,不悬空
    expect(isTaskListRoot(afterA, c)).toBe(true); // 列表可见

    // 场景 B:父 R 仅 done(未删)→ reopen 子 C 保留链接,但 isTaskListRoot=true(父非 active)
    const compR = completeTask(base, deps(), { id: 't1' }); // 级联完成 t1..t4
    if (isUsecaseError(compR)) throw new Error(compR.error);
    const allDone = applyToSnapshot(base, compR.commands);
    const rc = reopenTask(allDone, deps(), { id: 't2' }); // 只重开 t2(父 t1 仍 done)
    if (isUsecaseError(rc)) throw new Error(rc.error);
    const afterB = applyToSnapshot(allDone, rc.commands);
    const t2 = afterB.tasks.find((t) => t.id === 't2')!;
    expect(t2.status).toBe('active');
    expect(t2.parentTaskId).toBe('t1'); // 父仅 done,保留链接
    expect(isTaskListRoot(afterB, t2)).toBe(true); // 父非 active → 列表成行,不悬空
    // 父重开后,t2 不再是列表根(回到父详情内)
    const rParent = reopenTask(afterB, deps(), { id: 't1' });
    if (isUsecaseError(rParent)) throw new Error(rParent.error);
    const afterC = applyToSnapshot(afterB, rParent.commands);
    expect(
      isTaskListRoot(
        afterC,
        afterC.tasks.find((t) => t.id === 't2')!,
      ),
    ).toBe(false);
  });

  it('软删父任务:整棵 active 子树级联软删,deletedSubtaskCount=3', () => {
    const r = deleteTask(base, deps(), { id: 't1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.deletedSubtaskCount).toBe(3);
    const after = applyToSnapshot(base, r.commands);
    for (const id of ['t1', 't2', 't3', 't4']) {
      expect(after.tasks.find((t) => t.id === id)!.status).toBe('deleted');
    }
  });

  it('恢复不级联;父仍在 Trash 时恢复子任务 → 脱离父(不悬挂)', () => {
    const del = deleteTask(base, deps(), { id: 't1' });
    if (isUsecaseError(del)) throw new Error(del.error);
    const deleted = applyToSnapshot(base, del.commands);
    const r = restoreTask(deleted, deps(), { id: 't2' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(deleted, r.commands);
    const t2 = after.tasks.find((t) => t.id === 't2')!;
    expect(t2.status).toBe('active');
    expect(t2.parentTaskId).toBeNull(); // 父 t1 仍 deleted → 脱离
    expect(after.tasks.find((t) => t.id === 't1')!.status).toBe('deleted'); // 不级联恢复
  });

  it('删除子任务只级联其自身子树', () => {
    const r = deleteTask(base, deps(), { id: 't2' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.deletedSubtaskCount).toBe(1); // 只有 t4
    const after = applyToSnapshot(base, r.commands);
    expect(after.tasks.find((t) => t.id === 't3')!.status).toBe('active');
  });

  it('回归:级联只删 active 后代 —— done 子任务保持 done,完成记录/项目进度不受影响', () => {
    const withDone = snapshot({
      tasks: [
        task({ id: 't1' }),
        task({ id: 'td', parentTaskId: 't1', status: 'done', completedAt: 'T0' }),
        task({ id: 'ta', parentTaskId: 't1' }),
      ],
    });
    const r = deleteTask(withDone, deps(), { id: 't1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.deletedSubtaskCount).toBe(1); // 只计 active 的 ta
    const after = applyToSnapshot(withDone, r.commands);
    expect(after.tasks.find((t) => t.id === 'td')!.status).toBe('done'); // 不动
    expect(after.tasks.find((t) => t.id === 'td')!.completedAt).toBe('T0');
  });

  it('回归:恢复"删除前已完成"的任务 → 回 done 且保留 completedAt(不洗记录)', () => {
    const snap = snapshot({
      tasks: [task({ id: 'td', status: 'deleted', deletedAt: 'T1', completedAt: 'T0' })],
    });
    const r = restoreTask(snap, deps(), { id: 'td' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(snap, r.commands);
    const t = after.tasks.find((x) => x.id === 'td')!;
    expect(t.status).toBe('done');
    expect(t.completedAt).toBe('T0');
    expect(t.deletedAt).toBeNull();
  });

  it('评论(§2.9):追加到任务;空评论/幽灵任务报错', () => {
    const r = addComment(base, deps(), { taskId: 't1', body: ' 记得配截图 ' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(base, r.commands);
    expect(after.comments).toHaveLength(1);
    expect(after.comments[0]!.body).toBe('记得配截图');
    expect('error' in addComment(base, deps(), { taskId: 't1', body: '  ' })).toBe(true);
    expect('error' in addComment(base, deps(), { taskId: 'ghost', body: 'x' })).toBe(true);
  });
});
