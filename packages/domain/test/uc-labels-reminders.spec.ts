import { describe, expect, it } from 'vitest';
import { setTaskLabels } from '../src/usecases/labels';
import { addReminder, deleteReminder } from '../src/usecases/reminders';
import { addSubtask } from '../src/usecases/tasks';
import { applyToSnapshot } from '../src/index';
import { isUsecaseError } from '../src/usecases/types';
import { deps, label, snapshot, task } from './helpers';

/** D-22 详情右栏就地编辑:setTaskLabels(diff)、reminder 增删;子任务完整属性集。 */
describe('setTaskLabels(diff 式)', () => {
  const base = snapshot({
    labels: [label({ id: 'l1' }), label({ id: 'l2' }), label({ id: 'l3' })],
    tasks: [task({ id: 't1' })],
    taskLabels: [{ taskId: 't1', labelId: 'l1' }],
  });

  it('目标集合 → 只发差异的 assign/unassign', () => {
    const r = setTaskLabels(base, deps(), { taskId: 't1', labelIds: ['l1', 'l2'] });
    if (isUsecaseError(r)) throw new Error(r.error);
    // 保留 l1、新增 l2:一条 assignLabel
    expect(r.commands).toEqual([{ kind: 'assignLabel', taskId: 't1', labelId: 'l2' }]);
    const after = applyToSnapshot(base, r.commands);
    expect(
      after.taskLabels
        .filter((tl) => tl.taskId === 't1')
        .map((tl) => tl.labelId)
        .sort(),
    ).toEqual(['l1', 'l2']);
  });

  it('清空 = 全部 unassign;未知 label / 幽灵任务报错', () => {
    const r = setTaskLabels(base, deps(), { taskId: 't1', labelIds: [] });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.commands).toEqual([{ kind: 'unassignLabel', taskId: 't1', labelId: 'l1' }]);
    expect('error' in setTaskLabels(base, deps(), { taskId: 't1', labelIds: ['ghost'] })).toBe(
      true,
    );
    expect('error' in setTaskLabels(base, deps(), { taskId: 'ghost', labelIds: [] })).toBe(true);
  });
});

describe('reminder 增删', () => {
  const base = snapshot({
    tasks: [task({ id: 't1' })],
  });

  it('addReminder 校验格式 + 落库;deleteReminder 幂等前置校验', () => {
    const r = addReminder(base, deps(), { taskId: 't1', remindAt: '2026-08-10T09:00' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(base, r.commands);
    expect(after.reminders[0]!.taskId).toBe('t1');
    expect('error' in addReminder(base, deps(), { taskId: 't1', remindAt: '坏格式' })).toBe(true);
    const del = deleteReminder(after, deps(), { id: after.reminders[0]!.id });
    if (isUsecaseError(del)) throw new Error(del.error);
    expect(applyToSnapshot(after, del.commands).reminders).toHaveLength(0);
    expect('error' in deleteReminder(base, deps(), { id: 'ghost' })).toBe(true);
  });
});

describe('addSubtask 完整属性集(D-22)', () => {
  it('label + reminder 一并落库(同一命令批)', () => {
    const base = snapshot({
      labels: [label({ id: 'l1' })],
      tasks: [task({ id: 't1' })],
    });
    const r = addSubtask(base, deps(), {
      parentTaskId: 't1',
      title: '子',
      labelIds: ['l1'],
      reminderAt: '2026-08-10T09:00',
    });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.commands.map((c) => c.kind)).toEqual(['createTask', 'assignLabel', 'createReminder']);
  });
});
