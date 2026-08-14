import type { Id } from '../entities/common';
import type { GtdSnapshot } from '../ports/gtdStore';
import { foldKeyOf } from './seriesFold';

/** 项目统计(D-21):侧栏徽章与 My Projects 总览进度。 */

export interface ProjectStats {
  /** 未完成任务数(active,含子任务;循环系列按 INV-36.14 折叠计数) */
  activeCount: number;
  /** 已完成任务数(done;循环系列折叠计数) */
  doneCount: number;
  /** done/(done+active),0–1;无任务时 0 */
  progress: number;
}

/**
 * INV-36.14(2026-08-13 用户拍板):循环系列按折叠组计数 —— 项目进度回答的是
 * "这摊**有限的**活干了多少",循环任务不是有限的活,把每一次计入分子/分母是范畴错误
 * (一个每日循环一年灌 365 条 done,进度条被推到接近 1 并永远卡在那)。
 *
 * 折叠组(键见 seriesFold.foldKeyOf)有 active → 计 1 active;全 done → 计 1 done
 * (系列结束了,作为"一件事"记一笔)。不含循环的项目数字**逐字不变**(零回归)。
 */
export function projectStats(snap: GtdSnapshot, projectId: Id): ProjectStats {
  let activeCount = 0;
  let doneCount = 0;
  const groups = new Map<string, { active: boolean; done: boolean }>();
  for (const t of snap.tasks) {
    if (t.projectId !== projectId || t.status === 'deleted') continue;
    const key = foldKeyOf(snap, t);
    if (key === null) {
      if (t.status === 'active') activeCount += 1;
      else doneCount += 1;
      continue;
    }
    const g = groups.get(key) ?? { active: false, done: false };
    if (t.status === 'active') g.active = true;
    else g.done = true;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.active) activeCount += 1;
    else if (g.done) doneCount += 1;
  }
  const total = activeCount + doneCount;
  return { activeCount, doneCount, progress: total === 0 ? 0 : doneCount / total };
}
