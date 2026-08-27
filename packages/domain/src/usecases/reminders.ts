import type { Id } from '../entities/common';
import type { Reminder } from '../entities/reminder';
import type { GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import type { UsecaseResult } from './types';

/**
 * Reminder 域 usecases(§2.9,D-22 详情右栏就地编辑)。恰好挂在一个 task 上;
 * 响铃调度 M6。此处只管落库/删除。
 */

const REMIND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export interface AddReminderInput {
  taskId: Id;
  /** 本地 `YYYY-MM-DDTHH:MM` */
  remindAt: string;
}

export interface AddReminderConsequences {
  reminderId: Id;
}

export function addReminder(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: AddReminderInput,
): UsecaseResult<AddReminderConsequences> {
  if (!snap.tasks.some((t) => t.id === input.taskId)) {
    return { error: `行动不存在: ${input.taskId}` };
  }
  if (!REMIND_RE.test(input.remindAt)) {
    return { error: `无效提醒时刻 ${input.remindAt},格式须为 YYYY-MM-DDTHH:MM` };
  }
  const reminder: Reminder = {
    id: deps.idGen.next(),
    taskId: input.taskId,
    remindAt: input.remindAt,
    dispatched: false,
    createdAt: deps.clock.now(),
  };
  return {
    commands: [{ kind: 'createReminder', reminder }],
    consequences: { reminderId: reminder.id },
  };
}

export interface DeleteReminderInput {
  id: Id;
}

export function deleteReminder(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: DeleteReminderInput,
): UsecaseResult<{ reminderId: Id }> {
  if (!snap.reminders.some((r) => r.id === input.id)) {
    return { error: `提醒不存在: ${input.id}` };
  }
  return {
    commands: [{ kind: 'deleteReminder', id: input.id }],
    consequences: { reminderId: input.id },
  };
}
