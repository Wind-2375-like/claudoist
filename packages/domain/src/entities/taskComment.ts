import type { Id, Timestamp } from './common';

/** 任务评论(D-21):详情弹窗内仅追加展示,不参与任何不变量计算(INVARIANTS §2.9)。 */
export interface TaskComment {
  id: Id;
  taskId: Id;
  body: string;
  createdAt: Timestamp;
}
