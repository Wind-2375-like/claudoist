import type {
  CalendarRangeVM,
  GoogleCalendarVM,
  GoogleStatusVM,
  AddSubtaskInputVM,
  BucketCountsVM,
  LabelListItemVM,
  GtdChangedEvent,
  MoveTargetVM,
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
      send: (text: string, images: { data: string; mediaType: string }[]) => Promise<void>;
      interrupt: () => Promise<void>;
      onStream: (cb: (msg: unknown) => void) => () => void;
    };
  }
}

export {};
