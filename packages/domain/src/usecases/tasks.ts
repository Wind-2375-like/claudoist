import type { Energy, Id, IsoDate, IsoTime } from '../entities/common';
import type { Task } from '../entities/task';
import { MAX_SUBTASK_DEPTH, TASK_DEFAULTS } from '../entities/task';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import { applyToSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import { isValidIsoDate, isValidIsoTime } from '../rules/dates';
import { normalizePriority } from '../rules/priority';
import { inheritedTaskDeadline } from '../rules/deadlineInheritance';
import { hasActiveNextAction } from '../rules/projectHealth';
import { projectBreadcrumb } from '../rules/projectTree';
import { isValidTimeZone } from '../rules/dates';
import { isExternalTask } from '../rules/externalMirror';
import {
  bySortOrder,
  descendantTaskIds,
  isTaskListRoot,
  nextRootSortOrder,
  nextSortOrder,
  siblingGroup,
  subtreeHeight,
  taskDepth,
} from '../rules/subtasks';
import type { CompletionFollowUpConsequences, UsecaseResult } from './types';

/** Task 域 usecases(§4.2 Quick Add 扩展版 + 编辑/完成/软删/恢复)。 */

/**
 * §4.7 agent 路径共用:完成事件后的追问 payload。
 * after = 完成命令已应用的快照(完成后口径)。
 * BUG-02 守卫:无项目 / 项目不存在 / 已 complete → 空对象(不追问)。
 */
export function completionFollowUpConsequences(
  after: GtdSnapshot,
  projectId: Id | null,
): CompletionFollowUpConsequences {
  const c: CompletionFollowUpConsequences = {};
  if (projectId === null) return c;
  const p = after.projects.find((x) => x.id === projectId);
  if (!p || p.status === 'complete') return c;
  // 余活动 = active next action(INV-05,D-23/M6a:active Task ∨ 未解决 Waiting)
  const remaining = hasActiveNextAction(after, p.id);
  c.projectBreadcrumb = projectBreadcrumb(after, p.id);
  c.projectHasRemainingActivity = remaining;
  c.parentCompletionCandidate = !remaining;
  return c;
}

// ---------------------------------------------------------------- quickAddTask

export interface QuickAddTaskInput {
  title: string;
  contextId: Id;
  estimatedMinutes?: number;
  energy?: Energy;
  priority?: number;
  deadline?: IsoDate;
  projectId?: Id;
  /** 桌面扩展(M5R):补充说明 */
  description?: string;
  /** 桌面扩展(D-19):计划哪天做 */
  scheduledDate?: IsoDate;
  /** 多选既有 label(不存在的 id 报错) */
  labelIds?: Id[];
  /** 提醒时刻(本地 `YYYY-MM-DDTHH:MM`);落 reminders 表,响铃 M6 */
  reminderAt?: string;
  /** 日历统一(D-23/M6a):开始时刻 HH:MM(与 scheduledDate 搭配 = 日历 block) */
  startTime?: IsoTime;
  /** 日历 block 时长(分钟,≥1);缺省用 estimatedMinutes 兜底 */
  durationMinutes?: number;
  /** 时区(D-27/INV-31);缺省 = 浮动时间 */
  timeZone?: string;
}

export interface QuickAddTaskConsequences {
  taskId: Id;
  /** INV-10:所属项目有 deadline → 静默复制(无改填入口),此字段告知调用方 */
  inheritedDeadline?: IsoDate;
}

export function quickAddTask(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: QuickAddTaskInput,
): UsecaseResult<QuickAddTaskConsequences> {
  const title = input.title.trim();
  if (!title) return { error: 'title 不能为空' };
  const context = snap.contexts.find((c) => c.id === input.contextId && !c.archived);
  if (!context) return { error: `context 不存在或已归档: ${input.contextId}` };
  const projectId = input.projectId ?? null;
  // 与 moveTask 同口径:不能把新行动写进已完成项目(不可见容器)
  if (
    projectId !== null &&
    !snap.projects.some((p) => p.id === projectId && p.status === 'active')
  ) {
    return { error: `项目不存在或已完成: ${projectId}` };
  }
  // INV-03:写入侧强校验
  if (input.deadline !== undefined && !isValidIsoDate(input.deadline)) {
    return { error: `无效日期 ${input.deadline},格式须为 YYYY-MM-DD` };
  }
  if (input.scheduledDate !== undefined && !isValidIsoDate(input.scheduledDate)) {
    return { error: `无效计划日期 ${input.scheduledDate},格式须为 YYYY-MM-DD` };
  }
  if (input.startTime !== undefined && !isValidIsoTime(input.startTime)) {
    return { error: `无效时间 ${input.startTime},格式须为 HH:MM` };
  }
  if (
    input.durationMinutes !== undefined &&
    (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1)
  ) {
    return { error: `无效时长 ${input.durationMinutes},须为 ≥1 的整数分钟` };
  }
  if (input.reminderAt !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.reminderAt)) {
    return { error: `无效提醒时刻 ${input.reminderAt},格式须为 YYYY-MM-DDTHH:MM` };
  }
  for (const lid of input.labelIds ?? []) {
    if (!snap.labels.some((l) => l.id === lid)) return { error: `label 不存在: ${lid}` };
  }
  // INV-10:项目有 deadline → 无条件获得副本(即使调用方另填了 deadline)
  const inherited = inheritedTaskDeadline(snap, projectId);
  const deadline = inherited ?? input.deadline ?? null;
  const em = input.estimatedMinutes;
  const now = deps.clock.now();
  const task: Task = {
    id: deps.idGen.next(),
    title,
    contextId: context.id,
    // 非法输入回退默认(INVARIANTS §2.3;0 分钟不合法,§6 次要怪癖)
    estimatedMinutes:
      em !== undefined && Number.isInteger(em) && em >= 1 ? em : TASK_DEFAULTS.estimatedMinutes,
    energy: input.energy ?? TASK_DEFAULTS.energy,
    priority: normalizePriority(input.priority ?? TASK_DEFAULTS.priority),
    projectId,
    deadline,
    status: 'active',
    createdAt: now,
    completedAt: null,
    deletedAt: null,
    description: input.description?.trim() ?? TASK_DEFAULTS.description,
    scheduledDate: input.scheduledDate ?? null,
    bucket: projectId !== null ? 'project' : 'inbox', // D-20:'project' ⟺ projectId 非空
    parentTaskId: null, // 子任务走 addSubtask(INV-25)
    sortOrder: nextRootSortOrder(snap, {
      bucket: projectId !== null ? 'project' : 'inbox',
      projectId,
    }),
    startTime: input.startTime ?? null,
    durationMinutes: input.durationMinutes ?? null,
    timeZone: input.timeZone ?? null,
    externalId: null,
    externalCalendarId: null,
    pushedEventId: null,
    pushedFingerprint: null,
  };
  const commands: Command[] = [{ kind: 'createTask', task }];
  for (const labelId of input.labelIds ?? []) {
    commands.push({ kind: 'assignLabel', taskId: task.id, labelId });
  }
  if (input.reminderAt !== undefined) {
    commands.push({
      kind: 'createReminder',
      reminder: {
        id: deps.idGen.next(),
        taskId: task.id,
        remindAt: input.reminderAt,
        dispatched: false,
        createdAt: now,
      },
    });
  }
  const consequences: QuickAddTaskConsequences = { taskId: task.id };
  if (inherited !== null) consequences.inheritedDeadline = inherited;
  return { commands, consequences };
}

// -------------------------------------------------------------------- moveTask

/** 容器移动目的地(D-20)。 */
export type MoveTarget =
  { bucket: 'inbox' | 'someday' | 'reference' } | { bucket: 'project'; projectId: Id };

export interface MoveTaskInput {
  id: Id;
  to: MoveTarget;
}

export interface MoveTaskConsequences {
  taskId: Id;
  fromBucket: string;
  /** INV-10 move 版:挪入有 deadline 项目且任务无 deadline → 静默复制 */
  inheritedDeadline?: IsoDate;
  /** INV-25.4:被移动的是子任务 → 已脱离原父任务 */
  detachedFromParent?: boolean;
}

export function moveTask(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: MoveTaskInput,
): UsecaseResult<MoveTaskConsequences> {
  const task = snap.tasks.find((t) => t.id === input.id);
  if (!task) return { error: `行动不存在: ${input.id}` };
  if (task.status !== 'active') return { error: '只能移动 active 状态的行动' };
  const consequences: MoveTaskConsequences = { taskId: task.id, fromBucket: task.bucket };
  let bucket: Task['bucket'];
  let projectId: Id | null;
  let projectDeadline: IsoDate | null = null;
  if (input.to.bucket === 'project') {
    const project = snap.projects.find(
      (p) => p.id === (input.to as { projectId: Id }).projectId && p.status === 'active',
    );
    if (!project) return { error: `项目不存在或已完成` };
    bucket = 'project';
    projectId = project.id;
    projectDeadline = project.deadline;
  } else {
    bucket = input.to.bucket;
    projectId = null;
  }
  const commands: Command[] = [];
  // INV-25.3/25.4:根任务移动 = 整棵子树随动;子任务移动 = 先脱离父(连同其自身子树)
  // INV-27.3:落到目标容器时排到顶层展示列表末尾(含孤儿子任务根,见 nextRootSortOrder)
  const destSortOrder = nextRootSortOrder(snap, { bucket, projectId });
  const patchFor = (t: Task, detach: boolean): Partial<Omit<Task, 'id'>> => {
    const patch: Partial<Omit<Task, 'id'>> = { bucket, projectId };
    if (detach) {
      patch.parentTaskId = null;
      patch.sortOrder = destSortOrder;
    }
    // INV-10(move 版):挪入有 deadline 的项目时,无 deadline 的成员静默复制
    if (t.deadline === null && projectDeadline !== null) patch.deadline = projectDeadline;
    return patch;
  };
  if (task.parentTaskId !== null) consequences.detachedFromParent = true;
  commands.push({
    kind: 'updateTask',
    id: task.id,
    patch: { ...patchFor(task, task.parentTaskId !== null), sortOrder: destSortOrder },
  });
  if (task.deadline === null && projectDeadline !== null) {
    consequences.inheritedDeadline = projectDeadline;
  }
  const byId = new Map(snap.tasks.map((t) => [t.id, t]));
  for (const descId of descendantTaskIds(snap, task.id)) {
    const desc = byId.get(descId);
    if (!desc || desc.status === 'deleted') continue;
    commands.push({ kind: 'updateTask', id: descId, patch: patchFor(desc, false) });
  }
  return { commands, consequences };
}

// ----------------------------------------------------------------- reorderTask

/** 拖拽重排/嵌套(D-24/INV-27):同容器内换位或改父。 */
export interface ReorderTaskInput {
  id: Id;
  /** 新父任务(null = 顶层,即容器根组)。须与被移动任务同 bucket/projectId */
  parentTaskId: Id | null;
  /** 插到该同级任务之前;省略 = 追加到目标同级组末尾 */
  beforeId?: Id;
}

export interface ReorderTaskConsequences {
  taskId: Id;
  parentTaskId: Id | null;
}

export function reorderTask(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: ReorderTaskInput,
): UsecaseResult<ReorderTaskConsequences> {
  const task = snap.tasks.find((t) => t.id === input.id);
  if (!task) return { error: `行动不存在: ${input.id}` };
  if (task.status !== 'active') return { error: '只能拖拽 active 状态的行动' };

  const newParentId = input.parentTaskId;
  if (newParentId !== null) {
    if (newParentId === task.id) return { error: '不能把任务拖到自己下面' };
    const parent = snap.tasks.find((t) => t.id === newParentId);
    if (!parent || parent.status !== 'active') return { error: '目标父任务不存在或非活跃' };
    // 同容器约束(跨 bucket/项目走 Move to)
    if (parent.bucket !== task.bucket || parent.projectId !== task.projectId) {
      return { error: '只能在同一容器内拖拽(跨 Inbox/项目/Someday 请用 Move to)' };
    }
    // 防环:新父不能是被移动任务的后代
    if (descendantTaskIds(snap, task.id).includes(newParentId)) {
      return { error: '不能把任务拖到它自己的子任务下面' };
    }
    // INV-25 深度:新父层级 + 被移动子树高度 ≤ 5
    if (taskDepth(snap, newParentId) + subtreeHeight(snap, task.id) > MAX_SUBTASK_DEPTH) {
      return { error: `嵌套将超过 ${MAX_SUBTASK_DEPTH} 层(INV-25)` };
    }
  }
  // beforeId===自身:视为无锚点(追加到末尾),而非报错(拖回原位/微移是无副作用手势)
  const beforeId = input.beforeId === task.id ? undefined : input.beforeId;

  // 目标同级组(排除被移动任务本身),按当前序 → 在 beforeId 前插入 task → 整组重编号。
  // 顶层(newParentId=null)用**展示根集**(isTaskListRoot),与渲染层/nextRootSortOrder 口径
  // 一致 —— 否则父已 done/deleted 的孤儿子任务(在列表里作顶层行)不在组内,相对它拖拽会误报
  // "beforeId 不在目标同级组",且其旧 sortOrder 与重编号后的普通根撞值。
  const rawGroup =
    newParentId === null
      ? snap.tasks.filter(
          (t) =>
            t.bucket === task.bucket && t.projectId === task.projectId && isTaskListRoot(snap, t),
        )
      : siblingGroup(snap, {
          bucket: task.bucket,
          projectId: task.projectId,
          parentTaskId: newParentId,
        });
  // 只重排**展示中的活跃行**(与渲染层一致);done/deleted 不成行,保持其 sortOrder 不动。
  const group = rawGroup.filter((t) => t.id !== task.id && t.status === 'active').sort(bySortOrder);
  if (beforeId !== undefined && !group.some((t) => t.id === beforeId)) {
    return { error: `beforeId 不在目标同级组: ${beforeId}` };
  }
  const ordered: Task[] = [];
  for (const t of group) {
    if (t.id === beforeId) ordered.push(task);
    ordered.push(t);
  }
  if (beforeId === undefined) ordered.push(task);

  // 改父与否:落到具体父下(newParentId≠null)= 显式嵌套,总是改;落到顶层则仅当任务
  // 当前**嵌套显示中**(有活跃父)才是 outdent 需置 null —— 孤儿根(父仅 done)本就
  // 作顶层行显示,顶层重排只是排序,保留其父链接,父 reopen 后自然回归(INV-26/isTaskListRoot)。
  const reparent =
    task.parentTaskId !== newParentId && (newParentId !== null || !isTaskListRoot(snap, task));
  const commands: Command[] = ordered.map((t, i) => {
    const patch: Partial<Omit<Task, 'id'>> = { sortOrder: i };
    if (t.id === task.id && reparent) patch.parentTaskId = newParentId;
    return { kind: 'updateTask', id: t.id, patch };
  });
  return {
    commands,
    consequences: { taskId: task.id, parentTaskId: reparent ? newParentId : task.parentTaskId },
  };
}

// ------------------------------------------------------------------ addSubtask

export interface AddSubtaskInput {
  parentTaskId: Id;
  title: string;
  description?: string;
  estimatedMinutes?: number;
  energy?: Energy;
  priority?: number;
  deadline?: IsoDate;
  scheduledDate?: IsoDate;
  /** 缺省继承父任务的 context */
  contextId?: Id;
  /** D-22:子任务支持完整属性集(与顶层任务一致) */
  labelIds?: Id[];
  reminderAt?: string;
  /** 日历统一(D-23/M6a) */
  startTime?: IsoTime;
  durationMinutes?: number;
  /** 时区(D-27/INV-31);缺省 = 浮动时间 */
  timeZone?: string;
}

export interface AddSubtaskConsequences {
  taskId: Id;
  /** 所在层级(根 = 1) */
  depth: number;
  inheritedDeadline?: IsoDate;
}

/** INV-25:子任务继承父的 bucket/projectId(/contextId),链深 ≤ MAX_SUBTASK_DEPTH。 */
export function addSubtask(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: AddSubtaskInput,
): UsecaseResult<AddSubtaskConsequences> {
  const title = input.title.trim();
  if (!title) return { error: 'title 不能为空' };
  const parent = snap.tasks.find((t) => t.id === input.parentTaskId);
  if (!parent) return { error: `父任务不存在: ${input.parentTaskId}` };
  if (parent.status === 'deleted') return { error: '不能给已删除的任务加子任务' };
  const parentDepth = taskDepth(snap, parent.id);
  if (parentDepth >= MAX_SUBTASK_DEPTH) {
    return { error: `子任务最多嵌套 ${MAX_SUBTASK_DEPTH} 层(INV-25)` };
  }
  let contextId = parent.contextId;
  if (input.contextId !== undefined) {
    if (!snap.contexts.some((c) => c.id === input.contextId && !c.archived)) {
      return { error: `context 不存在或已归档: ${input.contextId}` };
    }
    contextId = input.contextId;
  }
  if (input.deadline !== undefined && !isValidIsoDate(input.deadline)) {
    return { error: `无效日期 ${input.deadline},格式须为 YYYY-MM-DD` };
  }
  if (input.scheduledDate !== undefined && !isValidIsoDate(input.scheduledDate)) {
    return { error: `无效计划日期 ${input.scheduledDate},格式须为 YYYY-MM-DD` };
  }
  if (input.startTime !== undefined && !isValidIsoTime(input.startTime)) {
    return { error: `无效时间 ${input.startTime},格式须为 HH:MM` };
  }
  if (
    input.durationMinutes !== undefined &&
    (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1)
  ) {
    return { error: `无效时长 ${input.durationMinutes},须为 ≥1 的整数分钟` };
  }
  if (input.reminderAt !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.reminderAt)) {
    return { error: `无效提醒时刻 ${input.reminderAt},格式须为 YYYY-MM-DDTHH:MM` };
  }
  for (const lid of input.labelIds ?? []) {
    if (!snap.labels.some((l) => l.id === lid)) return { error: `label 不存在: ${lid}` };
  }
  // INV-10:项目 deadline 无条件流向新行动(子任务同样)
  const inherited = inheritedTaskDeadline(snap, parent.projectId);
  const em = input.estimatedMinutes;
  const now = deps.clock.now();
  const task: Task = {
    id: deps.idGen.next(),
    title,
    contextId,
    estimatedMinutes:
      em !== undefined && Number.isInteger(em) && em >= 1 ? em : TASK_DEFAULTS.estimatedMinutes,
    energy: input.energy ?? TASK_DEFAULTS.energy,
    priority: normalizePriority(input.priority ?? TASK_DEFAULTS.priority),
    projectId: parent.projectId,
    deadline: inherited ?? input.deadline ?? null,
    status: 'active',
    createdAt: now,
    completedAt: null,
    deletedAt: null,
    description: input.description?.trim() ?? TASK_DEFAULTS.description,
    scheduledDate: input.scheduledDate ?? null,
    bucket: parent.bucket, // INV-25.2:容器与根一致
    parentTaskId: parent.id,
    sortOrder: nextSortOrder(snap, {
      bucket: parent.bucket,
      projectId: parent.projectId,
      parentTaskId: parent.id,
    }),
    startTime: input.startTime ?? null,
    durationMinutes: input.durationMinutes ?? null,
    timeZone: input.timeZone ?? null,
    externalId: null,
    externalCalendarId: null,
    pushedEventId: null,
    pushedFingerprint: null,
  };
  const commands: Command[] = [{ kind: 'createTask', task }];
  for (const labelId of input.labelIds ?? []) {
    commands.push({ kind: 'assignLabel', taskId: task.id, labelId });
  }
  if (input.reminderAt !== undefined) {
    commands.push({
      kind: 'createReminder',
      reminder: {
        id: deps.idGen.next(),
        taskId: task.id,
        remindAt: input.reminderAt,
        dispatched: false,
        createdAt: now,
      },
    });
  }
  const consequences: AddSubtaskConsequences = { taskId: task.id, depth: parentDepth + 1 };
  if (inherited !== null) consequences.inheritedDeadline = inherited;
  return { commands, consequences };
}

// ------------------------------------------------------------------ updateTask

/**
 * patch 白名单:status/completedAt/deletedAt/createdAt 不可经此修改(完成/删除走专用 usecase);
 * projectId/bucket/parentTaskId 不可经此修改(容器变更走 moveTask,保证子树一致性,INV-25)。
 */
export interface UpdateTaskPatch {
  title?: string;
  contextId?: Id;
  estimatedMinutes?: number;
  energy?: Energy;
  priority?: number;
  deadline?: IsoDate | null;
  description?: string;
  scheduledDate?: IsoDate | null;
  /** 日历统一(D-23/M6a):HH:MM;null = 清除(变全天) */
  startTime?: IsoTime | null;
  /** 日历 block 时长(分钟,≥1);null = 清除(回退 estimatedMinutes) */
  durationMinutes?: number | null;
  /** 时区:IANA 名或 null(= 浮动时间,跨时区不变) */
  timeZone?: string | null;
}

export interface UpdateTaskInput {
  id: Id;
  patch: UpdateTaskPatch;
}

export interface UpdateTaskConsequences {
  taskId: Id;
}

export function updateTask(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: UpdateTaskInput,
): UsecaseResult<UpdateTaskConsequences> {
  const task = snap.tasks.find((t) => t.id === input.id);
  if (!task) return { error: `行动不存在: ${input.id}` };
  const p = input.patch;
  // INV-29:外部镜像任务的标题与时间归外部拥有(本地改了也会被下次同步覆盖,
  // 且我们承诺永不回写 Google)—— 明确拒绝,而不是静默丢弃
  if (isExternalTask(task)) {
    const owned = (
      ['title', 'scheduledDate', 'startTime', 'durationMinutes', 'timeZone'] as const
    ).filter((k) => p[k] !== undefined);
    if (owned.length > 0) {
      return {
        error: `该任务来自 Google 日历,时间与标题请在 Google 日历中修改(${owned.join('/')})`,
      };
    }
  }
  // 逐字段显式拷贝 = 运行时白名单(IPC/agent 传入的额外键被丢弃)
  const clean: Partial<Omit<Task, 'id'>> = {};
  if (p.title !== undefined) {
    const title = p.title.trim();
    if (!title) return { error: 'title 不能为空' };
    clean.title = title;
  }
  if (p.contextId !== undefined) {
    if (!snap.contexts.some((c) => c.id === p.contextId && !c.archived)) {
      return { error: `context 不存在或已归档: ${p.contextId}` };
    }
    clean.contextId = p.contextId;
  }
  if (p.estimatedMinutes !== undefined) {
    clean.estimatedMinutes =
      Number.isInteger(p.estimatedMinutes) && p.estimatedMinutes >= 1
        ? p.estimatedMinutes
        : TASK_DEFAULTS.estimatedMinutes;
  }
  if (p.energy !== undefined) clean.energy = p.energy;
  if (p.priority !== undefined) clean.priority = normalizePriority(p.priority);
  if (p.deadline !== undefined) {
    // INV-03:写入侧强校验(null = 清除合法)
    if (p.deadline !== null && !isValidIsoDate(p.deadline)) {
      return { error: `无效日期 ${p.deadline},格式须为 YYYY-MM-DD` };
    }
    clean.deadline = p.deadline;
  }
  if (p.description !== undefined) clean.description = p.description.trim();
  if (p.scheduledDate !== undefined) {
    if (p.scheduledDate !== null && !isValidIsoDate(p.scheduledDate)) {
      return { error: `无效计划日期 ${p.scheduledDate},格式须为 YYYY-MM-DD` };
    }
    clean.scheduledDate = p.scheduledDate;
  }
  if (p.startTime !== undefined) {
    if (p.startTime !== null && !isValidIsoTime(p.startTime)) {
      return { error: `无效时间 ${p.startTime},格式须为 HH:MM` };
    }
    clean.startTime = p.startTime;
  }
  if (p.durationMinutes !== undefined) {
    if (
      p.durationMinutes !== null &&
      (!Number.isInteger(p.durationMinutes) || p.durationMinutes < 1)
    ) {
      return { error: `无效时长 ${p.durationMinutes},须为 ≥1 的整数分钟` };
    }
    clean.durationMinutes = p.durationMinutes;
  }
  if (p.timeZone !== undefined) {
    if (p.timeZone !== null && !isValidTimeZone(p.timeZone)) {
      return { error: `无效时区 ${p.timeZone}(须为 IANA 名,如 America/New_York)` };
    }
    clean.timeZone = p.timeZone;
  }
  const commands: Command[] =
    Object.keys(clean).length > 0 ? [{ kind: 'updateTask', id: task.id, patch: clean }] : [];
  return { commands, consequences: { taskId: task.id } };
}

// ---------------------------------------------------------------- completeTask

export interface CompleteTaskInput {
  id: Id;
}

export interface CompleteTaskConsequences extends CompletionFollowUpConsequences {
  /** INV-26.1(D-22):随本次一并完成的 active 后代子任务数(向下级联) */
  completedSubtaskCount: number;
}

export function completeTask(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: CompleteTaskInput,
): UsecaseResult<CompleteTaskConsequences> {
  const task = snap.tasks.find((t) => t.id === input.id);
  if (!task) return { error: `行动不存在: ${input.id}` };
  if (task.status !== 'active') return { error: `行动不是 active 状态: ${input.id}` };
  // INV-26.1(D-22):完成向下级联 —— 完成父任务 = 一并完成整棵 active 子树(单次动作的完整
  // 语义,INV-15 例外);方向仅向下(勾子任务不勾父)。同一命令批 = 一个事务(INV-17)。
  const patch = { status: 'done' as const, completedAt: deps.clock.now() };
  const commands: Command[] = [{ kind: 'updateTask', id: task.id, patch }];
  const byId = new Map(snap.tasks.map((t) => [t.id, t]));
  let completedSubtaskCount = 0;
  for (const descId of descendantTaskIds(snap, task.id)) {
    if (byId.get(descId)?.status !== 'active') continue;
    commands.push({ kind: 'updateTask', id: descId, patch });
    completedSubtaskCount += 1;
  }
  // INV-15:绝不自动完成父任务/项目 —— 项目以后果征询(after = 全子树完成后的口径)
  const after = applyToSnapshot(snap, commands);
  return {
    commands,
    consequences: {
      ...completionFollowUpConsequences(after, task.projectId),
      completedSubtaskCount,
    },
  };
}

// ------------------------------------------------------------------ deleteTask

export interface DeleteTaskInput {
  id: Id;
}

export interface DeleteTaskConsequences {
  /** INV-26.2:随本次删除一并软删的后代子任务数(UI 确认文案须带数量) */
  deletedSubtaskCount: number;
}

export function deleteTask(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: DeleteTaskInput,
): UsecaseResult<DeleteTaskConsequences> {
  const task = snap.tasks.find((t) => t.id === input.id);
  if (!task) return { error: `行动不存在: ${input.id}` };
  if (task.status === 'deleted') return { error: `行动已在 Trash: ${input.id}` };
  // 软删除(D-01/INV-22)+ 子树级联(INV-26.2):仅级联 active 后代——
  // done 后代保持 done(完成记录与项目进度不受删除父任务影响);同一命令批 = 一个事务(INV-17)
  const now = deps.clock.now();
  const patch = { status: 'deleted' as const, deletedAt: now };
  const commands: Command[] = [{ kind: 'updateTask', id: task.id, patch }];
  const byId = new Map(snap.tasks.map((t) => [t.id, t]));
  let deletedSubtaskCount = 0;
  for (const descId of descendantTaskIds(snap, task.id)) {
    if (byId.get(descId)?.status !== 'active') continue;
    commands.push({ kind: 'updateTask', id: descId, patch });
    deletedSubtaskCount += 1;
  }
  return { commands, consequences: { deletedSubtaskCount } };
}

// ------------------------------------------------------------------ reopenTask

export interface ReopenTaskInput {
  id: Id;
}

export interface ReopenTaskConsequences {
  taskId: Id;
}

/**
 * 重开(撤销完成,D-22):done → active、清 completedAt。仅当前任务,不级联
 * (误点完成圆圈后"再点一下复原";级联完成的子任务如需一并重开由用户逐个操作)。
 */
export function reopenTask(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: ReopenTaskInput,
): UsecaseResult<ReopenTaskConsequences> {
  const task = snap.tasks.find((t) => t.id === input.id);
  if (!task) return { error: `行动不存在: ${input.id}` };
  if (task.status !== 'done') return { error: `只能重开已完成的行动: ${input.id}` };
  const patch: Partial<Omit<Task, 'id'>> = { status: 'active', completedAt: null };
  // 与 restoreTask 同守卫:父任务缺失/已删 → 脱离父,避免重开出一个引用死父、
  // 在 projectView 里不可达却计入徽章的悬空子任务(父仅 done 时保留链接,靠
  // isTaskListRoot 让它在列表成行,父重开后自然回归)。
  if (task.parentTaskId !== null) {
    const parent = snap.tasks.find((t) => t.id === task.parentTaskId);
    if (!parent || parent.status === 'deleted') patch.parentTaskId = null;
  }
  return {
    commands: [{ kind: 'updateTask', id: task.id, patch }],
    consequences: { taskId: task.id },
  };
}

// ----------------------------------------------------------------- restoreTask

export interface RestoreTaskInput {
  id: Id;
}

export interface RestoreTaskConsequences {
  taskId: Id;
}

export function restoreTask(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: RestoreTaskInput,
): UsecaseResult<RestoreTaskConsequences> {
  const task = snap.tasks.find((t) => t.id === input.id);
  if (!task) return { error: `行动不存在: ${input.id}` };
  if (task.status !== 'deleted') return { error: `行动不在 Trash 中: ${input.id}` };
  // DESIGN §5.3:context 已 archived → 恢复前需重新指定 context(经 updateTask),此处拒绝
  const context = snap.contexts.find((c) => c.id === task.contextId);
  if (!context || context.archived) {
    return { error: `context 已归档,恢复前需先为行动重新指定 context: ${input.id}` };
  }
  // INV-26.2:恢复不级联;父任务仍在 Trash 时脱离父,避免恢复出不可见的悬挂子任务。
  // 删除前已完成(completedAt 非空)的任务恢复为 done,不洗掉完成记录
  const patch: Partial<Omit<Task, 'id'>> =
    task.completedAt !== null
      ? { status: 'done', deletedAt: null }
      : { status: 'active', deletedAt: null, completedAt: null };
  if (task.parentTaskId !== null) {
    const parent = snap.tasks.find((t) => t.id === task.parentTaskId);
    if (!parent || parent.status === 'deleted') patch.parentTaskId = null;
  }
  return {
    commands: [{ kind: 'updateTask', id: task.id, patch }],
    consequences: { taskId: task.id },
  };
}
