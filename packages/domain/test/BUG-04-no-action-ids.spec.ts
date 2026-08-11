import { describe, expect, it } from 'vitest';
import { hasActiveNextAction, statusSummary } from '../src/index';
import { deps, project, snapshot, task } from './helpers';

/**
 * BUG-04 防复刻:Project 不存在 action_ids 簿记;"项目的行动"只能来自按
 * projectId 的查询。BUG-03(8 位截断 id)由 INV-04 spec 覆盖;BUG-05(日期
 * 零校验)由 INV-03 spec 覆盖。
 */
describe('BUG-04 防复刻:无 action_ids,一切按 projectId 扫描', () => {
  it('Project 实体不携带任何 id 列表字段', () => {
    const p = project({ id: 'p1' });
    expect(Object.keys(p)).not.toContain('actionIds');
    expect(Object.keys(p)).not.toContain('action_ids');
  });

  it('项目活动判定只随 projectId 关联变化(无幽灵行动可能)', () => {
    const p = project({ id: 'p1' });
    const t = task({ id: 't1', projectId: 'p1' });
    expect(hasActiveNextAction(snapshot({ projects: [p], tasks: [t] }), 'p1')).toBe(true);
    // 行动改挂别的项目后,p1 立即无活动 —— 不存在残留引用
    expect(
      hasActiveNextAction(snapshot({ projects: [p], tasks: [{ ...t, projectId: 'other' }] }), 'p1'),
    ).toBe(false);
  });

  it('状态汇总的项目分组同样按 projectId 派生', () => {
    const p = project({ id: 'p1' });
    const snap = snapshot({ projects: [p], tasks: [task({ projectId: 'p1' })] });
    const summary = statusSummary(snap, deps(), {});
    expect(JSON.stringify(summary)).not.toContain('actionIds');
  });
});
