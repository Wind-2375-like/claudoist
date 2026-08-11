import type { Task } from '../entities/task';
import type { WaitingFor } from '../entities/waitingFor';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import { nextRootSortOrder } from './subtasks';

/**
 * INV-23 催办模板:对**未解决**的等待项创建跟进行动;不改变 resolved 状态。
 * 标签:存在名为 phone 的标签则带上(D-30 前是固定落 @phone context)。
 */
export function buildFollowUpTask(
  snap: GtdSnapshot,
  deps: FlowDeps,
  w: WaitingFor,
): { task: Task; commands: Command[] } {
  // D-30:context 已并入 label —— 有 phone 标签就带上,没有就不带(标签是可选的)
  const phoneLabel = snap.labels.find((l) => l.name === 'phone');
  const task: Task = {
    id: deps.idGen.next(),
    title: `Follow up with ${w.delegatedTo} re: ${w.description}`,
    estimatedMinutes: 5,
    energy: 'low',
    priority: 4, // 「高」(INV-01:5 = 最高)
    projectId: w.projectId,
    deadline: null,
    status: 'active',
    createdAt: deps.clock.now(),
    completedAt: null,
    deletedAt: null,
    description: '',
    scheduledDate: null,
    bucket: w.projectId !== null ? 'project' : 'inbox',
    parentTaskId: null,
    sortOrder: nextRootSortOrder(snap, {
      bucket: w.projectId !== null ? 'project' : 'inbox',
      projectId: w.projectId,
    }),
    startTime: null,
    durationMinutes: null,
    externalId: null,
    externalCalendarId: null,
    pushedEventId: null,
    pushedFingerprint: null,
    timeZone: null,
  };
  const commands: Command[] = [{ kind: 'createTask', task }];
  // 原模板固定落 @phone context;D-30 后没有 context,存在同名标签就带上,没有就不带
  if (phoneLabel) commands.push({ kind: 'assignLabel', taskId: task.id, labelId: phoneLabel.id });
  return { task, commands };
}
