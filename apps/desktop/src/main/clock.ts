import type { Clock } from '@gtd/domain';

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本地 naive 时间(INV-03:today 判定 = 本地日期字符串全等;不用 UTC)。 */
export const systemClock: Clock = {
  now(): string {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },
  today(): string {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },
};
