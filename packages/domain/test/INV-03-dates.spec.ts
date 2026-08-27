import { describe, expect, it } from 'vitest';
import { compareCalendar, isSuspectDate, isValidIsoDate, isValidIsoTime } from '../src/index';

describe('INV-03 日期:写入严格,读取宽容(BUG-05 零校验防复刻)', () => {
  it('写入校验拒绝未补零/非法日期', () => {
    expect(isValidIsoDate('2026-1-5')).toBe(false);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('2026-08-08')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true); // 闰年
  });

  it('时间校验 HH:MM', () => {
    expect(isValidIsoTime('09:30')).toBe(true);
    expect(isValidIsoTime('24:00')).toBe(false);
    expect(isValidIsoTime('9:30')).toBe(false);
  });

  it('读取路径:坏值标记"需修正",排序不崩溃', () => {
    expect(isSuspectDate('2026-1-5')).toBe(true);
    const sorted = [
      { date: '2026-1-5', time: null },
      { date: '2026-08-08', time: '09:00' },
      { date: '2026-08-08', time: null },
    ].sort(compareCalendar);
    // 字典序参与排序,同日全天在前
    expect(sorted.map((x) => `${x.date}|${x.time ?? ''}`)).toEqual([
      '2026-08-08|',
      '2026-08-08|09:00',
      '2026-1-5|',
    ]);
  });
});
