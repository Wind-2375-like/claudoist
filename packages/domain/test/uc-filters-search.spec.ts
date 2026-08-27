import { describe, expect, it } from 'vitest';
import { createFilter, deleteFilter, evalFilter, updateFilter } from '../src/usecases/filters';
import { searchAll } from '../src/usecases/search';
import { isUsecaseError } from '../src/usecases/types';
import type { UsecaseResult } from '../src/usecases/types';
import type { GtdSnapshot, Task } from '../src/index';
import { deps, inboxItem, project, snapshot, task, waitingFor } from './helpers';

function ok<C>(r: UsecaseResult<C>): C {
  if (isUsecaseError(r)) throw new Error(r.error);
  return r.consequences;
}

const ids = (ts: Task[]): string[] => ts.map((t) => t.id);

/** 过滤维度 fixture:a/b/c active,d done,e deleted。 */
function filterSnap(): GtdSnapshot {
  return snapshot({
    tasks: [
      task({
        id: 'a',
        title: 'Buy milk',
        contextId: 'c1',
        priority: 3,
        energy: 'low',
        estimatedMinutes: 15,
        projectId: null,
        deadline: '2026-08-10',
      }),
      task({
        id: 'b',
        title: 'write REPORT',
        contextId: 'c1',
        priority: 5,
        energy: 'high',
        estimatedMinutes: 90,
        projectId: 'p1',
        deadline: '2026-09-01',
      }),
      task({
        id: 'c',
        title: 'call mom',
        contextId: 'c2',
        priority: 4,
        energy: 'urgent', // 未知值 → 按 medium 参与比较(INV-02)
        estimatedMinutes: 5,
        projectId: null,
        deadline: null,
      }),
      task({ id: 'd', title: 'buy tickets', status: 'done' }),
      task({ id: 'e', title: 'buy junk', status: 'deleted' }),
    ],
    taskLabels: [
      { taskId: 'a', labelId: 'l1' },
      { taskId: 'a', labelId: 'l2' },
      { taskId: 'b', labelId: 'l1' },
    ],
  });
}

describe('uc-filters evalFilter:各维度 + INV-01/INV-02 语义', () => {
  it('空查询 → 全部 active(done/deleted 排除)', () => {
    expect(ids(evalFilter(filterSnap(), {}))).toEqual(['a', 'b', 'c']);
  });

  it('energyMax=medium:low 与未知值(按 medium)入选,high 排除(INV-02 序与方向)', () => {
    expect(ids(evalFilter(filterSnap(), { energyMax: 'medium' }))).toEqual(['a', 'c']);
    expect(ids(evalFilter(filterSnap(), { energyMax: 'high' }))).toEqual(['a', 'b', 'c']);
    expect(ids(evalFilter(filterSnap(), { energyMax: 'low' }))).toEqual(['a']);
  });

  it('priorityMin=4:数值 ≥(INV-01:5=最高,不重编号)', () => {
    expect(ids(evalFilter(filterSnap(), { priorityMin: 4 }))).toEqual(['b', 'c']);
    expect(ids(evalFilter(filterSnap(), { priorityMin: 5 }))).toEqual(['b']);
  });

  it('dueOnOrBefore:字典序 ≤;无 deadline 不命中', () => {
    expect(ids(evalFilter(filterSnap(), { dueOnOrBefore: '2026-08-15' }))).toEqual(['a']);
    expect(ids(evalFilter(filterSnap(), { dueOnOrBefore: '2026-09-01' }))).toEqual(['a', 'b']);
  });

  it('textQuery:大小写不敏感包含', () => {
    expect(ids(evalFilter(filterSnap(), { textQuery: 'BUY' }))).toEqual(['a']);
    expect(ids(evalFilter(filterSnap(), { textQuery: 'report' }))).toEqual(['b']);
  });

  it('labelIds 全含语义', () => {
    expect(ids(evalFilter(filterSnap(), { labelIds: ['l1'] }))).toEqual(['a', 'b']);
    expect(ids(evalFilter(filterSnap(), { labelIds: ['l1', 'l2'] }))).toEqual(['a']);
    expect(ids(evalFilter(filterSnap(), { labelIds: [] }))).toEqual(['a', 'b', 'c']);
  });

  it('contextId / maxMinutes / noProject / 组合', () => {
    expect(ids(evalFilter(filterSnap(), { contextId: 'c2' }))).toEqual(['c']);
    expect(ids(evalFilter(filterSnap(), { maxMinutes: 20 }))).toEqual(['a', 'c']);
    expect(ids(evalFilter(filterSnap(), { noProject: true }))).toEqual(['a', 'c']);
    expect(ids(evalFilter(filterSnap(), { noProject: true, priorityMin: 4 }))).toEqual(['c']);
  });
});

describe('uc-filters CRUD', () => {
  it('createFilter:position 队尾递增;query 写入侧校验', () => {
    const snap = snapshot();
    const d = deps();
    const r1 = createFilter(snap, d, { name: '快事', query: { maxMinutes: 10 } });
    if ('error' in r1) throw new Error(r1.error);
    const cmd = r1.commands[0]!;
    if (cmd.kind !== 'createFilter') throw new Error('expected createFilter');
    expect(cmd.filter.position).toBe(0);
    // 非法值拒绝(INV-03 / INV-01 值域)
    expect(
      'error' in createFilter(snap, d, { name: 'x', query: { dueOnOrBefore: '2026-1-5' } }),
    ).toBe(true);
    expect('error' in createFilter(snap, d, { name: 'x', query: { energyMax: 'huge' } })).toBe(
      true,
    );
    expect('error' in createFilter(snap, d, { name: 'x', query: { priorityMin: 9 } })).toBe(true);
    expect('error' in createFilter(snap, d, { name: ' ', query: {} })).toBe(true);
  });

  it('updateFilter:不存在 → 错误;deleteFilter 幂等', () => {
    const snap = snapshot({
      filters: [{ id: 'f1', name: '旧', position: 0, query: {} }],
    });
    expect('error' in updateFilter(snap, deps(), { id: 'nope', patch: { name: '新' } })).toBe(true);
    const r = updateFilter(snap, deps(), { id: 'f1', patch: { name: '新' } });
    if ('error' in r) throw new Error(r.error);
    expect(r.commands).toEqual([{ kind: 'updateFilter', id: 'f1', patch: { name: '新' } }]);
    expect(ok(deleteFilter(snap, deps(), { id: 'f1' })).deleted).toBe(true);
    expect(ok(deleteFilter(snap, deps(), { id: 'nope' })).deleted).toBe(false);
  });
});

describe('uc-search searchAll:跨实体、大小写不敏感、含 done/complete', () => {
  const searchSnap = (): GtdSnapshot =>
    snapshot({
      tasks: [
        task({ id: 'ta', title: 'Buy milk' }),
        task({ id: 'td', title: 'buy tickets', status: 'done' }),
        task({ id: 'tx', title: 'call mom' }),
      ],
      projects: [
        project({ id: 'pa', outcome: 'Buy house', status: 'complete' }),
        project({ id: 'px', outcome: '装修厨房' }),
      ],
      inbox: [inboxItem({ id: 'i1', text: 'buy stamps' }), inboxItem({ id: 'i2', text: '想法' })],
      listItems: [
        { id: 's1', kind: 'someday', text: 'buy a boat', createdAt: '2026-08-01T00:00:00' },
        { id: 'r1', kind: 'reference', text: 'BUYing guide', createdAt: '2026-08-01T00:00:00' },
        { id: 'g1', kind: 'trash', text: 'old buy list', createdAt: '2026-08-01T00:00:00' },
        { id: 's2', kind: 'someday', text: '学钢琴', createdAt: '2026-08-01T00:00:00' },
      ],
      waiting: [
        waitingFor({ id: 'wa', description: 'BUY approval', delegatedTo: 'boss' }),
        waitingFor({ id: 'wb', description: '报销', delegatedTo: '老王' }),
      ],
    });

  it('query=buy → 各分组命中(tasks 含 done;projects 含 complete)', () => {
    const g = ok(searchAll(searchSnap(), deps(), { query: 'buy' }));
    expect(g.tasks.map((t) => t.id)).toEqual(['ta', 'td']);
    expect(g.projects.map((p) => p.id)).toEqual(['pa']);
    expect(g.inbox.map((i) => i.id)).toEqual(['i1']);
    expect(g.someday.map((i) => i.id)).toEqual(['s1']);
    expect(g.reference.map((i) => i.id)).toEqual(['r1']);
    expect(g.trash.map((i) => i.id)).toEqual(['g1']);
    expect(g.waiting.map((w) => w.id)).toEqual(['wa']);
  });

  it('中文查询、受托人命中、空查询报错', () => {
    const g = ok(searchAll(searchSnap(), deps(), { query: '厨房' }));
    expect(g.projects.map((p) => p.id)).toEqual(['px']);
    const byPerson = ok(searchAll(searchSnap(), deps(), { query: '老王' }));
    expect(byPerson.waiting.map((w) => w.id)).toEqual(['wb']);
    expect('error' in searchAll(searchSnap(), deps(), { query: '  ' })).toBe(true);
  });
});
