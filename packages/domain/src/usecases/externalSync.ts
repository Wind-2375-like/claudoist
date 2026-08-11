import type { Task } from '../entities/task';
import { TASK_DEFAULTS } from '../entities/task';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import type { ExternalEventInput } from '../rules/externalMirror';
import { externalKeyTasks } from '../rules/externalMirror';
import { nextRootSortOrder } from '../rules/subtasks';
import type { UsecaseResult } from './types';

/**
 * 外部日历 → 本地镜像任务的同步(D-25/INV-29,M6c-3a)。**只写不读外部**:
 * 调用方(主进程)负责拉取事件,这里只把"某窗口内的期望镜像集合"折算成命令。
 *
 * 幂等:同一批输入重复应用不产生命令。只覆盖外部拥有的字段(标题 + 时间),
 * 绝不碰 status / priority / labels / 子任务 —— 那些是本地自治的,重同步不能抹掉
 * 用户已经勾的完成。
 */
export interface SyncExternalInput {
  /** 本次同步覆盖的日期窗口(闭区间);只有落在窗口内的镜像才会被"退休" */
  fromDate: string;
  toDate: string;
  /** 窗口内、来自**当前显示中的日历**的全部事件 */
  events: ExternalEventInput[];
  /**
   * 本轮**成功拉取**的日历 id。退休(软删)判定只在这些日历的镜像上进行 ——
   * 拉取失败与"日历真的空了"必须区分,否则一次断网就会把窗口内所有镜像批量删掉,
   * 恢复后又重建成丢失了标签/子任务/评论的空白任务(2026-08-10 评审 HIGH)。
   * 为空 = 本轮没有任何日历成功拉取 → 完全跳过退休。
   */
  fetchedCalendarIds: string[];
  /** 默认 context(镜像任务必须有 context,INV-24) */
}

export interface SyncExternalConsequences {
  created: number;
  updated: number;
  retired: number;
}

export function syncExternalTasks(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: SyncExternalInput,
): UsecaseResult<SyncExternalConsequences> {
  const commands: Command[] = [];
  // 含已软删的镜像:同一事件再出现时**复活原任务**,而不是新建(既撞唯一索引,
  // 也会丢掉用户加在上面的标签/子任务/评论)
  const existing = new Map(externalKeyTasks(snap).map((t) => [t.externalId!, t]));
  const seen = new Set<string>();
  let created = 0;
  let updated = 0;

  for (const ev of input.events) {
    seen.add(ev.externalId);
    const prev = existing.get(ev.externalId);
    if (prev !== undefined && prev.status === 'deleted') {
      // 复活:恢复 active 并同步外部字段(本地的标签/子任务/评论都还在)
      commands.push({
        kind: 'updateTask',
        id: prev.id,
        patch: {
          status: 'active',
          deletedAt: null,
          title: ev.title,
          scheduledDate: ev.scheduledDate,
          startTime: ev.startTime,
          durationMinutes: ev.durationMinutes,
          externalCalendarId: ev.externalCalendarId,
        },
      });
      updated += 1;
      continue;
    }
    if (prev === undefined) {
      const task: Task = {
        id: deps.idGen.next(),
        title: ev.title,
        estimatedMinutes: ev.durationMinutes ?? TASK_DEFAULTS.estimatedMinutes,
        energy: TASK_DEFAULTS.energy,
        priority: TASK_DEFAULTS.priority,
        projectId: null,
        deadline: null,
        status: 'active',
        createdAt: deps.clock.now(),
        completedAt: null,
        deletedAt: null,
        description: '',
        scheduledDate: ev.scheduledDate,
        bucket: 'inbox',
        parentTaskId: null,
        sortOrder: nextRootSortOrder(snap, { bucket: 'inbox', projectId: null }),
        startTime: ev.startTime,
        durationMinutes: ev.durationMinutes,
        externalId: ev.externalId,
        externalCalendarId: ev.externalCalendarId,
        pushedEventId: null,
        pushedFingerprint: null,
        timeZone: null,
      };
      commands.push({ kind: 'createTask', task });
      created += 1;
      continue;
    }
    // 只在外部拥有的字段真的变了时才发命令(否则每次轮询都会写库、刷 UI)
    const patch: Partial<Omit<Task, 'id'>> = {};
    if (prev.title !== ev.title) patch.title = ev.title;
    if (prev.scheduledDate !== ev.scheduledDate) patch.scheduledDate = ev.scheduledDate;
    if (prev.startTime !== ev.startTime) patch.startTime = ev.startTime;
    if (prev.durationMinutes !== ev.durationMinutes) patch.durationMinutes = ev.durationMinutes;
    if (prev.externalCalendarId !== ev.externalCalendarId) {
      patch.externalCalendarId = ev.externalCalendarId;
    }
    if (Object.keys(patch).length > 0) {
      commands.push({ kind: 'updateTask', id: prev.id, patch });
      updated += 1;
    }
  }

  // 窗口内、这次没出现的镜像 = 外部已删除/已移出窗口/所属日历被隐藏
  let retired = 0;
  const fetched = new Set(input.fetchedCalendarIds);
  for (const [key, task] of existing) {
    if (seen.has(key)) continue;
    if (task.status === 'deleted') continue;
    // 只退休"本轮确实成功拉取过的那些日历"的镜像
    if (task.externalCalendarId === null || !fetched.has(task.externalCalendarId)) continue;
    if (task.scheduledDate === null) continue;
    if (task.scheduledDate < input.fromDate || task.scheduledDate > input.toDate) continue;
    // 已完成的镜像保留作历史(否则"完成过的会议"会凭空消失);未完成的软删
    if (task.status === 'done') continue;
    commands.push({
      kind: 'updateTask',
      id: task.id,
      patch: { status: 'deleted', deletedAt: deps.clock.now() },
    });
    retired += 1;
  }

  return { commands, consequences: { created, updated, retired } };
}
