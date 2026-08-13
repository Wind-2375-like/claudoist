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
  /**
   * **判定"已完成"只看这个字段。**
   *
   * 不要用 `completedAt !== null` 自己推 —— 软删**故意保留** completedAt(完成记录不该被
   * 删除抹掉),所以「删除前已完成、后来又恢复/复活成 active」的任务 completedAt 非空却
   * 不是 done。2026-08-12 用户就踩到了:日历把这种任务画成划掉,点撤销却报
   * 「只能重开已完成的行动」。
   */
  done: boolean;
  /** 完成时刻;**只用于显示**,不要用它判断是否完成(见 done) */
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
  /** 循环(D-37/INV-36):「每周三」;不循环为 null。文本由 domain 生成,渲染层不拼 */
  repeatShort: string | null;
  /** 「每周三 · 按完成日推进 · 到 2026-12-31 为止」(tooltip) */
  repeatLong: string | null;
  /** Custom 对话框回填/回传用的输入型(纯数据);不循环为 null */
  repeatInput: RepeatInputVM | null;
  seriesId: string | null;
}

/** 循环规则输入(D-37):三个入口共用的形状,渲染层只透传,解析/校验在 domain。 */
export interface RepeatInputVM {
  unit: 'day' | 'week' | 'month' | 'year';
  every?: number;
  weekdays?: ('su' | 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa')[];
  from?: 'scheduled' | 'completed';
  until?: string | null;
}

export interface RepeatPresetVM {
  key: string;
  label: string;
  input: RepeatInputVM;
}

export interface RepeatPreviewVM {
  /** 接下来最多 3 次发生日;结束早于 3 次则截断 */
  next: string[];
  error?: string;
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
  /** INV-34:在回收站里。视图只读 + 显示恢复按钮 */
  deleted: boolean;
  deletedAt: string | null;
  /** 同批可一起恢复的任务数(恢复确认文案用) */
  restorableTaskCount: number;
  tasks: TaskTreeVM[];
  doneCount: number;
}

/** 删除项目前的预检:确认框上的数字与 usecase 的 consequences 同一口径(INV-34) */
export interface ProjectDeletionPreviewVM {
  activeTaskCount: number;
  doneTaskCount: number;
  alreadyDeletedTaskCount: number;
  mirrorTaskCount: number;
  unresolvedWaitingCount: number;
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
  | { view: 'inbox' | 'someday' | 'reference' | 'upstream' | 'completed' | 'filters' }
  | { view: 'project'; projectId: string }
  /** 标签/过滤器命中 → 进查询结果页(与 Todoist 的 ⌘K 一致) */
  | { view: 'query'; query: string; title: string };

export interface SearchHitVM {
  kind: 'task' | 'project' | 'label' | 'filter';
  /** task 的 id(kind='task' 时可直接开详情弹窗)、project/label/filter 的 id */
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

/** 保存的过滤器(Filters & Labels 视图)。 */
export interface FilterListItemVM {
  id: string;
  name: string;
  /** 查询原文(D-32/INV-33) */
  query: string;
  /** 命中的活跃任务数;查询语法错误时为 null */
  matchCount: number | null;
  /** 语法错误信息(有则视图上直接标红) */
  error: string | null;
}

/** 过滤器求值结果:顶层逗号分段,每段一列任务。 */
export interface FilterRunVM {
  query: string;
  sections: { source: string; tasks: TaskVM[] }[];
  error: string | null;
  /** 查询里引用了但当前不存在的标签/项目名(结果恒空,视图给提示) */
  unknownLabels: string[];
  unknownProjects: string[];
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
  /** 循环(D-37):须与 scheduledDate 搭配。⚠ TaskCard 用条件展开传字段 —— 条件展开会
   * 绕过 TS 的多余属性检查,这里没声明也不会报错,所以**必须**保持与 domain 入参同步 */
  repeat?: RepeatInputVM;
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

// ------------------------------------------------------------------ Agent(M9/M10)

/** 审批请求(主 → 渲染层)。渲染层必须回一次 `agent:permission.respond`,否则工具吊着。 */
export interface PermissionRequestVM {
  id: string;
  /** 对应聊天流里的工具 chip(让它显示"等待你批准…") */
  toolUseId: string;
  /** 短名,如 complete_task */
  tool: string;
  qualifiedTool: string;
  input: Record<string, unknown>;
  /** read | create | edit | destructive */
  toolClass: string;
  /** 因当前数据升级为破坏性的原因,如"会连带完成 3 个子任务" */
  escalation?: string;
  reason: string;
  mode: string;
}

export interface AuditRowVM {
  id: string;
  conversationId: string;
  toolName: string;
  inputJson: string;
  decision: 'allowed-auto' | 'allowed-user' | 'denied';
  resultSummary: string | null;
  createdAt: string;
}

export interface ConversationVM {
  id: string;
  sdkSessionId: string | null;
  title: string;
  model: string;
  createdAt: string;
  lastMessageAt: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  forkedFrom: string | null;
  active: boolean;
}

/** SDK ModelInfo 的子集 —— effort/thinking 支持情况决定 UI 里哪些选项可点。 */
export interface ModelInfoVM {
  value: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
}

export interface ToolManualEntryVM {
  qualified: string;
  name: string;
  description: string;
  kind: 'read' | 'write';
  destructive: boolean;
  params: { name: string; type: string; required: boolean; description: string }[];
}

// --------------------------------------------------- 账号与用量(M11-A)

/** 数据从哪来 —— 决定 UI 要不要打「本机缓存」的标。 */
export type UsageSourceVM = 'live-session' | 'probe' | 'local-cache' | 'none';

export interface UsageFreshnessVM {
  source: UsageSourceVM;
  /** 我们发起这次取数的时刻(epoch ms);绝不声称是服务端实时值 */
  fetchedAtMs: number | null;
  /** local-cache 时:缓存写入距今多久 */
  cacheAgeMs: number | null;
}

export type AuthMethodVM =
  'claude-ai' | 'oauth-token' | 'api-key' | 'third-party' | 'logged-out' | 'unknown';

export interface AccountVM {
  method: AuthMethodVM;
  /** 直接展示的中文串,如「Claude 账号」 */
  methodLabel: string;
  email: string | null;
  organization: string | null;
  /** SDK 给的已经是展示串,如 'Claude Max' —— 不要再加前缀 */
  planLabel: string | null;
  /** 环境里存在 ANTHROPIC_API_KEY:会被优先使用并按 API 计费 */
  apiKeyInEnv: boolean;
}

/** 一条额度进度条 */
export interface LimitWindowVM {
  id: string;
  label: string;
  /** 0–100,已 clamp */
  utilization: number;
  /** ISO8601;null = 服务端没给 */
  resetsAt: string | null;
}

export interface SubscriptionUsageVM {
  available: boolean;
  /** available=false 时说明原因 */
  unavailableReason: string | null;
  windows: LimitWindowVM[];
  extraUsage: {
    utilization: number | null;
    usedCredits: number | null;
    monthlyLimit: number | null;
    currency: string | null;
  } | null;
}

export interface BehaviorRowVM {
  key: string;
  /** 0–100,按成本加权;**类别彼此重叠,加起来可以超过 100** */
  pct: number;
  /** 命中次数。⚠ 单位在不同 key 下不一致(请求数 / 会话数),故 UI 不标单位 */
  count: number;
  headline: string;
  detail: string;
}

export interface AttributionRowVM {
  kind: 'agent' | 'skill' | 'mcp' | 'plugin';
  name: string;
  pct: number;
}

export interface ContributionWindowVM {
  requestCount: number;
  sessionCount: number;
  behaviors: BehaviorRowVM[];
  attributions: AttributionRowVM[];
}

export interface ContributionVM {
  day: ContributionWindowVM | null;
  week: ContributionWindowVM | null;
}

export interface AccountUsageVM {
  freshness: UsageFreshnessVM;
  account: AccountVM;
  usage: SubscriptionUsageVM;
  /** null = 拿不到(离线缓存里没有这块数据) */
  contribution: ContributionVM | null;
  /** 本应用自己的账本(与订阅额度是两回事) */
  appLedger: {
    session: { costUsd: number; inputTokens: number; outputTokens: number };
    totals: { conversations: number; costUsd: number; inputTokens: number; outputTokens: number };
  };
  error: string | null;
}

/** 护栏 */
export interface GuardrailsVM {
  /** null = 不限 */
  maxTurns: number | null;
  /** null = 不限;**下限 0.5,绝不能是 0** */
  maxBudgetUsd: number | null;
  /** 当前会话是否还在用旧值 */
  sessionAlive: boolean;
  sessionBusy: boolean;
}

/** 回滚预检(INV-35):确认框上的数字与执行结果同源 */
export interface RewindPreviewVM {
  entryCount: number;
  tools: { name: string; count: number }[];
  /** 会被**硬删除**的行数 —— 整套机制里唯一真正不可逆的部分 */
  hardDeleteCount: number;
  conflicts: { seq: number; toolName: string; detail: string }[];
  /** 链里混进的其它会话的条目数 */
  foreignEntryCount: number;
}

/** 回滚/分叉的锚点。本次会话的消息有 turnId,历史会话的只有 uuid(INV-35) */
export interface RewindAnchorVM {
  conversationId: string;
  turnId?: string | undefined;
  anchorUuid?: string | undefined;
}
