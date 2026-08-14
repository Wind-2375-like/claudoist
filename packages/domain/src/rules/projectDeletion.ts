import type { Id } from '../entities/common';
import type { GtdSnapshot } from '../ports/gtdStore';

/**
 * 删除项目的**预检口径**(INV-34)。
 *
 * 为什么单独成一条规则而不是让各处自己数:确认对话框上写的数字、usecase 返回的
 * consequences、CLI 的提示、agent 报给用户的数,**必须是同一口径**。各数各的迟早出现
 * "确认时说 12 条、做完 toast 说 9 条" —— 那会直接摧毁用户对确认框的信任。
 * 这与 INV-20.6 / INV-32.6 / INV-33.9 是同一条纪律。
 *
 * 纯读,零副作用。
 */
export interface ProjectDeletionPreview {
  /** 项目下的活跃任务(含子任务) */
  activeTaskCount: number;
  /** 已完成的任务:**留在项目里不动**,完成记录不该被删除抹掉(与 INV-26.2 同源) */
  doneTaskCount: number;
  /** 已经在回收站里的任务:本次不重复标记 */
  alreadyDeletedTaskCount: number;
  /** 活跃任务里来自外部日历的镜像数(INV-29:它们的去向由外部决定,不本地删) */
  mirrorTaskCount: number;
  /** 仍指向本项目的未解决等待项:本次**不动**,但必须向用户点明(INV-05) */
  unresolvedWaitingCount: number;
  /** 活跃任务里循环任务的当前一次(INV-36.11:软删 = 结束系列,确认文案必须点明) */
  recurringTaskCount: number;
}

export function projectDeletionPreview(snap: GtdSnapshot, projectId: Id): ProjectDeletionPreview {
  const mine = snap.tasks.filter((t) => t.projectId === projectId);
  const active = mine.filter((t) => t.status === 'active');
  return {
    activeTaskCount: active.length,
    doneTaskCount: mine.filter((t) => t.status === 'done').length,
    alreadyDeletedTaskCount: mine.filter((t) => t.status === 'deleted').length,
    mirrorTaskCount: active.filter((t) => t.externalId !== null).length,
    recurringTaskCount: active.filter((t) => t.repeat !== null).length,
    unresolvedWaitingCount: snap.waiting.filter((w) => w.projectId === projectId && !w.resolved)
      .length,
  };
}
