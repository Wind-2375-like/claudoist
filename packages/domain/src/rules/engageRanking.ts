import type { Energy, Id } from '../entities/common';
import type { Task } from '../entities/task';
import type { GtdSnapshot } from '../ports/gtdStore';
import { energyAllows } from './energy';

export const ENGAGE_TOP_N = 7;

/**
 * INV-20:候选 = 指定 context 的 active Task,过滤 estimatedMinutes ≤ 可用分钟
 * ∧ energy ≤ 用户 energy(INV-02);priority 降序稳定排序(同优先级保持原序 =
 * 创建序);最多 7 条。deadline 不参与排序。纯读。
 */
export function engageCandidates(
  snap: GtdSnapshot,
  contextId: Id,
  availableMinutes: number,
  userEnergy: Energy,
): Task[] {
  const filtered = snap.tasks.filter(
    (t) =>
      t.status === 'active' &&
      // D-20:someday/reference 容器 = 孵化中,不参与择事
      t.bucket !== 'someday' &&
      t.bucket !== 'reference' &&
      t.contextId === contextId &&
      t.estimatedMinutes <= availableMinutes &&
      energyAllows(t.energy, userEnergy),
  );
  return filtered
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.priority - a.t.priority || a.i - b.i)
    .slice(0, ENGAGE_TOP_N)
    .map((x) => x.t);
}

/**
 * INV-20.1 calendar-first(D-23/M6a 版):今天计划的 active 任务按时间序 ——
 * 无时间(全天)在前,再按 startTime 升序(沿 §2.5 原日历排序语义)。
 */
export function todaysTimedTasks(snap: GtdSnapshot, today: string): Task[] {
  return snap.tasks
    .filter(
      (t) =>
        t.status === 'active' &&
        t.bucket !== 'someday' &&
        t.bucket !== 'reference' &&
        t.scheduledDate === today,
    )
    .sort((a, b) => {
      if ((a.startTime === null) !== (b.startTime === null)) return a.startTime === null ? -1 : 1;
      if (a.startTime !== b.startTime) return (a.startTime ?? '') < (b.startTime ?? '') ? -1 : 1;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
}
