import { describe, expect, it } from 'vitest';
import { moveTask } from '../src/usecases/tasks';
import { engageCandidates } from '../src/rules/engageRanking';
import { applyToSnapshot } from '../src/index';
import { isUsecaseError } from '../src/usecases/types';
import { ctx, deps, project, snapshot, task } from './helpers';

/**
 * INV-21 ⚠SP(D-20/D-21 修订):someday/reference = 孵化容器 ——
 * 不入 Today/engage;激活 = 用户显式 moveTask 到任意其他容器,移动后立即恢复参与。
 * 系统永不自动移出。
 */
describe('INV-21 Someday 孵化语义(bucket 容器)', () => {
  const base = snapshot({
    contexts: [ctx({ id: 'c1' })],
    projects: [project({ id: 'p1' })],
    tasks: [
      task({ id: 't1', contextId: 'c1', bucket: 'someday' }),
      task({ id: 't2', contextId: 'c1', bucket: 'reference' }),
      task({ id: 't3', contextId: 'c1', bucket: 'inbox' }),
    ],
  });

  it('someday/reference 不进 engage 候选;inbox 进', () => {
    const got = engageCandidates(base, 'c1', 60, 'high');
    expect(got.map((t) => t.id)).toEqual(['t3']);
  });

  it('激活 = move 回 inbox → 恢复参与一切口径', () => {
    const r = moveTask(base, deps(), { id: 't1', to: { bucket: 'inbox' } });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(base, r.commands);
    expect(after.tasks.find((t) => t.id === 't1')!.bucket).toBe('inbox');
    expect(
      engageCandidates(after, 'c1', 60, 'high')
        .map((t) => t.id)
        .sort(),
    ).toEqual(['t1', 't3']);
  });

  it('激活也可以直接进项目(D-20:移到哪都行,移动本身就是理清)', () => {
    const r = moveTask(base, deps(), { id: 't1', to: { bucket: 'project', projectId: 'p1' } });
    if (isUsecaseError(r)) throw new Error(r.error);
    const after = applyToSnapshot(base, r.commands);
    const t = after.tasks.find((x) => x.id === 't1')!;
    expect(t.bucket).toBe('project');
    expect(t.projectId).toBe('p1');
  });
});
