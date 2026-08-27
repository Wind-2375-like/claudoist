import { describe, expect, it } from 'vitest';
import { addContext, removeContext } from '../src/usecases/contexts';
import { applyToSnapshot } from '../src/index';
import { ctx, deps, snapshot, task } from './helpers';

describe('INV-24.1 addContext:自动前缀与重名拒绝', () => {
  it('输入 gym → 存为 @gym', () => {
    const snap = snapshot({ contexts: [ctx({ name: '@home', sortOrder: 0 })] });
    const r = addContext(snap, deps(), { name: 'gym' });
    if ('error' in r) throw new Error(r.error);
    expect(r.consequences.normalizedName).toBe('@gym');
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createContext') throw new Error('expected createContext');
    expect(cmd.context.name).toBe('@gym');
    expect(cmd.context.sortOrder).toBe(1); // 追加到末尾
  });

  it('重名(精确匹配)拒绝;含 archived 行(DESIGN §5.3 名称不复用)', () => {
    const snap = snapshot({
      contexts: [ctx({ name: '@gym', archived: false }), ctx({ name: '@old', archived: true })],
    });
    expect(addContext(snap, deps(), { name: 'gym' })).toEqual({ error: 'context 重名: @gym' });
    expect('error' in addContext(snap, deps(), { name: '@old' })).toBe(true);
  });

  it('空名拒绝', () => {
    expect('error' in addContext(snapshot(), deps(), { name: '  ' })).toBe(true);
    expect('error' in addContext(snapshot(), deps(), { name: '@' })).toBe(true);
  });
});

describe('INV-24.3/24.4 removeContext', () => {
  it('最后一个 active context 不可删(archived 不算数)', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1', archived: false }), ctx({ id: 'c2', archived: true })],
    });
    expect(removeContext(snap, deps(), { id: 'c1' })).toEqual({
      error: '不能删除最后一个 context',
    });
  });

  it('含 active Task 且未确认 → 只返回 requiresConfirmation 数量,不发命令', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' }), ctx({ id: 'c2' })],
      tasks: [
        task({ contextId: 'c1' }),
        task({ contextId: 'c1' }),
        task({ contextId: 'c1' }),
        task({ contextId: 'c1', status: 'done' }), // 非 active 不计
        task({ contextId: 'c2' }), // 其他 context 不计
      ],
    });
    const r = removeContext(snap, deps(), { id: 'c1' });
    expect(r).toEqual({ requiresConfirmation: { activeTaskCount: 3 } });
    expect('commands' in r).toBe(false);
  });

  it('确认后:active Task 软删进 Trash(保留 contextId)+ context archived', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' }), ctx({ id: 'c2' })],
      tasks: [
        task({ id: 't1', contextId: 'c1' }),
        task({ id: 't2', contextId: 'c1' }),
        task({ id: 't3', contextId: 'c1', status: 'done' }),
      ],
    });
    const r = removeContext(snap, deps(), { id: 'c1', confirmTrashTasks: true });
    if (!('commands' in r)) throw new Error('expected ok');
    expect(r.consequences.trashedTaskCount).toBe(2);
    const after = applyToSnapshot(snap, r.commands);
    const t1 = after.tasks.find((t) => t.id === 't1')!;
    expect(t1.status).toBe('deleted');
    expect(t1.deletedAt).toBe('2026-08-08T12:00:00');
    expect(t1.contextId).toBe('c1'); // D-09/§5.3:历史引用保持
    expect(after.tasks.find((t) => t.id === 't3')!.status).toBe('done'); // done 不动
    expect(after.contexts.find((c) => c.id === 'c1')!.archived).toBe(true);
  });

  it('无 active Task → 不需要确认,直接 archive,trashedTaskCount=0', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' }), ctx({ id: 'c2' })],
      tasks: [task({ contextId: 'c1', status: 'done' })],
    });
    const r = removeContext(snap, deps(), { id: 'c1' });
    if (!('commands' in r)) throw new Error('expected ok');
    expect(r.consequences.trashedTaskCount).toBe(0);
    expect(r.commands).toEqual([{ kind: 'updateContext', id: 'c1', patch: { archived: true } }]);
  });

  it('已 archived / 不存在 → 错误', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1', archived: true }), ctx({ id: 'c2' }), ctx({ id: 'c3' })],
    });
    expect('error' in removeContext(snap, deps(), { id: 'c1' })).toBe(true);
    expect('error' in removeContext(snap, deps(), { id: 'nope' })).toBe(true);
  });
});
