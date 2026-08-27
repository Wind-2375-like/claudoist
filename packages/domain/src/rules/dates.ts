/** INV-03:写入侧严格校验,读取侧宽容。 */

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidIsoTime(s: string): boolean {
  return TIME_RE.test(s);
}

/**
 * ISO 日期(YYYY-MM-DD)加 n 天。UTC 计算,避免本地时区/DST 把结果推到相邻日
 * (INV-03 naive 日期口径:日期串只做日历运算,不带时刻)。
 * **读取侧宽容**:非法日期串原样返回,不抛异常 —— 曾因 `new Date(NaN).toISOString()`
 * 抛 RangeError 让 CLI `calendar --from=abc` 崩栈,且 `2026-13-45` 之类静默滚月。
 * 调用方若需要拒绝非法输入,应先 isValidIsoDate 并给出可读错误。
 */
export function addDaysIso(iso: string, n: number): string {
  if (!isValidIsoDate(iso)) return iso;
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** 读取路径的"需修正"标记(不崩溃、字典序排序照旧)。 */
export function isSuspectDate(s: string): boolean {
  return !isValidIsoDate(s);
}

/**
 * 日历排序:date 升序,同日全天在前,再按 time 升序(INVARIANTS §2.5)。
 * D-23/M6a 后 CalendarItem 实体退役,src 内无消费者;保留作 §2.5 时刻序的
 * 参照实现(Today/engage 的"全天在前、startTime 升序"沿用同一语义)。
 */
export function compareCalendar(
  a: { date: string; time: string | null },
  b: { date: string; time: string | null },
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if ((a.time === null) !== (b.time === null)) return a.time === null ? -1 : 1;
  if (a.time === b.time) return 0;
  return (a.time ?? '') < (b.time ?? '') ? -1 : 1;
}

/**
 * IANA 时区名是否有效(D-27/INV-31)。用运行时自带的 Intl 数据判定,不额外引依赖。
 * `null` 表示浮动时间,由调用方处理,不进这里。
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
