import type { Id, IsoDate } from '../entities/common';
import type { GtdSnapshot } from '../ports/gtdStore';

/**
 * INV-10:行动级继承 —— 项目有 deadline 时,新行动无条件获得其副本(静默,
 * 不询问、不提供改填入口)。返回 null 表示"应询问行动自己的 deadline"。
 */
export function inheritedTaskDeadline(snap: GtdSnapshot, projectId: Id | null): IsoDate | null {
  if (projectId === null) return null;
  return snap.projects.find((p) => p.id === projectId)?.deadline ?? null;
}

/**
 * INV-12(D-21 收窄到行动):编辑项目 deadline 时,一次性提示的对象 =
 * "deadline 与项目旧值相同"的 active 行动。
 */
export function tasksWithInheritedDeadline(
  snap: GtdSnapshot,
  projectId: Id,
  oldDeadline: IsoDate | null,
): Id[] {
  if (oldDeadline === null) return [];
  return snap.tasks
    .filter((t) => t.projectId === projectId && t.status === 'active' && t.deadline === oldDeadline)
    .map((t) => t.id);
}
