import type { IsoDate } from '../entities/common';
import type { Task } from '../entities/task';
import type { GtdSnapshot } from '../ports/gtdStore';

/**
 * Today 列表的**唯一口径**(D-23/D-40,INV-20.6 单一口径)。
 *
 * 收拢的由来:桌面 `today()` 与 CLI `today` 各自排了一遍,注释里写着"改动需同步" ——
 * 那种约定迟早失效。给 Today 加手动排序前先并成一份,否则会变成三份。
 *
 * ## 一条扁平列表,每一行都能手动拖(D-41,2026-09-02 用户裁决)
 *
 * 初版曾按 `startTime` 分成两段:未定时段可拖,定时段锚在时刻上**拒绝**拖,理由是定时任务
 * 同时画在 Calendar 周视图上,允许在 Today 把 15:00 的会拖到 09:00 之前,两个视图就会对
 * 同一批任务给出矛盾的先后。用户明确推翻了这条(原话:「我需要 today 的顺序能拖,不是按照
 * 时间来排」),并接受由此而来的代价:
 *
 * > **Today 的先后是"我打算先做哪件",Calendar 的先后是"几点发生"。这是两个问题,
 * > 从此允许它们给出不同的答案。** Calendar 的 block 当然仍然画在它的时刻上 ——
 * > 一个把 15:00 的会画在 09:00 位置的日历是坏掉的日历,那不是本次要改的东西。
 *
 * 所以这里只剩一条序列:`dayOrder` 说了算,没排过的按派生序垫底。
 */

/** someday/reference 不进 Today(D-20);只看活跃任务。 */
const engageable = (t: Task): boolean =>
  t.status === 'active' && t.bucket !== 'someday' && t.bucket !== 'reference';

/**
 * 派生序(没手动排过时用),= 扁平化之前的默认显示序,逐字保留:
 * 先无时刻的计划任务(过期的更靠前)、再未排期的过期截止项、最后是日历块按时刻。
 *
 * **为什么不改成"全部按时刻穿插"**:那会让所有老用户升级当天看到列表自己重排了一遍,
 * 而他们什么都没做。默认序保持不动,想要什么顺序自己拖 —— 这次改动给的正是这个能力。
 */
function derivedOrder(a: Task, b: Task): number {
  // ① 有无时刻:无时刻的在前(与扁平化之前的两段顺序一致)
  const at = a.startTime !== null && a.scheduledDate !== null;
  const bt = b.startTime !== null && b.scheduledDate !== null;
  if (at !== bt) return at ? 1 : -1;
  if (at) {
    // ② 日历块:计划日(过期的在前)→ 时刻
    if (a.scheduledDate !== b.scheduledDate) return a.scheduledDate! < b.scheduledDate! ? -1 : 1;
    if (a.startTime !== b.startTime) return a.startTime! < b.startTime! ? -1 : 1;
    return byCreated(a, b);
  }
  // ③ 无时刻:有计划日的在前(过期的更靠前),未排期的过期截止项按 deadline 接在后面
  const ap = a.scheduledDate !== null;
  const bp = b.scheduledDate !== null;
  if (ap !== bp) return ap ? -1 : 1;
  if (ap && a.scheduledDate !== b.scheduledDate)
    return a.scheduledDate! < b.scheduledDate! ? -1 : 1;
  if (!ap && a.deadline !== b.deadline) return (a.deadline ?? '') < (b.deadline ?? '') ? -1 : 1;
  return byCreated(a, b);
}

/** createdAt 收尾,保证比较器反对称(相等时按 id,避免不同库排出不同结果)。 */
function byCreated(a: Task, b: Task): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Today 的最终比较器:手动排过的按 `dayOrder` 升序在前,没排过的(null)按派生序接在后面。
 *
 * 混合态只在"第一次拖动之前"以及"之后新出现的行"存在 —— 一次拖拽会把当时的**整个**列表
 * materialize 成 0..N-1(见 `reorderTodayTask`),此后新进来的任务才是 null、垫底
 * (与 INV-27.1「新建追加末尾」同规)。
 */
export function byDayOrder(a: Task, b: Task): number {
  const ao = a.dayOrder ?? Number.MAX_SAFE_INTEGER;
  const bo = b.dayOrder ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return derivedOrder(a, b);
}

/**
 * 今天该做的事,一条已排好序的列表。
 *
 * 成员 = 计划到今天或更早的活跃任务 ∪ 未排期的过期截止项。
 */
export function todayList(snap: GtdSnapshot, today: IsoDate): Task[] {
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
  return [...scheduled, ...due].sort(byDayOrder);
}
