import type { Id } from '../entities/common';
import type { Task, TaskBucket } from '../entities/task';
import type { GtdSnapshot } from '../ports/gtdStore';

/** 子任务树规则(D-21/INV-25)。全部为快照上的纯函数。 */

/** 任务所在层级(根 = 1)。防御:引用悬挂/成环时在断点处停止计数。 */
export function taskDepth(snap: GtdSnapshot, taskId: Id): number {
  const byId = new Map(snap.tasks.map((t) => [t.id, t]));
  let depth = 1;
  let cur = byId.get(taskId);
  const seen = new Set<Id>([taskId]);
  while (cur?.parentTaskId && !seen.has(cur.parentTaskId)) {
    seen.add(cur.parentTaskId);
    cur = byId.get(cur.parentTaskId);
    if (cur) depth += 1;
  }
  return depth;
}

/** 直接子任务(active 优先调用方自筛;此处不过滤 status,软删级联需要全量)。 */
export function childTasks(snap: GtdSnapshot, taskId: Id): Task[] {
  return snap.tasks.filter((t) => t.parentTaskId === taskId);
}

/**
 * 列表根(D-22):任务应在容器列表里成行,当且仅当它没有**活跃的**父任务 ——
 * parentTaskId 为空,或父任务不存在 / 非 active(done / deleted)。这保证被 reopen
 * 出来、而父任务已完成或已删除的活跃子任务不会从所有列表消失(悬空活跃子任务)。
 * 父任务重新 active 时,该子任务自然回到父的详情内、不再单独成行。
 */
export function isTaskListRoot(snap: GtdSnapshot, task: Task): boolean {
  if (task.parentTaskId === null) return true;
  const parent = snap.tasks.find((t) => t.id === task.parentTaskId);
  return !parent || parent.status !== 'active';
}

/** 子树高度(自身 = 1,取最深叶)。用于 INV-25 深度校验(嵌套后总层数)。 */
export function subtreeHeight(snap: GtdSnapshot, taskId: Id): number {
  const kids = snap.tasks.filter((t) => t.parentTaskId === taskId && t.status !== 'deleted');
  if (kids.length === 0) return 1;
  return 1 + Math.max(...kids.map((k) => subtreeHeight(snap, k.id)));
}

/**
 * 同级组(D-24/INV-27):相同 bucket + projectId + parentTaskId 的非删除任务。
 * 手动排序与新建追加都以此为单位。
 */
export function siblingGroup(
  snap: GtdSnapshot,
  key: { bucket: TaskBucket; projectId: Id | null; parentTaskId: Id | null },
): Task[] {
  return snap.tasks.filter(
    (t) =>
      t.status !== 'deleted' &&
      t.bucket === key.bucket &&
      t.projectId === key.projectId &&
      t.parentTaskId === key.parentTaskId,
  );
}

/**
 * 同级排序比较器(INV-27):先按 sortOrder,平手按 createdAt;完全相等返回 0(反对称,稳定)。
 * **唯一实现**:usecases/tasks(reorderTask)与 rules/calendarGrid(全天段)共用 ——
 * 曾在两处各写一份逐字相同的函数体,打包器将其折叠成对重命名符号的引用,导致主进程
 * 启动即 ReferenceError(2026-08-10)。规则只留一份。
 */
export function bySortOrder(a: Task, b: Task): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  return 0;
}

/** 新建任务追加到同级组末尾的 sortOrder(= 组内最大值 + 1,空组为 0)。 */
export function nextSortOrder(
  snap: GtdSnapshot,
  key: { bucket: TaskBucket; projectId: Id | null; parentTaskId: Id | null },
): number {
  const group = siblingGroup(snap, key);
  return group.reduce((m, t) => Math.max(m, t.sortOrder), -1) + 1;
}

/**
 * 追加到容器**顶层展示列表**末尾的 sortOrder。顶层展示行 = isTaskListRoot 集合,
 * 既含 parentTaskId===null 的普通根,也含父已 done/deleted 的孤儿子任务(它们的
 * sortOrder 来自原子任务组,可能与根组撞值)。取所有展示根的最大 sortOrder + 1,
 * 保证新建/移入的行落到视觉末尾(修复 nextSortOrder(parentTaskId=null) 的末尾语义失效)。
 */
export function nextRootSortOrder(
  snap: GtdSnapshot,
  key: { bucket: TaskBucket; projectId: Id | null },
): number {
  const roots = snap.tasks.filter(
    (t) =>
      t.status === 'active' &&
      t.bucket === key.bucket &&
      t.projectId === key.projectId &&
      isTaskListRoot(snap, t),
  );
  return roots.reduce((m, t) => Math.max(m, t.sortOrder), -1) + 1;
}

/** 整棵子树的后代 id(不含自身),BFS。 */
export function descendantTaskIds(snap: GtdSnapshot, taskId: Id): Id[] {
  const out: Id[] = [];
  const queue: Id[] = [taskId];
  const seen = new Set<Id>([taskId]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of snap.tasks.filter((t) => t.parentTaskId === cur)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id);
      queue.push(child.id);
    }
  }
  return out;
}
