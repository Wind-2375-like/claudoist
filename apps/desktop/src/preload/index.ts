import { contextBridge, ipcRenderer } from 'electron';
import type {
  CalendarRangeVM,
  GoogleCalendarVM,
  GoogleStatusVM,
  AddSubtaskInputVM,
  BucketCountsVM,
  FilterListItemVM,
  FilterRunVM,
  LabelListItemVM,
  GtdChangedEvent,
  MoveTargetVM,
  ProjectListItemVM,
  ProjectViewVM,
  SearchVM,
  QuickAddTaskInputVM,
  TaskDetailVM,
  TaskTreeVM,
  TaskVM,
  TodayVM,
  WriteResultVM,
} from '../shared/viewModels';

/** 类型化 IPC 桥(docs/DESIGN.md §4.1)。 */
const gtdApi = {
  appInfo: (): Promise<{
    version: string;
    electron: string;
    userData: string;
    packaged: boolean;
  }> => ipcRenderer.invoke('app:info'),
  inboxList: (): Promise<TaskTreeVM[]> => ipcRenderer.invoke('gtd:inbox.list'),
  bucketList: (kind: 'someday' | 'reference'): Promise<TaskTreeVM[]> =>
    ipcRenderer.invoke('gtd:bucket.list', { kind }),
  bucketCounts: (): Promise<BucketCountsVM> => ipcRenderer.invoke('gtd:bucket.counts'),
  completedList: (): Promise<TaskVM[]> => ipcRenderer.invoke('gtd:completed.list'),
  projectsList: (): Promise<ProjectListItemVM[]> => ipcRenderer.invoke('gtd:projects.list'),
  projectView: (id: string): Promise<ProjectViewVM | null> =>
    ipcRenderer.invoke('gtd:project.view', { id }),
  projectInheritCount: (id: string): Promise<number> =>
    ipcRenderer.invoke('gtd:projects.inheritCount', { id }),
  taskDetail: (id: string): Promise<TaskDetailVM | null> =>
    ipcRenderer.invoke('gtd:task.detail', { id }),
  today: (): Promise<TodayVM> => ipcRenderer.invoke('gtd:today'),
  upstreamList: (): Promise<TaskTreeVM[]> => ipcRenderer.invoke('gtd:upstream.list'),
  search: (query: string): Promise<SearchVM> => ipcRenderer.invoke('gtd:search', { query }),
  calendarRange: (from: string, days: number): Promise<CalendarRangeVM> =>
    ipcRenderer.invoke('gtd:calendar.range', { from, days }),
  onChanged: (cb: (ev: GtdChangedEvent) => void): (() => void) => {
    const listener = (_e: unknown, ev: GtdChangedEvent): void => cb(ev);
    ipcRenderer.on('gtd:changed', listener);
    return () => {
      ipcRenderer.removeListener('gtd:changed', listener);
    };
  },
  // ── 写通道 ──
  capture: (texts: string[]): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:capture', { texts }),
  taskCreate: (input: QuickAddTaskInputVM): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:tasks.create', input),
  subtaskAdd: (input: AddSubtaskInputVM): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:tasks.addSubtask', input),
  commentAdd: (taskId: string, body: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:comments.add', { taskId, body }),
  taskSetLabels: (id: string, labelIds: string[]): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:tasks.setLabels', { id, labelIds }),
  reminderAdd: (taskId: string, remindAt: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:reminders.add', { taskId, remindAt }),
  reminderDelete: (id: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:reminders.delete', { id }),
  labelsList: (): Promise<LabelListItemVM[]> => ipcRenderer.invoke('gtd:labels.list'),
  filtersList: (): Promise<FilterListItemVM[]> => ipcRenderer.invoke('gtd:filters.list'),
  filterRun: (query: string): Promise<FilterRunVM> =>
    ipcRenderer.invoke('gtd:filters.run', { query }),
  filterAdd: (name: string, query: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:filters.add', { name, query }),
  filterUpdate: (id: string, patch: { name?: string; query?: string }): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:filters.update', { id, patch }),
  filterDelete: (id: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:filters.delete', { id }),
  labelAdd: (name: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:labels.add', { name }),
  labelUpdate: (id: string, patch: { name?: string }): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:labels.update', { id, patch }),
  labelDelete: (id: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:labels.delete', { id }),
  taskMove: (input: { id: string; to: MoveTargetVM }): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:tasks.move', input),
  taskReorder: (input: {
    id: string;
    parentTaskId: string | null;
    beforeId?: string;
  }): Promise<WriteResultVM> => ipcRenderer.invoke('gtd:tasks.reorder', input),
  taskUpdate: (input: { id: string; patch: Record<string, unknown> }): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:tasks.update', input),
  taskComplete: (id: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:tasks.complete', { id }),
  taskReopen: (id: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:tasks.reopen', { id }),
  taskDelete: (id: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:tasks.delete', { id }),
  projectAdd: (input: { outcome: string; deadline?: string }): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:projects.add', input),
  projectUpdate: (input: {
    id: string;
    patch: { outcome?: string; deadline?: string | null };
    propagateDeadline?: boolean;
  }): Promise<WriteResultVM> => ipcRenderer.invoke('gtd:projects.update', input),
  projectComplete: (id: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:projects.complete', { id }),
};

const googleApi = {
  status: (): Promise<GoogleStatusVM> => ipcRenderer.invoke('google:status'),
  importCredentials: (): Promise<WriteResultVM> => ipcRenderer.invoke('google:credentials.import'),
  connect: (): Promise<WriteResultVM> => ipcRenderer.invoke('google:connect'),
  disconnect: (email?: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('google:disconnect', { email }),
  calendars: (): Promise<GoogleCalendarVM[]> => ipcRenderer.invoke('google:calendars'),
  setCalendarShown: (accountEmail: string, id: string, shown: boolean): Promise<WriteResultVM> =>
    ipcRenderer.invoke('google:calendars.setShown', { accountEmail, id, shown }),
  sync: (from: string, to: string): Promise<WriteResultVM> =>
    ipcRenderer.invoke('google:sync', { from, to }),
  setPushEnabled: (enabled: boolean, purge: boolean): Promise<WriteResultVM> =>
    ipcRenderer.invoke('google:push.setEnabled', { enabled, purge }),
  purgePushed: (): Promise<WriteResultVM> => ipcRenderer.invoke('google:push.purge'),
  inspectPushed: (): Promise<WriteResultVM> => ipcRenderer.invoke('google:push.inspect'),
};

const agentApi = {
  status: (): Promise<unknown> => ipcRenderer.invoke('agent:status'),
  readMemory: (): Promise<{ path: string; body: string }> =>
    ipcRenderer.invoke('agent:memory.read'),
  writeMemory: (body: string): Promise<unknown> =>
    ipcRenderer.invoke('agent:memory.write', { body }),
  listSkills: (): Promise<{ name: string; builtin: boolean; modified: boolean; path: string }[]> =>
    ipcRenderer.invoke('agent:skills.list'),
  readSkill: (name: string): Promise<{ body: string }> =>
    ipcRenderer.invoke('agent:skills.read', { name }),
  writeSkill: (name: string, body: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke('agent:skills.write', { name, body }),
  deleteSkill: (name: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke('agent:skills.delete', { name }),
  resetSkill: (name: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke('agent:skills.reset', { name }),
  toolManual: (): Promise<
    {
      qualified: string;
      name: string;
      description: string;
      params: { name: string; type: string; required: boolean; description: string }[];
    }[]
  > => ipcRenderer.invoke('agent:tools.manual'),
  models: (): Promise<{ value: string; displayName: string }[]> =>
    ipcRenderer.invoke('agent:models'),
  setModel: (model: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke('agent:model.set', { model }),
  startSession: (resume: boolean): Promise<unknown> =>
    ipcRenderer.invoke('agent:session.start', { resume }),
  newSession: (): Promise<unknown> => ipcRenderer.invoke('agent:session.new'),
  destroySession: (): Promise<unknown> => ipcRenderer.invoke('agent:session.destroy'),
  send: (text: string, images: { data: string; mediaType: string }[]): Promise<unknown> =>
    ipcRenderer.invoke('agent:send', { text, images }),
  interrupt: (): Promise<unknown> => ipcRenderer.invoke('agent:interrupt'),
  onStream: (cb: (msg: unknown) => void): (() => void) => {
    const listener = (_e: unknown, msg: unknown): void => cb(msg);
    ipcRenderer.on('agent:stream', listener);
    return () => {
      ipcRenderer.removeListener('agent:stream', listener);
    };
  },
};

contextBridge.exposeInMainWorld('gtd', gtdApi);
contextBridge.exposeInMainWorld('google', googleApi);
contextBridge.exposeInMainWorld('agent', agentApi);
