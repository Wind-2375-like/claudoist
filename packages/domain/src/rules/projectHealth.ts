import type { Id } from '../entities/common';
import type { GtdSnapshot } from '../ports/gtdStore';

/**
 * INV-05 ⚠SP:项目拥有 active next action ⟺ 按 projectId 全等存在
 * active Task ∨ 未解决 WaitingFor。(D-23/M6a:CalendarItem 并入 Task,
 * 带时间的承诺就是 active Task,原"未完成日历项"分支自然并入第一项。)
 * (D-21 后仅用于完成后果提示 INV-14,不再驱动孤儿徽章。)
 */
export function hasActiveNextAction(snap: GtdSnapshot, projectId: Id): boolean {
  return (
    snap.tasks.some((t) => t.projectId === projectId && t.status === 'active') ||
    snap.waiting.some((w) => w.projectId === projectId && !w.resolved)
  );
}
