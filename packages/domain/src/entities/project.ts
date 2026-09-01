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
  /**
   * 手动排序(D-39/INV-37):侧栏与 My Projects 的显示序。与 Task.sortOrder 同规
   * (INV-27):新建追加到末尾、拖拽后整组重编号 0..N-1、createdAt 兜底保证反对称。
   * **必填不可省** —— 写成可选的话构造点漏了 tsc 不报,项目会静默跑到列表最前面。
   */
  sortOrder: number;
}
