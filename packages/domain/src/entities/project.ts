import type { Id, IsoDate, Timestamp } from './common';

export type ProjectStatus = 'active' | 'complete';

/** 项目 = 期望成果;outcome 即名称(INVARIANTS §2.4)。平面列表(D-21,无 parentId);无 action_ids(D-08)。 */
export interface Project {
  id: Id;
  outcome: string;
  /** 继承规则 INV-10/INV-12(copy-on-create,仅流向行动) */
  deadline: IsoDate | null;
  status: ProjectStatus;
  createdAt: Timestamp;
  completedAt: Timestamp | null;
}
