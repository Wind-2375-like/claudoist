import { describe, expect, it } from 'vitest';
import { createFilter, deleteFilter, updateFilter } from '../src/usecases/filters';
import { searchAll } from '../src/usecases/search';
import { isUsecaseError } from '../src/usecases/types';
import type { UsecaseResult } from '../src/usecases/types';
import type { GtdSnapshot } from '../src/index';
import { deps, project, snapshot, task, waitingFor } from './helpers';

function ok<C>(r: UsecaseResult<C>): C {
  if (isUsecaseError(r)) throw new Error(r.error);
  return r.consequences;
}

describe('uc-filters CRUD', () => {
  it('createFilter:position 队尾递增;query 写入侧校验', () => {
    const snap = snapshot();
    const d = deps();
    const r1 = createFilter(snap, d, { name: '快事', query: 'est: 10' });
    if ('error' in r1) throw new Error(r1.error);
    const cmd = r1.commands[0]!;
    if (cmd.kind !== 'createFilter') throw new Error('expected createFilter');
    expect(cmd.filter.position).toBe(0);
    // 非法值拒绝(INV-03 / INV-01 值域)
    expect('error' in createFilter(snap, d, { name: 'x', query: 'due before: 2026-1-5' })).toBe(
      true,
    );
    expect('error' in createFilter(snap, d, { name: 'x', query: 'energy: huge' })).toBe(true);
    expect('error' in createFilter(snap, d, { name: 'x', query: 'p9' })).toBe(true);
    expect('error' in createFilter(snap, d, { name: ' ', query: 'today' })).toBe(true);
  });

  it('updateFilter:不存在 → 错误;deleteFilter 幂等', () => {
    const snap = snapshot({
      filters: [{ id: 'f1', name: '旧', position: 0, query: 'today' }],
    });
    expect('error' in updateFilter(snap, deps(), { id: 'nope', patch: { name: '新' } })).toBe(true);
    const r = updateFilter(snap, deps(), { id: 'f1', patch: { name: '新' } });
    if ('error' in r) throw new Error(r.error);
    expect(r.commands).toEqual([{ kind: 'updateFilter', id: 'f1', patch: { name: '新' } }]);
    expect(ok(deleteFilter(snap, deps(), { id: 'f1' })).deleted).toBe(true);
    expect(ok(deleteFilter(snap, deps(), { id: 'nope' })).deleted).toBe(false);
  });
});

describe('INV-32 searchAll:容器模型口径、大小写不敏感、含 done 归档、软删不返回', () => {
  // D-20 后 Inbox/Someday/Reference 都是带 bucket 的 Task —— 全部落在 tasks 一组
  const searchSnap = (): GtdSnapshot =>
    snapshot({
      tasks: [
        task({ id: 'ta', title: 'Buy milk', createdAt: '2026-08-05T00:00:00' }),
        task({ id: 'td', title: 'buy tickets', status: 'done' }),
        task({ id: 'tgone', title: 'buy nothing', status: 'deleted' }),
        task({ id: 'tsome', title: 'buy a boat', bucket: 'someday' }),
        task({ id: 'tref', title: 'BUYing guide', bucket: 'reference' }),
        task({
          id: 'tdesc',
          title: '装修',
          description: '先去 buy 瓷砖',
          createdAt: '2026-08-04T00:00:00',
        }),
        task({ id: 'tx', title: 'call mom' }),
      ],
      projects: [
        project({ id: 'pa', outcome: 'Buy house', status: 'complete' }),
        project({ id: 'px', outcome: '装修厨房' }),
      ],
      waiting: [
        waitingFor({ id: 'wa', description: 'BUY approval', delegatedTo: 'boss' }),
        waitingFor({ id: 'wb', description: '报销', delegatedTo: '老王' }),
      ],
    });

  it('query=buy → someday/reference 任务也命中;done 归档在活跃之后;软删不返回', () => {
    const g = ok(searchAll(searchSnap(), deps(), { query: 'buy' }));
    // 活跃(标题命中,createdAt 倒序;同刻按 id)→ 活跃(仅描述命中)→ done;deleted 缺席
    expect(g.tasks.map((t) => t.id)).toEqual(['ta', 'tref', 'tsome', 'tdesc', 'td']);
    expect(g.tasks.map((t) => t.id)).not.toContain('tgone');
    expect(g.projects.map((p) => p.id)).toEqual(['pa']);
    expect(g.waiting.map((w) => w.id)).toEqual(['wa']);
    expect(g.totalMatched).toBe(7);
  });

  it('中文查询、描述命中、受托人命中、空查询报错', () => {
    const g = ok(searchAll(searchSnap(), deps(), { query: '厨房' }));
    expect(g.projects.map((p) => p.id)).toEqual(['px']);
    const byDesc = ok(searchAll(searchSnap(), deps(), { query: '瓷砖' }));
    expect(byDesc.tasks.map((t) => t.id)).toEqual(['tdesc']);
    const byPerson = ok(searchAll(searchSnap(), deps(), { query: '老王' }));
    expect(byPerson.waiting.map((w) => w.id)).toEqual(['wb']);
    expect('error' in searchAll(searchSnap(), deps(), { query: '  ' })).toBe(true);
  });

  it('limit 截断每类结果,totalMatched 仍为截断前总数', () => {
    const g = ok(searchAll(searchSnap(), deps(), { query: 'buy', limit: 2 }));
    expect(g.tasks).toHaveLength(2);
    expect(g.totalMatched).toBe(7);
  });
});
