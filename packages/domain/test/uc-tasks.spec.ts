import { describe, expect, it } from 'vitest';
import type { UpdateTaskPatch } from '../src/usecases/tasks';
import {
  completeTask,
  deleteTask,
  quickAddTask,
  restoreTask,
  updateTask,
} from '../src/usecases/tasks';
import { isUsecaseError } from '../src/usecases/types';
import type { UsecaseResult } from '../src/usecases/types';
import type { Command } from '../src/index';
import { applyToSnapshot } from '../src/index';
import { deps, snapshot, task } from './helpers';

function ok<C>(r: UsecaseResult<C>): { commands: Command[]; consequences: C } {
  if (isUsecaseError(r)) throw new Error(r.error);
  return r;
}

describe('uc-tasks quickAddTask(§4.2 扩展版)', () => {
  const base = () => snapshot({});

  it('title 必填,其余默认(15 分钟 / medium / P3 / 无项目无 DDL)', () => {
    const r = ok(quickAddTask(base(), deps(), { title: '买牛奶' }));
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createTask') throw new Error('expected createTask');
    expect(cmd.task).toMatchObject({
      title: '买牛奶',
      estimatedMinutes: 15,
      energy: 'medium',
      priority: 3,
      projectId: null,
      deadline: null,
      status: 'active',
    });
  });

  it('非法输入回退默认:0 分钟 → 15;priority 越界 → 3(§2.3)', () => {
    const r = ok(
      quickAddTask(base(), deps(), {
        title: 'x',
        estimatedMinutes: 0,
        priority: 9,
      }),
    );
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createTask') throw new Error('expected createTask');
    expect(cmd.task.estimatedMinutes).toBe(15);
    expect(cmd.task.priority).toBe(3);
  });

  it('必填缺失/非法引用 → 错误:空 title、坏 deadline、不存在的项目', () => {
    const snap = snapshot({});
    expect('error' in quickAddTask(snap, deps(), { title: ' ' })).toBe(true);
    expect('error' in quickAddTask(snap, deps(), { title: 'x', deadline: '2026-1-5' })).toBe(true);
    expect('error' in quickAddTask(snap, deps(), { title: 'x', projectId: 'nope' })).toBe(true);
  });
});

describe('uc-tasks updateTask:patch 白名单 + INV-03 校验', () => {
  const base = () =>
    snapshot({
      tasks: [task({ id: 't1' })],
    });

  it('白名单外字段被丢弃(status 不可经 patch 修改)', () => {
    const dirty = { title: '新标题', status: 'done' } as UpdateTaskPatch;
    const r = ok(updateTask(base(), deps(), { id: 't1', patch: dirty }));
    expect(r.commands).toEqual([{ kind: 'updateTask', id: 't1', patch: { title: '新标题' } }]);
  });

  it('deadline 写入校验:坏值拒绝,null 清除合法', () => {
    expect(
      'error' in updateTask(base(), deps(), { id: 't1', patch: { deadline: '2026-1-5' } }),
    ).toBe(true);
    const r = ok(updateTask(base(), deps(), { id: 't1', patch: { deadline: null } }));
    expect(r.commands[0]).toEqual({ kind: 'updateTask', id: 't1', patch: { deadline: null } });
  });

  it('description / scheduledDate 可经 patch 修改(回归:曾被白名单静默丢弃)', () => {
    const r = ok(
      updateTask(base(), deps(), {
        id: 't1',
        patch: { description: ' 补充说明 ', scheduledDate: '2026-08-10' },
      }),
    );
    expect(r.commands[0]).toEqual({
      kind: 'updateTask',
      id: 't1',
      patch: { description: '补充说明', scheduledDate: '2026-08-10' },
    });
    expect(
      'error' in updateTask(base(), deps(), { id: 't1', patch: { scheduledDate: '2026-8-10' } }),
    ).toBe(true); // INV-03 写入侧校验
    const clear = ok(updateTask(base(), deps(), { id: 't1', patch: { scheduledDate: null } }));
    expect(clear.commands[0]).toEqual({
      kind: 'updateTask',
      id: 't1',
      patch: { scheduledDate: null },
    });
  });

  it('空 patch → 无命令', () => {
    expect(ok(updateTask(base(), deps(), { id: 't1', patch: {} })).commands).toHaveLength(0);
  });
});

describe('uc-tasks 时间字段(D-23/M6a 日历统一)', () => {
  const base = () => snapshot({});

  it('quickAddTask:startTime/durationMinutes 落库;缺省为 null', () => {
    const r = ok(
      quickAddTask(base(), deps(), {
        title: '组会',
        scheduledDate: '2026-08-10',
        startTime: '15:00',
        durationMinutes: 45,
      }),
    );
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createTask') throw new Error('expected createTask');
    expect(cmd.task.startTime).toBe('15:00');
    expect(cmd.task.durationMinutes).toBe(45);
    const r2 = ok(quickAddTask(base(), deps(), { title: '普通' }));
    const cmd2 = r2.commands[0]!;
    if (cmd2.kind !== 'createTask') throw new Error('expected createTask');
    expect(cmd2.task.startTime).toBeNull();
    expect(cmd2.task.durationMinutes).toBeNull();
  });

  it('校验:坏 HH:MM / 非正整数分钟 → 错误(add 与 update 同口径)', () => {
    expect('error' in quickAddTask(base(), deps(), { title: 'x', startTime: '25:00' })).toBe(true);
    expect('error' in quickAddTask(base(), deps(), { title: 'x', durationMinutes: 0 })).toBe(true);
    const snap = snapshot({ tasks: [task({ id: 't1' })] });
    expect('error' in updateTask(snap, deps(), { id: 't1', patch: { startTime: '9am' } })).toBe(
      true,
    );
    expect('error' in updateTask(snap, deps(), { id: 't1', patch: { durationMinutes: 1.5 } })).toBe(
      true,
    );
  });

  it('updateTask:设置与清除(null)时间字段', () => {
    const snap = snapshot({ tasks: [task({ id: 't1' })] });
    const r = ok(
      updateTask(snap, deps(), { id: 't1', patch: { startTime: '08:30', durationMinutes: 30 } }),
    );
    const after = applyToSnapshot(snap, r.commands);
    expect(after.tasks[0]!.startTime).toBe('08:30');
    expect(after.tasks[0]!.durationMinutes).toBe(30);
    const r2 = ok(
      updateTask(after, deps(), { id: 't1', patch: { startTime: null, durationMinutes: null } }),
    );
    const after2 = applyToSnapshot(after, r2.commands);
    expect(after2.tasks[0]!.startTime).toBeNull();
    expect(after2.tasks[0]!.durationMinutes).toBeNull();
  });
});

describe('uc-tasks 完成/软删/恢复状态机', () => {
  it('completeTask 只对 active 有效(done/deleted → 错误)', () => {
    const snap = snapshot({
      tasks: [task({ id: 'td', status: 'done' }), task({ id: 'tx', status: 'deleted' })],
    });
    expect('error' in completeTask(snap, deps(), { id: 'td' })).toBe(true);
    expect('error' in completeTask(snap, deps(), { id: 'tx' })).toBe(true);
    expect('error' in completeTask(snap, deps(), { id: 'nope' })).toBe(true);
  });

  it('deleteTask → Trash;restoreTask → active 且清空 deletedAt(INV-22 口径)', () => {
    const snap = snapshot({
      tasks: [task({ id: 't1' })],
    });
    const del = ok(deleteTask(snap, deps(), { id: 't1' }));
    const afterDel = applyToSnapshot(snap, del.commands);
    expect(afterDel.tasks[0]!.status).toBe('deleted');
    expect(afterDel.tasks[0]!.deletedAt).toBe('2026-08-08T12:00:00');
    const res = ok(restoreTask(afterDel, deps(), { id: 't1' }));
    const afterRes = applyToSnapshot(afterDel, res.commands);
    expect(afterRes.tasks[0]!.status).toBe('active');
    expect(afterRes.tasks[0]!.deletedAt).toBeNull();
  });

  it('restoreTask:deleted → 恢复;非 deleted → { error }(D-30 后无 context 前置)', () => {
    const snap = snapshot({
      tasks: [
        task({ id: 't1', status: 'deleted', deletedAt: '2026-08-07T00:00:00' }),
        task({ id: 't2', status: 'active' }),
      ],
    });
    expect('error' in restoreTask(snap, deps(), { id: 't1' })).toBe(false);
    expect('error' in restoreTask(snap, deps(), { id: 't2' })).toBe(true);
  });

  it('重复删除 → 错误(已在 Trash)', () => {
    const snap = snapshot({ tasks: [task({ id: 't1', status: 'deleted' })] });
    expect('error' in deleteTask(snap, deps(), { id: 't1' })).toBe(true);
  });
});
