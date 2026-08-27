import type { Context } from '../entities/context';
import type { InboxItem } from '../entities/inboxItem';
import type { ListItem } from '../entities/listItem';
import type { Project } from '../entities/project';
import type { Task } from '../entities/task';
import type { WaitingFor } from '../entities/waitingFor';
import type { GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import { projectBreadcrumb } from '../rules/projectTree';
import type { ProjectStats } from '../rules/projectStats';
import { projectStats } from '../rules/projectStats';
import type { UsecaseOk } from './types';

/** §4.15 状态汇总(Dashboard / `get_status_summary`)。纯读,无副作用。 */

export interface TaskWithBreadcrumb {
  task: Task;
  /** 所属项目面包屑 "A > B > C";无项目(或项目缺失)→ null */
  projectBreadcrumb: string | null;
}

export interface ContextTaskGroup {
  context: Context;
  tasks: TaskWithBreadcrumb[];
}

export interface StatusSummaryConsequences {
  /** 计数与文本,position 升序(INV-17 FIFO 口径) */
  inbox: { count: number; items: InboxItem[] };
  /** active 项目(D-21 平面)+ 统计 */
  projects: { project: Project; stats: ProjectStats }[];
  /** active Task 按 context 分组(active context 按 sortOrder) */
  tasksByContext: ContextTaskGroup[];
  /** 未解决等待项 */
  waiting: WaitingFor[];
  someday: ListItem[];
  reference: ListItem[];
  /** §2.8 统计口径 */
  doneTaskCount: number;
  completeProjectCount: number;
}

export function statusSummary(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  _input?: Record<string, never>,
): UsecaseOk<StatusSummaryConsequences> {
  const withBreadcrumb = (t: Task): TaskWithBreadcrumb => ({
    task: t,
    projectBreadcrumb: t.projectId !== null ? projectBreadcrumb(snap, t.projectId) || null : null,
  });
  const tasksByContext = snap.contexts
    .filter((c) => !c.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((context) => ({
      context,
      tasks: snap.tasks
        .filter((t) => t.status === 'active' && t.contextId === context.id)
        .map(withBreadcrumb),
    }));
  return {
    commands: [],
    consequences: {
      inbox: {
        count: snap.inbox.length,
        items: [...snap.inbox].sort((a, b) => a.position - b.position),
      },
      projects: snap.projects
        .filter((p) => p.status === 'active')
        .map((project) => ({ project, stats: projectStats(snap, project.id) })),
      tasksByContext,
      waiting: snap.waiting.filter((w) => !w.resolved),
      someday: snap.listItems.filter((i) => i.kind === 'someday'),
      reference: snap.listItems.filter((i) => i.kind === 'reference'),
      doneTaskCount: snap.tasks.filter((t) => t.status === 'done').length,
      completeProjectCount: snap.projects.filter((p) => p.status === 'complete').length,
    },
  };
}
