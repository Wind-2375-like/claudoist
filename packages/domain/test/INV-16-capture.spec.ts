import { describe, expect, it } from 'vitest';
import { applyToSnapshot, captureToInbox, isUsecaseError } from '../src/index';
import { ctx, deps, snapshot } from './helpers';

/**
 * INV-16 捕捉零判断(载体随 D-20 改为"在 Inbox 建 Task"):
 * 不解析、不去重、不追问元数据;重复合法;原文保存。
 */
describe('INV-16 捕捉零判断(D-20 容器载体)', () => {
  const base = snapshot({
    contexts: [
      ctx({ id: 'c2', name: '@phone', sortOrder: 1 }),
      ctx({ id: 'c1', name: '@computer', sortOrder: 0 }),
    ],
  });

  it('连续捕捉两条相同文本 → Inbox 出现两条任务(重复合法)', () => {
    const r = captureToInbox(base, deps(), { texts: ['买牛奶', '买牛奶'] });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.commands.map((c) => c.kind)).toEqual(['createTask', 'createTask']);
    const after = applyToSnapshot(base, r.commands);
    expect(after.tasks).toHaveLength(2);
    expect(after.tasks.every((t) => t.bucket === 'inbox' && t.status === 'active')).toBe(true);
    expect(after.tasks.every((t) => t.title === '买牛奶')).toBe(true);
  });

  it('默认 context = sortOrder 最小的 active context;全默认属性,无后续表单', () => {
    const r = captureToInbox(base, deps(), { texts: ['一个想法'] });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.commands.map((c) => c.kind)).toEqual(['createTask']); // 零附加命令
    const after = applyToSnapshot(base, r.commands);
    const t = after.tasks[0]!;
    expect(t.contextId).toBe('c1'); // sortOrder 0
    expect(t.priority).toBe(3);
    expect(t.deadline).toBeNull();
    expect(t.scheduledDate).toBeNull();
    expect(t.projectId).toBeNull();
  });

  it('空白文本跳过;原文逐字保存(不 trim)', () => {
    const r = captureToInbox(base, deps(), { texts: ['  ', ' 带空格的想法 '] });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.commands).toHaveLength(1);
    const after = applyToSnapshot(base, r.commands);
    expect(after.tasks[0]!.title).toBe(' 带空格的想法 ');
  });

  it('全空输入 → 无命令、空 createdIds(不报错)', () => {
    const r = captureToInbox(base, deps(), { texts: ['', '   '] });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.commands).toHaveLength(0);
    expect(r.consequences.createdIds).toHaveLength(0);
  });

  it('没有可用 context → 报错(捕捉的唯一前置)', () => {
    const r = captureToInbox(snapshot(), deps(), { texts: ['x'] });
    expect(isUsecaseError(r)).toBe(true);
  });
});
