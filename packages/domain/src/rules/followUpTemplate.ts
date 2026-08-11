import type { Task } from '../entities/task';
import type { WaitingFor } from '../entities/waitingFor';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import { nextRootSortOrder } from './subtasks';

/**
 * INV-23 催办模板:对**未解决**的等待项创建跟进行动;不改变 resolved 状态。
 * context = @phone,不存在则取 sortOrder 最小的 active context。
 */
export function buildFollowUpTask(
  snap: GtdSnapshot,
  deps: FlowDeps,
  w: WaitingFor,
): { task: Task; command: Command } {
  const active = snap.contexts.filter((c) => !c.archived);
  const phone = active.find((c) => c.name === '@phone');
  const fallback = [...active].sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const contextId = (phone ?? fallback)?.id ?? '';
  const task: Task = {
    id: deps.idGen.next(),
    title: `Follow up with ${w.delegatedTo} re: ${w.description}`,
    contextId,
    estimatedMinutes: 5,
    energy: 'low',
    priority: 2, // 「高」(D-29 翻转后)
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
  return { task, command: { kind: 'createTask', task } };
}
