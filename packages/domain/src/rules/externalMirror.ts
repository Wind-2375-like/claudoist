import type { Id, IsoDate, IsoTime } from '../entities/common';
import type { Task } from '../entities/task';
import type { GtdSnapshot } from '../ports/gtdStore';

/**
 * 外部日历镜像规则(D-25/INV-29,M6c-3a)。
 *
 * 用户定案(2026-08-10):外部日历事件**就是任务** —— 能完成、能加标签/备注/子任务,
 * 与普通任务一视同仁;**唯独时间(与标题)归外部拥有**,不能在本地改期;所有本地操作
 * **永不回写** Google。因此镜像任务是"半只读"的:时间字段只由同步写,其余本地自治。
 */

/** 稳定镜像键:同一事件在任何一次同步里都映射到同一个本地任务。 */
export function externalKey(
  provider: 'google',
  accountEmail: string,
  calendarId: string,
  eventId: string,
): string {
  return `${provider}:${accountEmail}:${calendarId}:${eventId}`;
}

/** 是否为外部镜像任务(时间不可本地修改)。 */
export function isExternalTask(t: Task): boolean {
  return t.externalId !== null;
}

/** 外部拥有、本地不可改的字段(INV-29)。 */
export const EXTERNAL_OWNED_FIELDS = [
  'title',
  'scheduledDate',
  'startTime',
  'durationMinutes',
] as const;

/** 同步输入:一条外部事件在某窗口内的当前样子。 */
export interface ExternalEventInput {
  externalId: string;
  externalCalendarId: Id;
  title: string;
  scheduledDate: IsoDate;
  startTime: IsoTime | null;
  durationMinutes: number | null;
}

/** 快照里所有镜像任务(含 done;不含已软删)。 */
export function externalTasks(snap: GtdSnapshot): Task[] {
  return snap.tasks.filter((t) => t.externalId !== null && t.status !== 'deleted');
}

/** 所有带 externalId 的任务(**含已软删**):同步 upsert 必须按此去重,external_id 唯一。 */
export function externalKeyTasks(snap: GtdSnapshot): Task[] {
  return snap.tasks.filter((t) => t.externalId !== null);
}

/**
 * 推送到专用 `Claudoist` 日历的口径(D-26/INV-30,M6c-3b):
 * **已排期(scheduledDate 非空)且非外部镜像、非删除**的任务。带 startTime 的推成定时事件,
 * 否则推成全天事件。已完成的任务**仍留在日历上**(标题前缀 ✓),只是不再占用注意力 ——
 * 用户定案:完成不从日历删除。
 */
export function shouldPush(t: Task): boolean {
  return (
    t.externalId === null &&
    t.status !== 'deleted' &&
    t.scheduledDate !== null &&
    // 孵化容器不占日程(与 Today/Calendar 口径一致,INV-21/INV-28);
    // 否则 someday 里带日期的任务不在应用内日历上、却被推到了 Google
    t.bucket !== 'someday' &&
    t.bucket !== 'reference'
  );
}

/** 推送用的块长:与应用内 `blockMinutes` 同一回退(estimatedMinutes),避免回拉后块长凭空变大。 */
export function pushMinutes(t: Task): number {
  const d = t.durationMinutes ?? t.estimatedMinutes;
  return Number.isInteger(d) && d >= 1 ? d : 30;
}

/** 推送内容指纹:变了才调 API(避免每轮同步把整张日历重写一遍)。 */
export function pushFingerprint(t: Task): string {
  return [
    t.title,
    t.scheduledDate ?? '',
    t.startTime ?? '',
    String(t.durationMinutes ?? ''),
    t.timeZone ?? 'floating',
    t.status,
  ].join('|');
}
