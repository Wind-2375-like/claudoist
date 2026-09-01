import type { IsoDate } from '../entities/common';
import type { Task } from '../entities/task';
import type { GtdSnapshot } from '../ports/gtdStore';

/**
 * Today 列表的**唯一口径**(D-23/D-40,INV-20.6 单一口径)。
 *
 * 收拢的由来:桌面 `today()` 与 CLI `today` 各自排了一遍,注释里写着"改动需同步" ——
 * 那种约定迟早失效。给 Today 加手动排序前先并成一份,否则会变成三份。
 *
 * ## 两段模型(D-40)
 *
 * | 段 | 成员 | 排序 | 能手动拖吗 |
 * |---|---|---|---|
 * | **未定时** | 计划到今天/更早的全天任务 + 未排期的过期截止项 | `dayOrder` 优先,其余按原口径兜底 | **能** |
 * | **定时** | 有 `startTime` 的日历块 | 计划日 → 时刻 | 不能 |
 *
 * 定时任务不参与手动序,是因为它同时出现在 Calendar 周视图上,那里的位置是**时刻**决定的
 * (INV-28)。允许在 Today 里把 15:00 的会拖到 09:00 之前,两个视图就会互相矛盾 ——
 * 而它们展示的是同一批任务。要改顺序就改时间,那才是有意义的动作。
 *
 * 与旧版的可见差异:未排期的过期截止项(due)从"列表最后"挪到了"未定时段内",
 * 因此可能出现在定时任务之前。这是有意的 —— 过期的东西更该被看见,而且现在用户可以自己拖。
 */
export interface TodayList {
  /** 可手动排序的一段(dayOrder 生效) */
  untimed: Task[];
  /** 日历块,按时刻;手动序对它无效 */
  timed: Task[];
  /** 显示序 = untimed ++ timed */
  all: Task[];
}

/** someday/reference 不进 Today(D-20);只看活跃任务。 */
const engageable = (t: Task): boolean =>
  t.status === 'active' && t.bucket !== 'someday' && t.bucket !== 'reference';

/**
 * 未定时段的兜底序(没手动排过时用):有计划日的在前(过期的更靠前),
 * 未排期的过期截止项接在后面按 deadline;createdAt 收尾保证反对称。
 */
function untimedFallback(a: Task, b: Task): number {
  const ap = a.scheduledDate !== null;
  const bp = b.scheduledDate !== null;
  if (ap !== bp) return ap ? -1 : 1;
  if (ap && a.scheduledDate !== b.scheduledDate)
    return a.scheduledDate! < b.scheduledDate! ? -1 : 1;
  if (!ap && a.deadline !== b.deadline) return (a.deadline ?? '') < (b.deadline ?? '') ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/**
 * 未定时段的最终比较器:手动排过的按 `dayOrder` 升序在前,没排过的(null)按兜底序接在后面。
 * 混合态只在"第一次拖动之前"存在 —— 一旦拖过,整段会被 materialize 成 0..N-1(见
 * `reorderTodayTask`),此后新进来的任务才是 null,垫底(与 INV-27.1 新建追加末尾同规)。
 */
export function byDayOrder(a: Task, b: Task): number {
  const ao = a.dayOrder ?? Number.MAX_SAFE_INTEGER;
  const bo = b.dayOrder ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return untimedFallback(a, b);
}

/** 定时段:计划日升序(过期的在前)→ 时刻 → createdAt。 */
function byClock(a: Task, b: Task): number {
  if (a.scheduledDate !== b.scheduledDate)
    return (a.scheduledDate ?? '') < (b.scheduledDate ?? '') ? -1 : 1;
  if (a.startTime !== b.startTime) return (a.startTime ?? '') < (b.startTime ?? '') ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

export function todayList(snap: GtdSnapshot, today: IsoDate): TodayList {
  const scheduled = snap.tasks.filter(
    (t) => engageable(t) && t.scheduledDate !== null && t.scheduledDate <= today,
  );
  const scheduledIds = new Set(scheduled.map((t) => t.id));
  // due 仅收**未计划**的过期项:计划到未来 = 用户显式推迟,不该因过期 deadline 留在 Today
  // (否则"推迟到明天"对过期截止项无效);deadline 徽标仍在各视图标红,硬承诺不丢失。
  const due = snap.tasks.filter(
    (t) =>
      engageable(t) &&
      t.deadline !== null &&
      t.deadline <= today &&
      t.scheduledDate === null &&
      !scheduledIds.has(t.id),
  );
  const untimed = [...scheduled.filter((t) => t.startTime === null), ...due].sort(byDayOrder);
  const timed = scheduled.filter((t) => t.startTime !== null).sort(byClock);
  return { untimed, timed, all: [...untimed, ...timed] };
}
