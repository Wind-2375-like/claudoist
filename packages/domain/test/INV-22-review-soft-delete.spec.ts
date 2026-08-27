import { describe, expect, it } from 'vitest';
import { deleteTask, restoreTask } from '../src/usecases/tasks';
import { applyToSnapshot } from '../src/index';
import { isUsecaseError } from '../src/usecases/types';
import { ctx, deps, snapshot, task } from './helpers';

/**
 * INV-22 / D-01(D-21 修订载体:右键删除):任何入口删除 Task 均为软删除
 * (status='deleted' + deletedAt,行留在表中可恢复),CLI 前身的硬删除不复刻。
 */
describe('INV-22 删除 = 软删除,可恢复', () => {
  const base = snapshot({
    contexts: [ctx({ id: 'c1' })],
    tasks: [task({ id: 't1', contextId: 'c1' })],
  });

  it('删除后行仍在表中(status=deleted + deletedAt);重复删除报错', () => {
    const r = deleteTask(base, deps(), { id: 't1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(base, r.commands);
    const t = after.tasks.find((x) => x.id === 't1')!;
    expect(t.status).toBe('deleted');
    expect(t.deletedAt).not.toBeNull();
    expect('error' in deleteTask(after, deps(), { id: 't1' })).toBe(true);
  });

  it('恢复 → active 且 deletedAt 清空', () => {
    const del = deleteTask(base, deps(), { id: 't1' });
    if (isUsecaseError(del)) throw new Error(del.error);
    const deleted = applyToSnapshot(base, del.commands);
    const r = restoreTask(deleted, deps(), { id: 't1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(deleted, r.commands);
    const t = after.tasks.find((x) => x.id === 't1')!;
    expect(t.status).toBe('active');
    expect(t.deletedAt).toBeNull();
  });

  it('context 已归档 → 恢复前需重指 context(报错)', () => {
    const archived = snapshot({
      contexts: [ctx({ id: 'c1', archived: true })],
      tasks: [task({ id: 't1', contextId: 'c1', status: 'deleted', deletedAt: 'T' })],
    });
    expect('error' in restoreTask(archived, deps(), { id: 't1' })).toBe(true);
  });
});
