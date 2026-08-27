import type { Id, Timestamp } from './common';

/** 收件箱条目:原文逐字保存,不解析不去重(INV-16);FIFO 用 position(INV-17)。 */
export interface InboxItem {
  id: Id;
  text: string;
  createdAt: Timestamp;
  position: number;
}
