import type { IsoDate, Timestamp } from '../entities/common';

/** 时间 port:domain 永不直接读系统时钟。 */
export interface Clock {
  now(): Timestamp;
  /** 今天的本地 YYYY-MM-DD("today" 判定 = 与此值全等,INV-03) */
  today(): IsoDate;
}
