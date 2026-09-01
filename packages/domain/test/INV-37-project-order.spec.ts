import { describe, expect, it } from 'vitest';
import type { Project } from '../src/index';
import {
  applyToSnapshot,
  byProjectSort,
  createProjectDirect,
  nextProjectSortOrder,
  reorderProject,
} from '../src/index';
import { deps, project, snapshot } from './helpers';

/**
 * INV-37 项目手动排序(D-39)。与 INV-27(任务 sortOrder)同规,只是"同级组"退化成
 * "全部活跃项目"—— 项目是平面的(D-21)。
 */

const order = (snap: ReturnType<typeof snapshot>): string[] =>
  snap.projects
    .filter((p) => p.status === 'active')
    .sort(byProjectSort)
    .map((p) => p.outcome);

const move = (
  snap: ReturnType<typeof snapshot>,
  id: string,
  beforeId?: string,
): ReturnType<typeof snapshot> => {
  const r = reorderProject(snap, deps(), beforeId === undefined ? { id } : { id, beforeId });
  if ('error' in r) throw new Error(r.error);
  return applyToSnapshot(snap, r.commands);
};

const three = (): { snap: ReturnType<typeof snapshot>; a: Project; b: Project; c: Project } => {
  const a = project({ outcome: 'A', sortOrder: 0 });
  const b = project({ outcome: 'B', sortOrder: 1 });
  const c = project({ outcome: 'C', sortOrder: 2 });
  return { snap: snapshot({ projects: [a, b, c] }), a, b, c };
};

describe('INV-37.1 显示序与新建位置', () => {
  it('byProjectSort:sortOrder 升序;相等时 createdAt 兜底;全等返回 0(反对称)', () => {
    const x = project({ outcome: 'X', sortOrder: 1, createdAt: '2026-01-02T00:00:00' });
    const y = project({ outcome: 'Y', sortOrder: 1, createdAt: '2026-01-01T00:00:00' });
    expect([x, y].sort(byProjectSort).map((p) => p.outcome)).toEqual(['Y', 'X']);
    expect(byProjectSort(x, x)).toBe(0);
  });

  it('新建项目排到末尾;空库从 0 开始', () => {
    expect(nextProjectSortOrder(snapshot())).toBe(0);
    const { snap } = three();
    expect(nextProjectSortOrder(snap)).toBe(3);
    const r = createProjectDirect(snap, deps(), { outcome: 'D' });
    if ('error' in r) throw new Error(r.error);
    const created = (r.commands[0] as { project: Project }).project;
    expect(created.sortOrder).toBe(3);
    expect(order(applyToSnapshot(snap, r.commands))).toEqual(['A', 'B', 'C', 'D']);
  });

  it('已完成/已删除的项目不占位:计数只看活跃', () => {
    const snap = snapshot({
      projects: [
        project({ outcome: 'A', sortOrder: 0 }),
        project({ outcome: '老项目', sortOrder: 9, status: 'complete', completedAt: 'x' }),
      ],
    });
    expect(nextProjectSortOrder(snap)).toBe(1);
    expect(order(snap)).toEqual(['A']);
  });
});

describe('INV-37.2 拖拽重排', () => {
  it('拖到最前 / 中间 / 末尾', () => {
    const { snap, c, a } = three();
    expect(order(move(snap, c.id, a.id))).toEqual(['C', 'A', 'B']); // C 到最前
    const { snap: s2, a: a2, c: c2 } = three();
    expect(order(move(s2, a2.id, c2.id))).toEqual(['B', 'A', 'C']); // A 插到 C 之前
    const { snap: s3, a: a3 } = three();
    expect(order(move(s3, a3.id))).toEqual(['B', 'C', 'A']); // 省略 beforeId = 末尾
  });

  it('重排后整组重编号 0..N-1(稠密,不会号段耗尽)', () => {
    const a = project({ outcome: 'A', sortOrder: 100 });
    const b = project({ outcome: 'B', sortOrder: 250 });
    const snap = snapshot({ projects: [a, b] });
    const after = move(snap, b.id, a.id);
    expect(after.projects.map((p) => p.sortOrder).sort()).toEqual([0, 1]);
    expect(order(after)).toEqual(['B', 'A']);
  });

  it('拖回原位 = 零命令(工具层据此回报 changed:false)', () => {
    const { snap, a, b } = three();
    for (const input of [
      { id: a.id, beforeId: b.id },
      { id: a.id, beforeId: a.id },
    ]) {
      const r = reorderProject(snap, deps(), input);
      if ('error' in r) throw new Error(r.error);
      expect(r.commands).toEqual([]);
    }
  });

  it('只发真的变了的行:C 拖到最前只动 3 条里需要动的那些,不整表重写', () => {
    const { snap, c, a } = three();
    const r = reorderProject(snap, deps(), { id: c.id, beforeId: a.id });
    if ('error' in r) throw new Error(r.error);
    // A:0→1、B:1→2、C:2→0,三条都真的变了
    expect(r.commands).toHaveLength(3);
    const d = project({ outcome: 'D', sortOrder: 3 });
    const snap2 = applyToSnapshot(snapshot({ projects: [...snap.projects, d] }), []);
    const r2 = reorderProject(snap2, deps(), { id: d.id }); // 省略 = 末尾
    if ('error' in r2) throw new Error(r2.error);
    expect(r2.commands).toEqual([]); // D 本来就在末尾
  });

  it('守卫:项目不存在 / 非活跃 / beforeId 不是活跃项目 → 报错', () => {
    const { snap, a } = three();
    expect(reorderProject(snap, deps(), { id: 'ghost' })).toHaveProperty('error');
    const doneP = project({ outcome: '完成的', status: 'complete', completedAt: 'x' });
    const s2 = snapshot({ projects: [...snap.projects, doneP] });
    expect(reorderProject(s2, deps(), { id: doneP.id })).toHaveProperty('error');
    expect(reorderProject(s2, deps(), { id: a.id, beforeId: doneP.id })).toHaveProperty('error');
  });

  it('完成/删除的项目不被重编号波及(恢复后仍按 createdAt 落在合理位置)', () => {
    const gone = project({ outcome: '回收站', sortOrder: 7, status: 'deleted', deletedAt: 'x' });
    const { snap, c, a } = three();
    const s2 = snapshot({ projects: [...snap.projects, gone] });
    const after = move(s2, c.id, a.id);
    expect(after.projects.find((p) => p.id === gone.id)!.sortOrder).toBe(7);
  });
});
