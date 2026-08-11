/**
 * IPC 视图 DTO(renderer 只经 preload 见到这些形状,不 import 内层包 —
 * docs/DESIGN.md §4.1)。由 main 的读 handler 从 domain 快照+规则组装。
 */

export interface LabelVM {
  id: string;
  name: string;
}

export interface TaskVM {
  id: string;
  title: string;
  description: string;
  estimatedMinutes: number;
  energy: string;
  priority: number;
  priorityLabel: string;
  deadline: string | null;
  overdue: boolean;
  scheduledDate: string | null;
  bucket: 'inbox' | 'project' | 'someday' | 'reference';
  projectId: string | null;
  projectName: string | null;
  labels: LabelVM[];
  completedAt: string | null;
  parentTaskId: string | null;
  /** 整棵子树中 active 后代数(删除确认文案、行内计数用,INV-26) */
  subtaskCount: number;
  /** 日历统一(D-23/M6a):开始时刻 HH:MM;null = 全天/无时间 */
  startTime: string | null;
  /** 日历 block 时长(分钟);null = 回退 estimatedMinutes */
  durationMinutes: number | null;
  /** 时区(D-27/INV-31):null = 浮动时间(跨时区不变) */
  timeZone: string | null;
  /** 外部日历镜像(D-25/INV-29):非空 = 来自 Google 日历,时间/标题不可本地修改 */
  externalId: string | null;
  externalCalendarId: string | null;
}

export type MoveTargetVM =
  { bucket: 'inbox' | 'someday' | 'reference' } | { bucket: 'project'; projectId: string };

/** Filters & Labels 视图 / 选择器用:标签 + 活跃任务计数(D-30:情境已并入标签)。 */
export interface LabelListItemVM {
  id: string;
  name: string;
  activeTaskCount: number;
}

/** D-21 平面项目(侧栏 + My Projects 总览)。 */
export interface ProjectListItemVM {
  id: string;
  name: string;
  deadline: string | null;
  activeCount: number;
  doneCount: number;
  /** done/(done+active),0–100 整数 */
  progressPct: number;
}

/** 单项目视图:根任务树(M5R5:子任务在列表里显示为嵌套树;含"已完成但仍有活跃子任务"的根)。 */
export interface ProjectViewVM {
  id: string;
  name: string;
  deadline: string | null;
  /** 项目已标记完成(视图只读展示,不再提供 Add task) */
  complete: boolean;
  tasks: TaskTreeVM[];
  doneCount: number;
}

export interface CommentVM {
  id: string;
  body: string;
  createdAt: string;
}

export interface ReminderVM {
  id: string;
  remindAt: string;
  dispatched: boolean;
}

/**
 * 任务树(D-22/M5R5):容器列表与详情弹窗把嵌套子任务显示为树。
 * children = 活跃子树(done 子任务隐藏但计入 subtaskDone/subtaskTotal,按直接子任务计)。
 */
export interface TaskTreeVM {
  task: TaskVM;
  children: TaskTreeVM[];
  /** 直接子任务中已完成数 / 非删除总数(Todoist 式 "done/total" 徽章) */
  subtaskDone: number;
  subtaskTotal: number;
  /** 域口径子树高度(自身=1,计 done 子任务;INV-25)——拖拽缩进预算与 reorderTask 校验一致 */
  height: number;
}

/** 任务详情弹窗(D-21/22):子任务树 + 评论 + reminders(右栏可编辑)。 */
export interface TaskDetailVM {
  task: TaskVM;
  /** 所在位置文案(Inbox / 项目名 / Someday / Reference) */
  locationLabel: string;
  parentTaskId: string | null;
  parentTitle: string | null;
  /** 当前层级(根 = 1);canAddSubtask = depth < 5(INV-25) */
  depth: number;
  canAddSubtask: boolean;
  /** 直接子任务树(M5R5:详情弹窗内显示嵌套树) */
  subtasks: TaskTreeVM[];
  comments: CommentVM[];
  reminders: ReminderVM[];
}

export interface TodayVM {
  today: string;
  /**
   * 统一列表(D-21/D-23):scheduledDate ≤ 今天 ∪(deadline ≤ 今天 且未计划)的 active 任务
   * (someday/reference 不入)。计划段内:全天在前,再按 startTime(原 hard-landscape 已并入)。
   */
  tasks: TaskVM[];
}

/** 日历某日(D-23/INV-28/M6b):全天段 + 定时段(按时刻序)。done 任务仍在,显示为完成态。 */
export interface CalendarDayVM {
  date: string;
  isToday: boolean;
  allDay: TaskVM[];
  timed: TaskVM[];
}

/** 日历区间(周网格取 7 天)。 */
export interface CalendarRangeVM {
  from: string;
  to: string;
  days: CalendarDayVM[];
}

/** Google 连接状态(M6c-1)。token 永不出主进程,这里只暴露"连没连、连的谁"。 */
export interface GoogleAccountVM {
  email: string;
}

export interface GoogleStatusVM {
  hasCredentials: boolean;
  /** 至少连了一个账号 */
  connected: boolean;
  /** 已连接账号(M6c-2b:可多个 —— 学校 Workspace 常禁止把日历共享到外部账号) */
  accounts: GoogleAccountVM[];
  /** safeStorage 是否可用(不可用则无法安全保存凭据,UI 需明示) */
  encryptionAvailable: boolean;
  /** 是否把任务推送到专用日历(D-26/INV-30;**默认关闭**,写入用户账号须显式开启) */
  pushEnabled: boolean;
  /** 专用日历名 */
  pushCalendarName: string;
  /** 当前仍挂在 Google 上的已推事件数(关掉推送后可单独清理) */
  pushedCount: number;
}

/** Google 日历列表项(设置页展示/勾选)。 */
export interface GoogleCalendarVM {
  id: string;
  summary: string;
  primary: boolean;
  backgroundColor: string | null;
  accessRole: string;
  /** Google 侧的订阅勾选(仅供参考) */
  selected: boolean;
  /** 是否在 Claudoist 里显示(本地设置,M6c-2) */
  shown: boolean;
  /** 所属已连接账号(多账号下同一 id 可能重复出现) */
  accountEmail: string;
}

/** ⌘K 搜索结果跳转目标 —— 与 App 的 View 联合一一对应。 */
export type SearchTargetVM =
  | { view: 'inbox' | 'someday' | 'reference' | 'upstream' | 'completed' }
  | { view: 'project'; projectId: string };

export interface SearchHitVM {
  kind: 'task' | 'project';
  /** task 的 id(kind='task' 时可直接开详情弹窗)或 project 的 id */
  id: string;
  title: string;
  /** 二级行:容器/项目 · 标签 · 状态 */
  subtitle: string;
  done: boolean;
  target: SearchTargetVM;
}

/** ⌘K 搜索(M7a):排序与过滤全部来自 domain `searchAll`,这里只做呈现映射。 */
export interface SearchVM {
  hits: SearchHitVM[];
  /** 截断前的命中总数(含未在面板呈现的 waiting-for) */
  totalMatched: number;
}

/** 侧栏徽章计数(someday/reference)。 */
export interface BucketCountsVM {
  someday: number;
  reference: number;
  /** 外部日历镜像任务数(D-25:独立容器,不计入 Inbox) */
  upstream: number;
}

export interface GtdChangedEvent {
  entities: string[];
  actor: 'user' | 'agent';
  conversationId?: string;
}

export interface QuickAddTaskInputVM {
  title: string;
  estimatedMinutes?: number;
  energy?: 'low' | 'medium' | 'high';
  priority?: number;
  deadline?: string;
  projectId?: string;
  description?: string;
  scheduledDate?: string;
  labelIds?: string[];
  reminderAt?: string;
  startTime?: string;
  durationMinutes?: number;
}

export interface AddSubtaskInputVM {
  parentTaskId: string;
  title: string;
  description?: string;
  priority?: number;
  deadline?: string;
  scheduledDate?: string;
  labelIds?: string[];
  reminderAt?: string;
  startTime?: string;
  durationMinutes?: number;
}

export type WriteResultVM<C = Record<string, unknown>> = { error: string } | { consequences: C };
