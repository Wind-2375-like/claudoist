import type { TaskView } from '@gtd/domain';

/**
 * 时间与地点上下文(M8 复测修定)。
 *
 * **为什么必须有**:此前只注入 `today`(一个日期)。于是 agent 看到一条"8/18 10:00 的会议"
 * 时,既不知道现在几点,也不知道 8/18 离今天多远 —— 实测它把下周的会议当成了"现在可以做
 * 的候选"并建议去完成。日期不够,**必须给它"此刻"以及每件事相对此刻有多远**。
 *
 * 地点:本仓不建模任务级 location(决策日志已定不做),这里给的是**时区与地区**——
 * 对排程而言这正是"空间"的可用近似(用户在哪个时区、几点算工作时间)。
 */

export interface TimeContext {
  /** 本地时刻 YYYY-MM-DDTHH:MM(naive,与全仓一致) */
  now: string;
  /** YYYY-MM-DD */
  today: string;
  /** 星期几(中文) */
  weekday: string;
  /** IANA 时区名,如 Asia/Shanghai */
  timeZone: string;
  /** UTC 偏移,如 +08:00 */
  utcOffset: string;
  /** 系统地区,如 zh-CN(用于推断日期书写习惯与工作日惯例) */
  locale: string;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const pad = (n: number): string => String(n).padStart(2, '0');

export function timeContext(d: Date = new Date()): TimeContext {
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return {
    now: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    today: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    weekday: WEEKDAYS[d.getDay()] ?? '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffset: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  };
}

/** 供每条用户消息前置的一行 —— 长会话里"此刻"会漂移,只在会话开头说一次不够。 */
export function nowLine(t: TimeContext = timeContext()): string {
  return `[此刻 ${t.now} ${t.weekday} · ${t.timeZone} (UTC${t.utcOffset}) · ${t.locale}]`;
}

/** 任务相对"此刻"的距离描述。null = 该任务没有计划日期。 */
export function relativeWhen(t: TaskView, ctx: TimeContext): string | null {
  if (t.scheduledDate === null) return null;
  const dayDiff = daysBetween(ctx.today, t.scheduledDate);
  if (t.startTime === null) {
    if (dayDiff === 0) return '今天(全天)';
    if (dayDiff === 1) return '明天(全天)';
    if (dayDiff === -1) return '昨天(全天,已过)';
    return dayDiff > 0 ? `${String(dayDiff)} 天后(全天)` : `${String(-dayDiff)} 天前(已过)`;
  }
  if (dayDiff === 0) {
    const mins = minutesOfDay(t.startTime) - minutesOfDay(ctx.now.slice(11));
    if (mins > 0) return `今天 ${t.startTime},还有 ${humanMinutes(mins)}`;
    const end = mins + (t.durationMinutes ?? t.estimatedMinutes);
    return end > 0
      ? `正在进行(${t.startTime} 开始)`
      : `今天 ${t.startTime},已过去 ${humanMinutes(-mins)}`;
  }
  if (dayDiff === 1) return `明天 ${t.startTime}`;
  if (dayDiff === -1) return `昨天 ${t.startTime}(已过)`;
  return dayDiff > 0
    ? `${String(dayDiff)} 天后(${t.scheduledDate} ${t.startTime})`
    : `${String(-dayDiff)} 天前(已过)`;
}

/** 截止日相对此刻的紧迫度。 */
export function relativeDeadline(t: TaskView, ctx: TimeContext): string | null {
  if (t.deadline === null) return null;
  const d = daysBetween(ctx.today, t.deadline);
  if (d === 0) return '今天截止';
  if (d === 1) return '明天截止';
  return d > 0 ? `${String(d)} 天后截止` : `已逾期 ${String(-d)} 天`;
}

/** 给 agent 工具输出用的装饰:在 TaskView 上补相对时间,免得它自己算日期差(常算错)。 */
export interface TimedTaskView extends TaskView {
  /** 相对此刻的计划时间,如"3 天后(2026-08-14 10:00)";无计划日期时为 null */
  when: string | null;
  /** 相对此刻的截止,如"已逾期 2 天";无截止日为 null */
  due: string | null;
}

export function withRelativeTime(t: TaskView, ctx: TimeContext): TimedTaskView {
  return { ...t, when: relativeWhen(t, ctx), due: relativeDeadline(t, ctx) };
}

// ------------------------------------------------------------------ 小工具

function daysBetween(fromIso: string, toIso: string): number {
  const [y1, m1, d1] = fromIso.split('-').map(Number);
  const [y2, m2, d2] = toIso.split('-').map(Number);
  const a = Date.UTC(y1 ?? 0, (m1 ?? 1) - 1, d1 ?? 1);
  const b = Date.UTC(y2 ?? 0, (m2 ?? 1) - 1, d2 ?? 1);
  return Math.round((b - a) / 86400000);
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function humanMinutes(mins: number): string {
  if (mins < 60) return `${String(mins)} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${String(h)} 小时` : `${String(h)} 小时 ${String(m)} 分钟`;
}
