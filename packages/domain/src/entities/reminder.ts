import type { Id, Timestamp } from './common';

/**
 * 提醒(桌面新增,DESIGN §5.1):挂在一个任务上(D-23/M6a:CalendarItem 并入 Task 后
 * 不再有 calendarItemId 分支)。落库自 M5R;响铃调度 M6。
 */
export interface Reminder {
  id: Id;
  taskId: Id;
  /** 本地 naive `YYYY-MM-DDTHH:MM`(INV-03 纪律) */
  remindAt: string;
  dispatched: boolean;
  createdAt: Timestamp;
}
