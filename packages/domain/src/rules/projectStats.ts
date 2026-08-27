import type { Id } from '../entities/common';
import type { GtdSnapshot } from '../ports/gtdStore';

/** 项目统计(D-21):侧栏徽章与 My Projects 总览进度。 */

export interface ProjectStats {
  /** 未完成任务数(active,含子任务) */
  activeCount: number;
  /** 已完成任务数(done) */
  doneCount: number;
  /** done/(done+active),0–1;无任务时 0 */
  progress: number;
}

export function projectStats(snap: GtdSnapshot, projectId: Id): ProjectStats {
  let activeCount = 0;
  let doneCount = 0;
  for (const t of snap.tasks) {
    if (t.projectId !== projectId) continue;
    if (t.status === 'active') activeCount += 1;
    else if (t.status === 'done') doneCount += 1;
  }
  const total = activeCount + doneCount;
  return { activeCount, doneCount, progress: total === 0 ? 0 : doneCount / total };
}
