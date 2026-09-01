import type { Id, IsoDate, IsoTime } from '../entities/common';
import type { Task } from '../entities/task';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import { pushFingerprint, pushMinutes, shouldPush } from '../rules/externalMirror';
import type { UsecaseResult } from './types';

/**
 * 任务 → 专用 `Claudoist` 日历的推送计划,以及 Google 侧改动的回同步(D-26/INV-30,M6c-3b)。
 *
 * 纪律:domain 不发网络请求。这里只**算计划**(该建/该改/该删哪些事件)与**记账**
 * (推送成功后写回 pushedEventId/pushedFingerprint),真正的 API 调用在主进程。
 */

// ------------------------------------------------------------------ 推送计划

export interface PushPlanItem {
  taskId: Id;
  /** 已有事件 → patch;为空 → insert */
  eventId: string | null;
  title: string;
  date: IsoDate;
  startTime: IsoTime | null;
  durationMinutes: number | null;
  /** null = 浮动时间(推送时不指定时区,由日历默认时区解释) */
  timeZone: string | null;
  done: boolean;
  fingerprint: string;
}

export interface PushPlan {
  upsert: PushPlanItem[];
  /** 不再该出现在日历上的事件(任务被删除/取消排期)→ 删事件并清账 */
  remove: { taskId: Id; eventId: string }[];
}

/** 纯读:算出需要推送/撤下的事件(指纹未变的任务不入计划)。 */
export function planPush(snap: GtdSnapshot): PushPlan {
  const upsert: PushPlanItem[] = [];
  const remove: { taskId: Id; eventId: string }[] = [];
  for (const t of snap.tasks) {
    if (t.externalId !== null) continue; // 镜像任务永不回推(INV-29)
    if (shouldPush(t)) {
      const fingerprint = pushFingerprint(t);
      if (t.pushedEventId !== null && t.pushedFingerprint === fingerprint) continue;
      upsert.push({
        taskId: t.id,
        eventId: t.pushedEventId,
        title: t.title,
        date: t.scheduledDate!,
        startTime: t.startTime,
        durationMinutes: pushMinutes(t),
        timeZone: t.timeZone,
        done: t.status === 'done',
        fingerprint,
      });
    } else if (t.pushedEventId !== null) {
      remove.push({ taskId: t.id, eventId: t.pushedEventId });
    }
  }
  return { upsert, remove };
}

/** 推送成功后的记账(把 eventId/指纹写回任务)。 */
export function recordPushed(
  results: { taskId: Id; eventId: string | null; fingerprint: string | null }[],
): Command[] {
  return results.map((r) => ({
    kind: 'updateTask' as const,
    id: r.taskId,
    patch: { pushedEventId: r.eventId, pushedFingerprint: r.fingerprint },
  }));
}

// ------------------------------------------------------------------ 回同步

export interface PulledEvent {
  eventId: string;
  /** 事件上带的本地任务 id(extendedProperties.private.claudoistTaskId) */
  taskId: Id | null;
  /** 事件已被删除/取消 */
  cancelled: boolean;
  date: IsoDate | null;
  startTime: IsoTime | null;
  durationMinutes: number | null;
}

export interface ApplyPulledConsequences {
  rescheduled: number;
  deleted: number;
}

/**
 * 把专用日历上的改动应用回任务(INV-30):
 * - 事件被移动/改长 → 任务改期(时间以 Google 为准 —— 用户就是在那边拖的);
 * - 事件被删除 → **软删任务**(用户定案:在日历里删 block 才传播删除);
 * - **已完成的任务不因日历改动而复活**,也不改期(完成即收尾)。
 */
export function applyPulledEvents(
  snap: GtdSnapshot,
  deps: FlowDeps,
  events: PulledEvent[],
): UsecaseResult<ApplyPulledConsequences> {
  const byPushed = new Map<string, Task>();
  for (const t of snap.tasks) {
    if (t.pushedEventId !== null) byPushed.set(t.pushedEventId, t);
  }
  const commands: Command[] = [];
  let rescheduled = 0;
  let deleted = 0;

  for (const ev of events) {
    const task =
      byPushed.get(ev.eventId) ??
      (ev.taskId !== null ? snap.tasks.find((t) => t.id === ev.taskId) : undefined);
    if (!task || task.externalId !== null) continue;
    if (task.status === 'deleted') continue;
    // 本地有**尚未推送成功**的改动(指纹与已推送的不一致)→ 本轮本地优先,
    // 不接受 Google 的旧值。否则一次推送失败就会让旧值把用户的改期永久覆盖回去。
    if (task.pushedFingerprint !== null && pushFingerprint(task) !== task.pushedFingerprint) {
      continue;
    }

    if (ev.cancelled) {
      // 日历上删掉 block = 删任务(已完成的保留作历史,只清账)
      if (task.status === 'done') {
        commands.push({
          kind: 'updateTask',
          id: task.id,
          patch: { pushedEventId: null, pushedFingerprint: null },
        });
        continue;
      }
      commands.push({
        kind: 'updateTask',
        id: task.id,
        patch: {
          status: 'deleted',
          deletedAt: deps.clock.now(),
          pushedEventId: null,
          pushedFingerprint: null,
        },
      });
      deleted += 1;
      continue;
    }

    if (task.status === 'done') continue; // 完成的不再改期
    if (ev.date === null) continue;
    const patch: Partial<Omit<Task, 'id'>> = {};
    if (task.scheduledDate !== ev.date) patch.scheduledDate = ev.date;
    if (task.startTime !== ev.startTime) patch.startTime = ev.startTime;
    if (ev.durationMinutes !== null && task.durationMinutes !== ev.durationMinutes) {
      patch.durationMinutes = ev.durationMinutes;
    }
    if (Object.keys(patch).length === 0) continue;
    // INV-38.4:这里是**第二个**绕过 updateTask、直接构造 updateTask 命令改
    // scheduledDate 的写入口(第一个是 externalSync),失效规则必须自己带一份。
    // 处理的恰恰是本地任务(镜像任务在上面被 continue 掉),也就是能进 Today、能被拖、
    // 会有 dayOrder 的那一类。漏掉的后果:在 Google 里把 block 拖到别的一天再拖回来,
    // 任务会带着旧的 dayOrder 插回队首(甚至与别人撞号插进队伍中间)。
    // 上面每个字段都已经判过"值真的变了"才进 patch,所以这里只要判 key 就够。
    // 只判计划日、不判时刻(D-41)
    if (patch.scheduledDate !== undefined && task.dayOrder !== null) {
      patch.dayOrder = null;
    }
    // 改期后指纹必然变化 → 下轮推送会把本地值再推上去,这里顺手更新指纹避免来回抖动
    commands.push({
      kind: 'updateTask',
      id: task.id,
      patch: {
        ...patch,
        pushedFingerprint: pushFingerprint({ ...task, ...patch } as Task),
      },
    });
    rescheduled += 1;
  }
  return { commands, consequences: { rescheduled, deleted } };
}
