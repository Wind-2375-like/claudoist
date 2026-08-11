import type { Energy, Id } from '../entities/common';
import type { Task } from '../entities/task';
import type { GtdSnapshot } from '../ports/gtdStore';
import { energyAllows } from './energy';

export const ENGAGE_TOP_N = 7;

/**
 * INV-20 的**全部**匹配项(不截断):指定 context 的 active Task,过滤
 * estimatedMinutes ≤ 可用分钟 ∧ energy ≤ 用户 energy(INV-02);priority 升序(1 = 最高,D-29)
 * 稳定排序(同优先级保持原序 = 创建序)。deadline 不参与排序。纯读。
 *
 * INV-20.2:今天已排期的任务(= {@link todaysTimedTasks})**不进候选** ——
 * 它们是已承诺的硬性日程,由 calendar-first 段单独先给,轮不到"挑";两处都列
 * 只会让同一条任务在一个面板里出现两次。
 *
 * 单独导出是为了让"另有 N 条未列出"的计数与候选来自同一处过滤 —— 调用方
 * (桌面 views.engage / CLI engage)不得自行重写这套条件。
 */
export function engageMatches(
  snap: GtdSnapshot,
  contextId: Id,
  availableMinutes: number,
  userEnergy: Energy,
  today: string,
): Task[] {
  const filtered = snap.tasks.filter(
    (t) =>
      t.status === 'active' &&
      // D-20:someday/reference 容器 = 孵化中,不参与择事
      t.bucket !== 'someday' &&
      t.bucket !== 'reference' &&
      t.contextId === contextId &&
      t.scheduledDate !== today &&
      t.estimatedMinutes <= availableMinutes &&
      energyAllows(t.energy, userEnergy),
  );
  return filtered
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.priority - b.t.priority || a.i - b.i)
    .map((x) => x.t);
}

/** INV-20:择事候选 = {@link engageMatches} 的前 {@link ENGAGE_TOP_N} 条。 */
export function engageCandidates(
  snap: GtdSnapshot,
  contextId: Id,
  availableMinutes: number,
  userEnergy: Energy,
  today: string,
): Task[] {
  return engageMatches(snap, contextId, availableMinutes, userEnergy, today).slice(0, ENGAGE_TOP_N);
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
