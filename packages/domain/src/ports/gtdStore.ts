import type { Id } from '../entities/common';
import type { Task } from '../entities/task';
import type { Project } from '../entities/project';
import type { WaitingFor } from '../entities/waitingFor';
import type { InboxItem } from '../entities/inboxItem';
import type { ListItem } from '../entities/listItem';
import type { Label, TaskLabel } from '../entities/label';
import type { SavedFilter } from '../entities/filter';
import type { Reminder } from '../entities/reminder';
import type { TaskComment } from '../entities/taskComment';
import type { ApplyMeta } from './rewind';

/**
 * 全量数据快照:规则与流程一律是快照上的纯函数(个人规模数据,整取无压力)。
 * 存储适配器只需实现 snapshot() + apply()(docs/DESIGN.md §3.3)。
 */
export interface GtdSnapshot {
  inbox: InboxItem[];
  tasks: Task[];
  projects: Project[];
  waiting: WaitingFor[];
  listItems: ListItem[];
  labels: Label[];
  taskLabels: TaskLabel[];
  filters: SavedFilter[];
  reminders: Reminder[];
  comments: TaskComment[];
}

/** 写操作命令:一次 apply() = 一个事务(INV-17 的原子性载体)。 */
export type Command =
  | { kind: 'createInboxItem'; item: InboxItem }
  | { kind: 'deleteInboxItem'; id: Id }
  | { kind: 'createTask'; task: Task }
  | { kind: 'updateTask'; id: Id; patch: Partial<Omit<Task, 'id'>> }
  | { kind: 'createProject'; project: Project }
  | { kind: 'updateProject'; id: Id; patch: Partial<Omit<Project, 'id'>> }
  | { kind: 'createWaitingFor'; item: WaitingFor }
  | { kind: 'updateWaitingFor'; id: Id; patch: Partial<Omit<WaitingFor, 'id'>> }
  | { kind: 'createListItem'; item: ListItem }
  | { kind: 'deleteListItem'; id: Id }
  | { kind: 'createLabel'; label: Label }
  | { kind: 'updateLabel'; id: Id; patch: Partial<Omit<Label, 'id'>> }
  | { kind: 'deleteLabel'; id: Id }
  | { kind: 'assignLabel'; taskId: Id; labelId: Id }
  | { kind: 'unassignLabel'; taskId: Id; labelId: Id }
  | { kind: 'createFilter'; filter: SavedFilter }
  | { kind: 'updateFilter'; id: Id; patch: Partial<Omit<SavedFilter, 'id'>> }
  | { kind: 'deleteFilter'; id: Id }
  | { kind: 'createReminder'; reminder: Reminder }
  | { kind: 'updateReminder'; id: Id; patch: Partial<Omit<Reminder, 'id'>> }
  | { kind: 'deleteReminder'; id: Id }
  | { kind: 'createComment'; comment: TaskComment }
  | { kind: 'deleteComment'; id: Id };

export type Actor = 'user' | 'agent';

/** 存储 port。实现必须通过 domain 提供的 store-contract 测试套件(M3)。 */
export interface GtdStore {
  snapshot(): GtdSnapshot;
  /**
   * 原子应用(全部成功或全部失败);actor 用于变更事件标记。
   *
   * `meta` 可选:**带 `rewindLog` 才记逆命令日志**。刻意做成显式开关而不是按
   * `actor === 'agent'` 判断 —— Google 日历同步也用 `'agent'`(见 ipc/google.ts),
   * 按 actor 挂钩会把日历同步一起卷进回滚,还会硬删镜像任务(INV-35)。
   */
  apply(commands: Command[], actor: Actor, meta?: ApplyMeta): void;
}

/** 纯函数:在内存快照上应用命令(测试与 contract 套件的参照实现)。 */
export function applyToSnapshot(snap: GtdSnapshot, commands: Command[]): GtdSnapshot {
  const next: GtdSnapshot = {
    inbox: [...snap.inbox],
    tasks: [...snap.tasks],
    projects: [...snap.projects],
    waiting: [...snap.waiting],
    listItems: [...snap.listItems],
    labels: [...snap.labels],
    taskLabels: [...snap.taskLabels],
    filters: [...snap.filters],
    reminders: [...snap.reminders],
    comments: [...snap.comments],
  };
  const patchById = <T extends { id: Id }>(arr: T[], id: Id, patch: Partial<Omit<T, 'id'>>): T[] =>
    arr.map((x) => (x.id === id ? { ...x, ...patch } : x));
  for (const c of commands) {
    switch (c.kind) {
      case 'createInboxItem':
        next.inbox = [...next.inbox, c.item];
        break;
      case 'deleteInboxItem':
        next.inbox = next.inbox.filter((i) => i.id !== c.id);
        break;
      case 'createTask':
        next.tasks = [...next.tasks, c.task];
        break;
      case 'updateTask':
        next.tasks = patchById(next.tasks, c.id, c.patch);
        break;
      case 'createProject':
        next.projects = [...next.projects, c.project];
        break;
      case 'updateProject':
        next.projects = patchById(next.projects, c.id, c.patch);
        break;
      case 'createWaitingFor':
        next.waiting = [...next.waiting, c.item];
        break;
      case 'updateWaitingFor':
        next.waiting = patchById(next.waiting, c.id, c.patch);
        break;
      case 'createListItem':
        next.listItems = [...next.listItems, c.item];
        break;
      case 'deleteListItem':
        next.listItems = next.listItems.filter((i) => i.id !== c.id);
        break;
      case 'createLabel':
        next.labels = [...next.labels, c.label];
        break;
      case 'updateLabel':
        next.labels = patchById(next.labels, c.id, c.patch);
        break;
      case 'deleteLabel':
        next.labels = next.labels.filter((l) => l.id !== c.id);
        next.taskLabels = next.taskLabels.filter((tl) => tl.labelId !== c.id);
        break;
      case 'assignLabel':
        if (!next.taskLabels.some((tl) => tl.taskId === c.taskId && tl.labelId === c.labelId)) {
          next.taskLabels = [...next.taskLabels, { taskId: c.taskId, labelId: c.labelId }];
        }
        break;
      case 'unassignLabel':
        next.taskLabels = next.taskLabels.filter(
          (tl) => !(tl.taskId === c.taskId && tl.labelId === c.labelId),
        );
        break;
      case 'createFilter':
        next.filters = [...next.filters, c.filter];
        break;
      case 'updateFilter':
        next.filters = patchById(next.filters, c.id, c.patch);
        break;
      case 'deleteFilter':
        next.filters = next.filters.filter((f) => f.id !== c.id);
        break;
      case 'createReminder':
        next.reminders = [...next.reminders, c.reminder];
        break;
      case 'updateReminder':
        next.reminders = patchById(next.reminders, c.id, c.patch);
        break;
      case 'deleteReminder':
        next.reminders = next.reminders.filter((r) => r.id !== c.id);
        break;
      case 'createComment':
        next.comments = [...next.comments, c.comment];
        break;
      case 'deleteComment':
        next.comments = next.comments.filter((cm) => cm.id !== c.id);
        break;
    }
  }
  return next;
}

export function emptySnapshot(): GtdSnapshot {
  return {
    inbox: [],
    tasks: [],
    projects: [],
    waiting: [],
    listItems: [],
    labels: [],
    taskLabels: [],
    filters: [],
    reminders: [],
    comments: [],
  };
}
