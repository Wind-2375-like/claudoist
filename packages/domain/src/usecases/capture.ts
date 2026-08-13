import type { Id } from '../entities/common';
import type { Task } from '../entities/task';
import { TASK_DEFAULTS } from '../entities/task';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import { nextRootSortOrder } from '../rules/subtasks';
import type { UsecaseResult } from './types';

/** §4.1 Capture(D-20 容器模型:捕捉 = 在 Inbox 建 Task)。 */

export interface CaptureInput {
  texts: string[];
}

export interface CaptureConsequences {
  createdIds: Id[];
}

/**
 * INV-16 捕捉零判断(载体随 D-20 改为 createTask):逐条在 Inbox 建任务,
 * 不解析、不去重、不追问任何元数据;重复内容合法;空白跳过,标题原文保存。
 * D-30 起任务没有必填的情境字段 —— 标签是可选多值,捕捉时一个都不加。
 */
export function captureToInbox(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: CaptureInput,
): UsecaseResult<CaptureConsequences> {
  const commands: Command[] = [];
  const createdIds: Id[] = [];
  // 同一批捕捉逐条追加到 inbox 根组末尾(INV-27):base + i(snap 不随批更新,故手动递增)
  let order = nextRootSortOrder(snap, { bucket: 'inbox', projectId: null });
  for (const text of input.texts) {
    if (text.trim() === '') continue;
    const now = deps.clock.now();
    const task: Task = {
      id: deps.idGen.next(),
      title: text,
      estimatedMinutes: TASK_DEFAULTS.estimatedMinutes,
      energy: TASK_DEFAULTS.energy,
      priority: TASK_DEFAULTS.priority,
      projectId: null,
      deadline: null,
      status: 'active',
      createdAt: now,
      completedAt: null,
      deletedAt: null,
      description: TASK_DEFAULTS.description,
      scheduledDate: null,
      bucket: 'inbox',
      parentTaskId: null,
      sortOrder: order++,
      startTime: null,
      durationMinutes: null,
      externalId: null,
      externalCalendarId: null,
      pushedEventId: null,
      pushedFingerprint: null,
      timeZone: null,
      repeat: null, // capture 只写标题
      seriesId: null,
    };
    commands.push({ kind: 'createTask', task });
    createdIds.push(task.id);
  }
  return { commands, consequences: { createdIds } };
}
