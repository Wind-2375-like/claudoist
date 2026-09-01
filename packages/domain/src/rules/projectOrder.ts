import type { Project } from '../entities/project';
import type { GtdSnapshot } from '../ports/gtdStore';

/**
 * 项目显示序(D-39/INV-37)。与子任务的 `rules/subtasks.ts` 同规,只是"同级组"退化成
 * "全部活跃项目"—— 项目是平面的(D-21),没有嵌套,所以只有一个组。
 *
 * **单一口径**:侧栏、My Projects 总览、CLI `projects`、agent 的 list_projects
 * 都用这里的比较器,谁也不许自己再排一遍(INV-20.6 同款纪律)。
 */

/** sortOrder 升序;createdAt 兜底,id 收尾 —— 保证全序且反对称(相等返回 0)。 */
export function byProjectSort(a: Project, b: Project): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 新建项目排到末尾(INV-27.1 的项目版)。空列表 → 0。 */
export function nextProjectSortOrder(snap: GtdSnapshot): number {
  const active = snap.projects.filter((p) => p.status === 'active');
  return active.length === 0 ? 0 : Math.max(...active.map((p) => p.sortOrder)) + 1;
}
