import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AccountUsageVM,
  GuardrailsVM,
  AuditRowVM,
  RewindAnchorVM,
  RewindPreviewVM,
  ConversationVM,
  ModelInfoVM,
  PermissionRequestVM,
  ToolManualEntryVM,
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
  ProjectDeletionPreviewVM,
  ProjectListItemVM,
  ProjectViewVM,
  SearchVM,
  QuickAddTaskInputVM,
  TaskDetailVM,
  TaskTreeVM,
  TodayVM,
  WriteResultVM,
  RepeatInputVM,
  CompletedItemVM,
  RepeatPresetVM,
  RepeatPreviewVM,
} from '../shared/viewModels';
import type { AppearanceVM } from '../shared/appearance';

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
  completedList: (): Promise<CompletedItemVM[]> => ipcRenderer.invoke('gtd:completed.list'),
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
  repeatPresets: (anchor: string): Promise<RepeatPresetVM[]> =>
    ipcRenderer.invoke('gtd:repeat.presets', { anchor }),
  repeatPreview: (input: RepeatInputVM, anchor: string): Promise<RepeatPreviewVM> =>
    ipcRenderer.invoke('gtd:repeat.preview', { input, anchor }),
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
  projectDeletionPreview: (id: string): Promise<ProjectDeletionPreviewVM> =>
    ipcRenderer.invoke('gtd:projects.deletionPreview', { id }),
  /** contents 必填:项目里的活跃任务是一并删掉,还是退回 Inbox(INV-34) */
  projectDelete: (id: string, contents: 'delete' | 'toInbox'): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:projects.delete', { id, contents }),
  projectRestore: (id: string, restoreContents: boolean): Promise<WriteResultVM> =>
    ipcRenderer.invoke('gtd:projects.restore', { id, restoreContents }),
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
  toolManual: (): Promise<ToolManualEntryVM[]> => ipcRenderer.invoke('agent:tools.manual'),
  models: (): Promise<ModelInfoVM[]> => ipcRenderer.invoke('agent:models'),
  setModel: (model: string): Promise<{ applied: boolean; error?: string }> =>
    ipcRenderer.invoke('agent:model.set', { model }),
  setEffort: (effort: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke('agent:effort.set', { effort }),
  setThinking: (mode: 'off' | 'hidden' | 'shown'): Promise<{ error?: string }> =>
    ipcRenderer.invoke('agent:thinking.set', { mode }),
  startSession: (opts: {
    resume?: boolean;
    conversationId?: string;
    fork?: boolean;
  }): Promise<{ started: boolean; conversationId: string }> =>
    ipcRenderer.invoke('agent:session.start', opts),
  /** 重起并 resume 同一条会话(护栏改动靠它生效);上下文保留 */
  restartSession: (): Promise<{ error?: string }> => ipcRenderer.invoke('agent:session.restart'),
  // ── 账号与用量(M11-A)──
  usageSnapshot: (force = false): Promise<AccountUsageVM> =>
    ipcRenderer.invoke('agent:usage.snapshot', { force }),
  openBilling: (): Promise<unknown> => ipcRenderer.invoke('agent:usage.openBilling'),
  guardrails: (): Promise<GuardrailsVM> => ipcRenderer.invoke('agent:guardrails.get'),
  setGuardrails: (
    maxTurns: number | null,
    maxBudgetUsd: number | null,
  ): Promise<{ error?: string }> =>
    ipcRenderer.invoke('agent:guardrails.set', { maxTurns, maxBudgetUsd }),
  newSession: (): Promise<unknown> => ipcRenderer.invoke('agent:session.new'),
  destroySession: (): Promise<unknown> => ipcRenderer.invoke('agent:session.destroy'),
  send: (
    text: string,
    images: { data: string; mediaType: string }[],
    attachments: string[] = [],
  ): Promise<{ error?: string; messageUuid?: string; turnId?: string }> =>
    ipcRenderer.invoke('agent:send', { text, images, attachments }),
  interrupt: (): Promise<unknown> => ipcRenderer.invoke('agent:interrupt'),
  // ── 分叉 / 回滚(INV-35)──
  rewindPreview: (anchor: RewindAnchorVM): Promise<RewindPreviewVM> =>
    ipcRenderer.invoke('agent:rewind.preview', anchor),
  rewindApply: (
    anchor: RewindAnchorVM,
  ): Promise<{ ok?: boolean; entryCount?: number; backupPath?: string | null; error?: string }> =>
    ipcRenderer.invoke('agent:rewind.apply', anchor),
  forkAt: (
    conversationId: string,
    messageUuid: string,
  ): Promise<{ ok?: boolean; conversationId?: string; error?: string }> =>
    ipcRenderer.invoke('agent:conversations.forkAt', { conversationId, messageUuid }),
  // ── 权限(M9)──
  permissionModes: (): Promise<{
    modes: { id: string; label: string; hint: string }[];
    current: string;
    alwaysAllow: string[];
  }> => ipcRenderer.invoke('agent:permission.modes'),
  setPermissionMode: (mode: string): Promise<{ error?: string; needsRestart?: boolean }> =>
    ipcRenderer.invoke('agent:permission.setMode', { mode }),
  respondPermission: (
    id: string,
    r: { behavior: 'allow'; always?: boolean } | { behavior: 'deny'; message?: string },
  ): Promise<unknown> => ipcRenderer.invoke('agent:permission.respond', { id, ...r }),
  clearAlwaysAllow: (): Promise<unknown> => ipcRenderer.invoke('agent:permission.clearAlwaysAllow'),
  onPermissionRequest: (cb: (req: PermissionRequestVM) => void): (() => void) => {
    const listener = (_e: unknown, req: PermissionRequestVM): void => cb(req);
    ipcRenderer.on('agent:permission.request', listener);
    return () => {
      ipcRenderer.removeListener('agent:permission.request', listener);
    };
  },
  auditList: (conversationId?: string | null): Promise<AuditRowVM[]> =>
    ipcRenderer.invoke('agent:audit.list', { conversationId }),
  // ── 会话与用量(M10)──
  conversations: (): Promise<ConversationVM[]> => ipcRenderer.invoke('agent:conversations.list'),
  transcript: (
    id: string,
  ): Promise<{
    items: {
      role: 'user' | 'assistant';
      uuid: string | null;
      text: string;
      tools: string[];
      images: string[];
    }[];
  }> => ipcRenderer.invoke('agent:conversations.transcript', { id }),
  deleteConversation: (id: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke('agent:conversations.delete', { id }),
  usageTotals: (): Promise<{
    conversations: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }> => ipcRenderer.invoke('agent:usage.totals'),
  // ── 附件(M10)──
  addAttachments: (paths: string[]): Promise<{ files: { path: string; name: string }[] }> =>
    ipcRenderer.invoke('agent:attachments.add', { paths }),
  /**
   * 拖拽文件的真实路径。sandbox 渲染层里 `File.path` 早已是空串(Electron 32 移除),
   * 唯一的取法是在 preload 调 `webUtils.getPathForFile` —— contextBridge 对 File 对象
   * 有特殊处理,可以这样跨界传。
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  pickAttachments: (): Promise<{ paths: string[] }> => ipcRenderer.invoke('agent:attachments.pick'),
  onStream: (cb: (msg: unknown) => void): (() => void) => {
    const listener = (_e: unknown, msg: unknown): void => cb(msg);
    ipcRenderer.on('agent:stream', listener);
    return () => {
      ipcRenderer.removeListener('agent:stream', listener);
    };
  },
};

const appearanceApi = {
  get: (): Promise<AppearanceVM> => ipcRenderer.invoke('app:appearance.get'),
  set: (v: AppearanceVM): Promise<void> => ipcRenderer.invoke('app:appearance.set', v),
  openLogs: (): Promise<void> => ipcRenderer.invoke('app:logs.open'),
  logError: (source: string, message: string): void =>
    void ipcRenderer.invoke('app:logs.error', { source, message }),
};

contextBridge.exposeInMainWorld('gtd', gtdApi);
contextBridge.exposeInMainWorld('appearance', appearanceApi);
contextBridge.exposeInMainWorld('google', googleApi);
contextBridge.exposeInMainWorld('agent', agentApi);
