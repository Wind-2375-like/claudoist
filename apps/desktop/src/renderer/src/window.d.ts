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
  SearchVM,
  ProjectViewVM,
  QuickAddTaskInputVM,
  TaskDetailVM,
  TaskTreeVM,
  TaskVM,
  TodayVM,
  WriteResultVM,
} from '../../shared/viewModels';

declare global {
  interface Window {
    gtd: {
      appInfo: () => Promise<{
        version: string;
        electron: string;
        userData: string;
        packaged: boolean;
      }>;
      inboxList: () => Promise<TaskTreeVM[]>;
      bucketList: (kind: 'someday' | 'reference') => Promise<TaskTreeVM[]>;
      bucketCounts: () => Promise<BucketCountsVM>;
      completedList: () => Promise<TaskVM[]>;
      projectsList: () => Promise<ProjectListItemVM[]>;
      projectView: (id: string) => Promise<ProjectViewVM | null>;
      projectInheritCount: (id: string) => Promise<number>;
      taskDetail: (id: string) => Promise<TaskDetailVM | null>;
      today: () => Promise<TodayVM>;
      upstreamList: () => Promise<TaskTreeVM[]>;
      search: (query: string) => Promise<SearchVM>;
      calendarRange: (from: string, days: number) => Promise<CalendarRangeVM>;
      onChanged: (cb: (ev: GtdChangedEvent) => void) => () => void;
      capture: (texts: string[]) => Promise<WriteResultVM>;
      taskCreate: (input: QuickAddTaskInputVM) => Promise<WriteResultVM>;
      subtaskAdd: (input: AddSubtaskInputVM) => Promise<WriteResultVM>;
      commentAdd: (taskId: string, body: string) => Promise<WriteResultVM>;
      taskSetLabels: (id: string, labelIds: string[]) => Promise<WriteResultVM>;
      reminderAdd: (taskId: string, remindAt: string) => Promise<WriteResultVM>;
      reminderDelete: (id: string) => Promise<WriteResultVM>;
      labelsList: () => Promise<LabelListItemVM[]>;
      filtersList: () => Promise<FilterListItemVM[]>;
      filterRun: (query: string) => Promise<FilterRunVM>;
      filterAdd: (name: string, query: string) => Promise<WriteResultVM>;
      filterUpdate: (
        id: string,
        patch: { name?: string; query?: string },
      ) => Promise<WriteResultVM>;
      filterDelete: (id: string) => Promise<WriteResultVM>;
      labelAdd: (name: string) => Promise<WriteResultVM>;
      labelUpdate: (id: string, patch: { name?: string }) => Promise<WriteResultVM>;
      labelDelete: (id: string) => Promise<WriteResultVM>;
      taskMove: (input: { id: string; to: MoveTargetVM }) => Promise<WriteResultVM>;
      taskReorder: (input: {
        id: string;
        parentTaskId: string | null;
        beforeId?: string;
      }) => Promise<WriteResultVM>;
      taskUpdate: (input: { id: string; patch: Record<string, unknown> }) => Promise<WriteResultVM>;
      taskComplete: (id: string) => Promise<WriteResultVM>;
      taskReopen: (id: string) => Promise<WriteResultVM>;
      taskDelete: (id: string) => Promise<WriteResultVM>;
      projectAdd: (input: { outcome: string; deadline?: string }) => Promise<WriteResultVM>;
      projectUpdate: (input: {
        id: string;
        patch: { outcome?: string; deadline?: string | null };
        propagateDeadline?: boolean;
      }) => Promise<WriteResultVM>;
      projectComplete: (id: string) => Promise<WriteResultVM>;
      projectDeletionPreview: (id: string) => Promise<ProjectDeletionPreviewVM>;
      projectDelete: (id: string, contents: 'delete' | 'toInbox') => Promise<WriteResultVM>;
      projectRestore: (id: string, restoreContents: boolean) => Promise<WriteResultVM>;
    };
    google: {
      status: () => Promise<GoogleStatusVM>;
      importCredentials: () => Promise<WriteResultVM>;
      connect: () => Promise<WriteResultVM>;
      disconnect: (email?: string) => Promise<WriteResultVM>;
      calendars: () => Promise<GoogleCalendarVM[]>;
      setCalendarShown: (
        accountEmail: string,
        id: string,
        shown: boolean,
      ) => Promise<WriteResultVM>;
      sync: (from: string, to: string) => Promise<WriteResultVM>;
      setPushEnabled: (enabled: boolean, purge: boolean) => Promise<WriteResultVM>;
      purgePushed: () => Promise<WriteResultVM>;
      /** 只读复查专用日历真实事件数(pushedCount 只数本地指针,证明不了 Google 侧) */
      inspectPushed: () => Promise<WriteResultVM>;
    };
    agent: {
      status: () => Promise<unknown>;
      readMemory: () => Promise<{ path: string; body: string }>;
      writeMemory: (body: string) => Promise<unknown>;
      listSkills: () => Promise<
        { name: string; builtin: boolean; modified: boolean; path: string }[]
      >;
      readSkill: (name: string) => Promise<{ body: string }>;
      writeSkill: (name: string, body: string) => Promise<{ error?: string }>;
      deleteSkill: (name: string) => Promise<{ error?: string }>;
      resetSkill: (name: string) => Promise<{ error?: string }>;
      toolManual: () => Promise<ToolManualEntryVM[]>;
      models: () => Promise<ModelInfoVM[]>;
      setModel: (model: string) => Promise<{ applied: boolean; error?: string }>;
      setEffort: (effort: string) => Promise<{ error?: string }>;
      setThinking: (mode: 'off' | 'hidden' | 'shown') => Promise<{ error?: string }>;
      startSession: (opts: {
        resume?: boolean;
        conversationId?: string;
        fork?: boolean;
      }) => Promise<{ started: boolean; conversationId: string }>;
      restartSession: () => Promise<{ error?: string }>;
      usageSnapshot: (force?: boolean) => Promise<AccountUsageVM>;
      openBilling: () => Promise<unknown>;
      guardrails: () => Promise<GuardrailsVM>;
      setGuardrails: (
        maxTurns: number | null,
        maxBudgetUsd: number | null,
      ) => Promise<{ error?: string }>;
      newSession: () => Promise<unknown>;
      destroySession: () => Promise<unknown>;
      send: (
        text: string,
        images: { data: string; mediaType: string }[],
        attachments?: string[],
      ) => Promise<{ error?: string; messageUuid?: string; turnId?: string }>;
      rewindPreview: (anchor: RewindAnchorVM) => Promise<RewindPreviewVM>;
      rewindApply: (anchor: RewindAnchorVM) => Promise<{
        ok?: boolean;
        entryCount?: number;
        backupPath?: string | null;
        error?: string;
      }>;
      forkAt: (
        conversationId: string,
        messageUuid: string,
      ) => Promise<{ ok?: boolean; conversationId?: string; error?: string }>;
      interrupt: () => Promise<unknown>;
      permissionModes: () => Promise<{
        modes: { id: string; label: string; hint: string }[];
        current: string;
        alwaysAllow: string[];
      }>;
      setPermissionMode: (mode: string) => Promise<{ error?: string; needsRestart?: boolean }>;
      respondPermission: (
        id: string,
        r: { behavior: 'allow'; always?: boolean } | { behavior: 'deny'; message?: string },
      ) => Promise<unknown>;
      clearAlwaysAllow: () => Promise<unknown>;
      onPermissionRequest: (cb: (req: PermissionRequestVM) => void) => () => void;
      auditList: (conversationId?: string | null) => Promise<AuditRowVM[]>;
      conversations: () => Promise<ConversationVM[]>;
      transcript: (id: string) => Promise<{
        items: { role: 'user' | 'assistant'; uuid: string | null; text: string; tools: string[] }[];
      }>;
      deleteConversation: (id: string) => Promise<{ error?: string }>;
      usageTotals: () => Promise<{
        conversations: number;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
      }>;
      addAttachments: (paths: string[]) => Promise<{ files: { path: string; name: string }[] }>;
      pickAttachments: () => Promise<{ paths: string[] }>;
      pathForFile: (file: File) => string;
      onStream: (cb: (msg: unknown) => void) => () => void;
    };
  }
}

export {};
