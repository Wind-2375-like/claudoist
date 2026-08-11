import { describe, expect, it } from 'vitest';
import { captureToInbox } from '../src/usecases/capture';
import { deleteTask } from '../src/usecases/tasks';
import { quickAddTask } from '../src/usecases/tasks';
import { isUsecaseError } from '../src/usecases/types';
import { deps, label, snapshot, task } from './helpers';

/**
 * INV-17(D-21 修订载体):一次用户决定 = 一个命令批 = 一个事务。
 * usecase 把全部产物放进单个批返回,宿主 store.apply 原子应用
 * (SQLite 侧的整批回滚由 storage 契约套件断言)。
 */
describe('INV-17 命令批原子性:一次决定的全部产物在同一批', () => {
  const base = snapshot({
    labels: [label({ id: 'l1' })],
  });

  it('quickAdd 带 label + 提醒 → createTask/assignLabel/createReminder 同批', () => {
    const r = quickAddTask(base, deps(), {
      title: 'x',
      labelIds: ['l1'],
      reminderAt: '2026-08-09T09:00',
    });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.commands.map((c) => c.kind)).toEqual(['createTask', 'assignLabel', 'createReminder']);
  });

  it('级联软删 → 整棵子树的 updateTask 在同一批,不分两次(INV-26)', () => {
    const snap = snapshot({
      tasks: [
        task({ id: 't1' }),
        task({ id: 't2', parentTaskId: 't1' }),
        task({ id: 't3', parentTaskId: 't2' }),
      ],
    });
    const r = deleteTask(snap, deps(), { id: 't1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.commands).toHaveLength(3);
    expect(r.commands.every((c) => c.kind === 'updateTask')).toBe(true);
  });

  it('capture 多条 → 全部 createTask 在同一批(逐条可寻址,INV-16 载体)', () => {
    const r = captureToInbox(base, deps(), { texts: ['a', 'b', 'c'] });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.commands).toHaveLength(3);
    expect(r.consequences.createdIds).toHaveLength(3);
  });
});
