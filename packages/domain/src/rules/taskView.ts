import type { Id, IsoDate } from '../entities/common';
import type { Task } from '../entities/task';
import type { GtdSnapshot } from '../ports/gtdStore';
import { priorityLabel } from './priority';
import { projectBreadcrumb } from './projectTree';

/**
 * 任务的**纯数据投影**:CLI 的 `--json` 与 agent 只读工具共用同一份。
 *
 * 桌面另有自己的 `TaskVM`(带 UI 专用字段,且渲染层不能 import `@gtd/*`,DESIGN §4.1),
 * 那份是有意的第二形状;但 CLI 与 agent 面向的是**同一个消费者语义**(机器读),再各写
 * 一份只会让两边的字段悄悄漂移。字段选择是低风险的重复,真正危险的重复是过滤与排序 ——
 * 那些一律走 domain(INV-20.6 / INV-32.6 / INV-33.9)。
 */
export interface TaskView {
  id: Id;
  title: string;
  status: string;
  bucket: string;
  /** 项目名(平面化后即项目本身的 outcome);无项目为 null */
  project: string | null;
  projectId: Id | null;
  description: string;
  /** 计划哪天做(Todoist 的 Date) */
  scheduledDate: IsoDate | null;
  /** 最迟完成日(Todoist 的 Deadline) */
  deadline: IsoDate | null;
  overdue: boolean;
  /** INV-01:1 = 最低,5 = 最高(与 Todoist 的 pN 相反) */
  priority: number;
  priorityLabel: string;
  /** 标签名(不含 '@';界面与过滤器语法里写作 @名字) */
  labels: string[];
  estimatedMinutes: number;
  energy: string;
  completedAt: string | null;
  parentTaskId: Id | null;
  /** D-23:带 startTime 的任务即日历 block */
  startTime: string | null;
  durationMinutes: number | null;
  /** INV-31:null = 浮动时间 */
  timeZone: string | null;
  /** INV-29:来自外部日历的镜像任务(标题与时间不可本地修改) */
  mirrored: boolean;
}

export function taskView(snap: GtdSnapshot, t: Task, today: IsoDate): TaskView {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    bucket: t.bucket,
    project: t.projectId !== null ? projectBreadcrumb(snap, t.projectId) || null : null,
    projectId: t.projectId,
    description: t.description,
    scheduledDate: t.scheduledDate,
    deadline: t.deadline,
    overdue: t.deadline !== null && t.deadline < today,
    priority: t.priority,
    priorityLabel: priorityLabel(t.priority),
    labels: snap.taskLabels
      .filter((tl) => tl.taskId === t.id)
      .map((tl) => snap.labels.find((l) => l.id === tl.labelId)?.name ?? '?'),
    estimatedMinutes: t.estimatedMinutes,
    energy: t.energy,
    completedAt: t.completedAt,
    parentTaskId: t.parentTaskId,
    startTime: t.startTime,
    durationMinutes: t.durationMinutes,
    timeZone: t.timeZone,
    mirrored: t.externalId !== null,
  };
}
