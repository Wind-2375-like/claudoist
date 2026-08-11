import { describe, expect, it } from 'vitest';
import { createFollowUp, createWaitingForDirect, resolveWaitingFor } from '../src/usecases/waiting';
import { isUsecaseError } from '../src/usecases/types';
import type { UsecaseResult } from '../src/usecases/types';
import type { Command } from '../src/index';
import { applyToSnapshot } from '../src/index';
import { ctx, deps, snapshot, waitingFor } from './helpers';

function ok<C>(r: UsecaseResult<C>): { commands: Command[]; consequences: C } {
  if (isUsecaseError(r)) throw new Error(r.error);
  return r;
}

describe('uc-waiting resolve 与 follow-up 解耦(INV-14 边界 / INV-23)', () => {
  it('resolveWaitingFor:仅置 resolved+resolvedAt;不建 follow-up、无追问后果', () => {
    const snap = snapshot({ waiting: [waitingFor({ id: 'w1' })] });
    const r = ok(resolveWaitingFor(snap, deps(), { id: 'w1' }));
    expect(r.commands).toEqual([
      {
        kind: 'updateWaitingFor',
        id: 'w1',
        patch: { resolved: true, resolvedAt: '2026-08-08T12:00:00' },
      },
    ]);
    expect(r.commands.some((c) => c.kind === 'createTask')).toBe(false);
    expect(r.consequences).toEqual({}); // INV-14:resolve 不是追问漏斗入口
  });

  it('resolve 已解决项 → 错误;不存在 → 错误', () => {
    const snap = snapshot({ waiting: [waitingFor({ id: 'w1', resolved: true })] });
    expect('error' in resolveWaitingFor(snap, deps(), { id: 'w1' })).toBe(true);
    expect('error' in resolveWaitingFor(snap, deps(), { id: 'nope' })).toBe(true);
  });

  it('createFollowUp:INV-23 模板六字段逐一匹配;WaitingFor 保持未解决', () => {
    const phone = ctx({ id: 'c-phone', name: '@phone', sortOrder: 3 });
    const other = ctx({ id: 'c-other', name: '@errands', sortOrder: 0 });
    const w = waitingFor({ id: 'w1', description: '报价单', delegatedTo: '老王', projectId: 'p1' });
    const snap = snapshot({ contexts: [other, phone], waiting: [w] });
    const r = ok(createFollowUp(snap, deps(), { waitingForId: 'w1' }));
    expect(r.commands).toHaveLength(1);
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createTask') throw new Error('expected createTask');
    expect(cmd.task.title).toBe('Follow up with 老王 re: 报价单');
    expect(cmd.task.contextId).toBe('c-phone'); // @phone 优先(即使 sortOrder 更大)
    expect(cmd.task.estimatedMinutes).toBe(5);
    expect(cmd.task.energy).toBe('low');
    expect(cmd.task.priority).toBe(2); // 「高」(D-29 翻转后)
    expect(cmd.task.projectId).toBe('p1');
    expect(cmd.task.deadline).toBeNull();
    expect(r.consequences.followUpCreated).toBe(cmd.task.id);
    // 不改变 resolved(INV-23):无 updateWaitingFor 命令,应用后仍未解决
    expect(r.commands.some((c) => c.kind === 'updateWaitingFor')).toBe(false);
    const after = applyToSnapshot(snap, r.commands);
    expect(after.waiting.find((x) => x.id === 'w1')!.resolved).toBe(false);
  });

  it('无 @phone → 落到 sortOrder 最小的 active context', () => {
    const a = ctx({ id: 'c-a', name: '@office', sortOrder: 5 });
    const b = ctx({ id: 'c-b', name: '@home', sortOrder: 2 });
    const archivedMin = ctx({ id: 'c-x', name: '@gone', sortOrder: 0, archived: true });
    const snap = snapshot({ contexts: [a, b, archivedMin], waiting: [waitingFor({ id: 'w1' })] });
    const r = ok(createFollowUp(snap, deps(), { waitingForId: 'w1' }));
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createTask') throw new Error('expected createTask');
    expect(cmd.task.contextId).toBe('c-b');
  });

  it('对已 resolved 的等待项建 follow-up → { error }(不发命令)', () => {
    const snap = snapshot({
      contexts: [ctx({ name: '@phone' })],
      waiting: [waitingFor({ id: 'w1', resolved: true })],
    });
    const r = createFollowUp(snap, deps(), { waitingForId: 'w1' });
    expect('error' in r).toBe(true);
    expect('commands' in r).toBe(false);
  });

  it('createWaitingForDirect:受托人留空 → someone;description 必填', () => {
    const snap = snapshot();
    const r = ok(
      createWaitingForDirect(snap, deps(), { description: '等审批', delegatedTo: '  ' }),
    );
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createWaitingFor') throw new Error('expected createWaitingFor');
    expect(cmd.item.delegatedTo).toBe('someone');
    expect(cmd.item.resolved).toBe(false);
    expect('error' in createWaitingForDirect(snap, deps(), { description: ' ' })).toBe(true);
  });
});
