import type { IsoDate, IsoTime } from '../entities/common';
import type { Task } from '../entities/task';
import type { GtdSnapshot } from '../ports/gtdStore';
import { byDayOrder } from './todayList';

/**
 * 日历网格规则(D-23/INV-28,M6b):把"带时间任务"投影成日历 block 的纯函数。
 * UI(周网格)与 CLI(calendar 命令)共用此口径,避免两处漂移。
 */

/**
 * 拖拽/拖选的吸附粒度:**5 分钟**(2026-08-10 用户改定,原为 15 分钟四等分)。
 * 拖动时看起来是连续的,松手吸附到 5 的倍数;更细的时刻(如 09:07)只能在任务详情里直接填。
 */
export const SNAP_MINUTES = 5;
/** 单击某一刻度创建的默认块长(用户定案:点 00 → 00-30)。 */
export const DEFAULT_BLOCK_MINUTES = 30;
export const MINUTES_PER_DAY = 1440;

/** `HH:MM` → 当日分钟数;非法输入回退 0(读取侧宽容,写入侧由 usecase 校验)。 */
export function minutesOfDay(time: IsoTime): number {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 当日分钟数 → `HH:MM`(钳到 0..1439)。 */
export function isoTimeFromMinutes(minutes: number): IsoTime {
  const m = Math.max(0, Math.min(MINUTES_PER_DAY - 1, Math.round(minutes)));
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 向下吸附到刻度(5 分钟)。 */
export function snapToQuarter(minutes: number): number {
  return Math.floor(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

/** block 时长:显式 durationMinutes 优先,否则回退 estimatedMinutes(≥1)。 */
export function blockMinutes(task: Task): number {
  const d = task.durationMinutes ?? task.estimatedMinutes;
  return Number.isInteger(d) && d >= 1 ? d : DEFAULT_BLOCK_MINUTES;
}

/** block 结束分钟(不跨午夜:钳到 24:00)。无 startTime 的任务返回 0。 */
export function blockEndMinutes(task: Task): number {
  if (task.startTime === null) return 0;
  return Math.min(MINUTES_PER_DAY, minutesOfDay(task.startTime) + blockMinutes(task));
}

/**
 * 拖选/单击区间 → 写入字段。start 向下吸附刻度,end 向上吸附;
 * 至少一个刻度(15 分钟),末端钳到 24:00(不跨天,INV-28)。
 */
export function blockFromRange(
  startMinutes: number,
  endMinutes: number,
): { startTime: IsoTime; durationMinutes: number } {
  const start = Math.max(0, Math.min(MINUTES_PER_DAY - SNAP_MINUTES, snapToQuarter(startMinutes)));
  const snappedEnd = Math.ceil(endMinutes / SNAP_MINUTES) * SNAP_MINUTES;
  const end = Math.max(start + SNAP_MINUTES, Math.min(MINUTES_PER_DAY, snappedEnd));
  return { startTime: isoTimeFromMinutes(start), durationMinutes: end - start };
}

/**
 * block 结束时刻的**展示串**:1440 = 当日 `24:00`(isoTimeFromMinutes 只能到 23:59,
 * 直接用它会把"到午夜"的块显示成 23:59,与同行的 ·60m 时长自相矛盾)。
 */
export function endTimeLabel(minutes: number): string {
  return minutes >= MINUTES_PER_DAY ? '24:00' : isoTimeFromMinutes(minutes);
}

/** 单击某刻度 → 默认 30 分钟块(末端钳到 24:00)。 */
export function blockFromClick(minutes: number): { startTime: IsoTime; durationMinutes: number } {
  const start = snapToQuarter(minutes);
  return blockFromRange(start, start + DEFAULT_BLOCK_MINUTES);
}

/**
 * 网格按下-拖动-松手的**统一判定**(INV-28):竖直位移不足一个刻度 = 单击
 * (默认 30 分钟),否则取拖选区间。渲染层不得 import 内层包(DESIGN §4.1),
 * 只能镜像本函数 —— 判定规则本身在此唯一定义,改动须同步镜像实现。
 */
export function blockFromDrag(
  fromMinutes: number,
  toMinutes: number,
): { startTime: IsoTime; durationMinutes: number } {
  const a = snapToQuarter(Math.min(fromMinutes, toMinutes));
  const b = Math.max(fromMinutes, toMinutes);
  return b - a < SNAP_MINUTES ? blockFromClick(a) : blockFromRange(a, b);
}

/**
 * 上日历的任务(INV-28):`scheduledDate` 命中该日、非 deleted、非 someday/reference
 * (孵化容器不占日程)。**done 任务仍在日历上**(显示为完成,不移除,D-23 用户定案)。
 */
export function isCalendarTask(t: Task, date: IsoDate): boolean {
  return (
    t.scheduledDate === date &&
    t.status !== 'deleted' &&
    t.bucket !== 'someday' &&
    t.bucket !== 'reference'
  );
}

/**
 * 全天段排序:与 Today 的未定时段同口径(INV-28.2)—— 即 `byDayOrder`(手排过的在前,
 * 其余按创建序兜底)。
 *
 * 这条曾经写死成 createdAt,理由是"sortOrder 只在同级组内有定义,跨容器比较会让别处的
 * 拖拽改变日历顺序"。那个理由对 `sortOrder` 成立、对 `dayOrder` **不成立**:dayOrder 就是
 * 为跨容器的 Today 列表定义的(D-40),它唯一的来源正是用户在 Today 里拖出来的序。
 * 继续用 createdAt 的后果是:在 Today 拖完,切到 Calendar 发现今天的全天条还是旧序 ——
 * 同一天的同一批任务,两个视图两个答案。
 */

const byStart = (a: Task, b: Task): number => {
  const am = minutesOfDay(a.startTime ?? '00:00');
  const bm = minutesOfDay(b.startTime ?? '00:00');
  if (am !== bm) return am - bm;
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  return 0;
};

/** 某日的日历内容:全天段(无 startTime)+ 定时段(有 startTime,按时刻序)。 */
export function calendarDay(snap: GtdSnapshot, date: IsoDate): { allDay: Task[]; timed: Task[] } {
  const on = snap.tasks.filter((t) => isCalendarTask(t, date));
  return {
    allDay: on.filter((t) => t.startTime === null).sort(byDayOrder),
    timed: on.filter((t) => t.startTime !== null).sort(byStart),
  };
}
