import type { Id, IsoDate, Timestamp } from './common';

/** INV-34:与 Task 同规的三态。`deleted` = 软删(可恢复),不是硬删。 */
export type ProjectStatus = 'active' | 'complete' | 'deleted';

/** 项目 = 期望成果;outcome 即名称(INVARIANTS §2.4)。平面列表(D-21,无 parentId);无 action_ids(D-08)。 */
export interface Project {
  id: Id;
  outcome: string;
  /** 继承规则 INV-10/INV-12(copy-on-create,仅流向行动) */
  deadline: IsoDate | null;
  status: ProjectStatus;
  createdAt: Timestamp;
  completedAt: Timestamp | null;
  /** INV-34:软删时刻;null = 不在回收站。与 Task.deletedAt 同语义(INV-22) */
  deletedAt: Timestamp | null;
}
