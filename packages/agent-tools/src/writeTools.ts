import {
  addComment,
  addSubtask,
  captureToInbox,
  completeProject,
  completeTask,
  createFilter,
  createFollowUp,
  createLabel,
  createProjectDirect,
  createWaitingForDirect,
  deleteTask,
  isUsecaseError,
  moveTask,
  quickAddTask,
  reopenTask,
  resolveWaitingFor,
  restoreTask,
  setTaskLabels,
  updateProject,
  updateTask,
} from '@gtd/domain';
import type {
  Command,
  FlowDeps,
  GtdSnapshot,
  GtdStore,
  Id,
  UpdateTaskPatch,
  UsecaseResult,
} from '@gtd/domain';

/**
 * 写工具的**纯逻辑层**(M9)。与只读层一样不 import SDK,便于直接对拍。
 *
 * 四条纪律:
 *
 * 1. **一次 usecase = 一个事务**(INV-17)。`store.apply(commands, 'agent')` 整批提交,
 *    绝不为了"分步汇报"把命令拆开。
 * 2. **consequences 原样回给模型**。INV-14/INV-15:拿到后果字段就意味着"该征询用户了"。
 *    工具**不替 agent 做决定**,只把后果如实摆出来 —— 判断留给 system prompt 与 skill。
 * 3. **零命令 ≠ 做了事**。domain 里空 patch 的 `updateTask`、同名的 `createLabel` 都返回
 *    `{commands: [], consequences}` —— 合法,但什么都没改。工具必须回报 `changed: false`,
 *    否则 agent 会对用户说"已经改好了"。
 * 4. **agent 面前不出现 uuid**。项目/标签按名字传,在这一层解析;解析不到就报错并把
 *    现有选项列出来,而不是静默建一个新的。
 *
 * **越界值挡在 zod schema**(见 index.ts):domain 对若干字段是**静默回退**而非报错
 * (`estimatedMinutes` 非法 → 15、`priority` 越界 → 3、quickAdd 的 `energy` 完全不校验)。
 * 靠 domain 兜底,agent 填错了也不会知道,于是把"我设成了 p9"说给用户听。
 */

export interface WriteToolDeps {
  store: GtdStore;
  deps: FlowDeps;
  /** 写入后通知宿主刷新(actor='agent';渲染层据此高亮 + toast) */
  onChanged: () => void;
}

export interface WriteResult {
  ok: boolean;
  /** false = usecase 成功但一条命令都没发 —— 等于什么都没改 */
  changed?: boolean;
  error?: string;
  [k: string]: unknown;
}

/** 统一应用路径:跑 usecase → 整批提交 → 通知刷新 → consequences 原样回传。 */
function apply<C extends object>(
  d: WriteToolDeps,
  run: (snap: GtdSnapshot) => UsecaseResult<C>,
): WriteResult {
  const r = run(d.store.snapshot());
  if (isUsecaseError(r)) return { ok: false, error: r.error };
  const commands: Command[] = r.commands;
  if (commands.length > 0) {
    d.store.apply(commands, 'agent');
    d.onChanged();
  }
  return { ok: true, changed: commands.length > 0, ...r.consequences };
}

// ------------------------------------------------------------------ 名字解析

type Resolved = { id: Id } | { error: string };

/** 项目按 id、id 前缀或名称解析(与 CLI 同口径)。 */
function resolveProject(snap: GtdSnapshot, ref: string): Resolved {
  const active = snap.projects.filter((p) => p.status === 'active');
  const exact = active.find((p) => p.id === ref || p.outcome === ref);
  if (exact) return { id: exact.id };
  const partial = active.filter((p) => p.id.startsWith(ref) || p.outcome.includes(ref));
  if (partial.length === 1) return { id: partial[0]!.id };
  if (partial.length > 1) {
    return { error: `项目引用有歧义: ${ref} → ${partial.map((p) => p.outcome).join(' / ')}` };
  }
  const have = active.map((p) => p.outcome).join(' / ') || '(无活跃项目)';
  return { error: `找不到项目: ${ref}(现有:${have})` };
}

/**
 * 标签按名字解析。**找不到就报错,绝不顺手新建** —— 否则一个错别字会静默造出
 * "@erands",而用户下次按 @errands 过滤时永远看不到这条任务。
 */
function resolveLabels(snap: GtdSnapshot, names: string[]): { ids: Id[] } | { error: string } {
  const ids: Id[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/^@+/, '').toLowerCase();
    const hit = snap.labels.find((l) => l.name.toLowerCase() === name);
    if (!hit) {
      const have = snap.labels.map((l) => `@${l.name}`).join(' ') || '(无)';
      return { error: `找不到标签 @${name}(现有:${have};要新建请先调 create_label)` };
    }
    ids.push(hit.id);
  }
  return { ids };
}

// ------------------------------------------------------------------ 创建

export function capture(d: WriteToolDeps, texts: string[]): WriteResult {
  return apply(d, (s) => captureToInbox(s, d.deps, { texts }));
}

/**
 * 工具入参来自模型生成的 JSON,可选字段天然可能是 `undefined`。
 * `exactOptionalPropertyTypes` 下 `x?: T` **不接受**显式 undefined,而 zod 解析出的对象
 * 恰恰会带上这些键 —— 所以边界类型一律写成 `?: T | undefined`。
 */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };

/** 与 domain 的 QuickAddTaskInput 同形,但项目/标签用名字。 */
export type CreateTaskArgs = { title: string } & Loose<{
  description: string;
  project: string;
  labels: string[];
  deadline: string;
  scheduledDate: string;
  startTime: string;
  durationMinutes: number;
  estimatedMinutes: number;
  energy: 'low' | 'medium' | 'high';
  priority: number;
  reminderAt: string;
  timeZone: string;
}>;

/** 把名字型入参翻成 domain 入参;其余字段原样透传(undefined 不落键,exactOptionalPropertyTypes)。 */
function taskFields(
  snap: GtdSnapshot,
  a: CreateTaskArgs,
): { fields: Record<string, unknown> } | { error: string } {
  const fields: Record<string, unknown> = { title: a.title };
  for (const k of [
    'description',
    'deadline',
    'scheduledDate',
    'startTime',
    'durationMinutes',
    'estimatedMinutes',
    'energy',
    'priority',
    'reminderAt',
    'timeZone',
  ] as const) {
    if (a[k] !== undefined) fields[k] = a[k];
  }
  if (a.project !== undefined) {
    const p = resolveProject(snap, a.project);
    if ('error' in p) return p;
    fields['projectId'] = p.id;
  }
  if (a.labels !== undefined && a.labels.length > 0) {
    const l = resolveLabels(snap, a.labels);
    if ('error' in l) return l;
    fields['labelIds'] = l.ids;
  }
  return { fields };
}

export function createTask(d: WriteToolDeps, a: CreateTaskArgs): WriteResult {
  const f = taskFields(d.store.snapshot(), a);
  if ('error' in f) return { ok: false, error: f.error };
  return apply(d, (s) => quickAddTask(s, d.deps, f.fields as never));
}

export function addSubtaskTool(
  d: WriteToolDeps,
  a: CreateTaskArgs & { parentTaskId: string },
): WriteResult {
  const f = taskFields(d.store.snapshot(), a);
  if ('error' in f) return { ok: false, error: f.error };
  // 子任务的容器由父任务决定(INV-25),project 参数在这里无意义
  delete f.fields['projectId'];
  const fields = { ...f.fields, parentTaskId: a.parentTaskId };
  return apply(d, (s) => addSubtask(s, d.deps, fields as never));
}

export function createProject(
  d: WriteToolDeps,
  a: { outcome: string; deadline?: string | undefined },
): WriteResult {
  return apply(d, (s) =>
    createProjectDirect(s, d.deps, {
      outcome: a.outcome,
      ...(a.deadline !== undefined ? { deadline: a.deadline } : {}),
    }),
  );
}

// ------------------------------------------------------------------ 修改

export interface UpdateTaskArgs extends UpdateTaskPatch {
  taskId: string;
}

export function updateTaskTool(d: WriteToolDeps, a: UpdateTaskArgs): WriteResult {
  const { taskId, ...rest } = a;
  const patch = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined),
  ) as UpdateTaskPatch;
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: '没给任何要改的字段' };
  }
  return apply(d, (s) => updateTask(s, d.deps, { id: taskId, patch }));
}

export function moveTaskTool(
  d: WriteToolDeps,
  a: {
    taskId: string;
    to: 'inbox' | 'someday' | 'reference' | 'project';
    project?: string | undefined;
  },
): WriteResult {
  const bucket = a.to;
  if (bucket !== 'project') {
    return apply(d, (s) => moveTask(s, d.deps, { id: a.taskId, to: { bucket } }));
  }
  if (a.project === undefined) return { ok: false, error: 'to=project 时必须给 project' };
  const p = resolveProject(d.store.snapshot(), a.project);
  if ('error' in p) return { ok: false, error: p.error };
  return apply(d, (s) =>
    moveTask(s, d.deps, { id: a.taskId, to: { bucket: 'project', projectId: p.id } }),
  );
}

/** 覆盖式:传入的就是最终集合(传 [] = 清空)。 */
export function setLabels(d: WriteToolDeps, a: { taskId: string; labels: string[] }): WriteResult {
  const l = resolveLabels(d.store.snapshot(), a.labels);
  if ('error' in l) return { ok: false, error: l.error };
  return apply(d, (s) => setTaskLabels(s, d.deps, { taskId: a.taskId, labelIds: l.ids }));
}

export function updateProjectTool(
  d: WriteToolDeps,
  a: { project: string } & Loose<{
    outcome: string;
    deadline: string | null;
    propagateDeadline: boolean;
  }>,
): WriteResult {
  const p = resolveProject(d.store.snapshot(), a.project);
  if ('error' in p) return { ok: false, error: p.error };
  const patch: { outcome?: string; deadline?: string | null } = {};
  if (a.outcome !== undefined) patch.outcome = a.outcome;
  if (a.deadline !== undefined) patch.deadline = a.deadline;
  if (Object.keys(patch).length === 0) return { ok: false, error: '没给任何要改的字段' };
  return apply(d, (s) =>
    updateProject(s, d.deps, {
      id: p.id,
      patch,
      ...(a.propagateDeadline === true ? { propagateDeadline: true } : {}),
    }),
  );
}

// ------------------------------------------------------------------ 完成 / 删除

export function completeTaskTool(d: WriteToolDeps, taskId: string): WriteResult {
  return apply(d, (s) => completeTask(s, d.deps, { id: taskId }));
}

export function reopenTaskTool(d: WriteToolDeps, taskId: string): WriteResult {
  return apply(d, (s) => reopenTask(s, d.deps, { id: taskId }));
}

export function completeProjectTool(d: WriteToolDeps, project: string): WriteResult {
  const p = resolveProject(d.store.snapshot(), project);
  if ('error' in p) return { ok: false, error: p.error };
  return apply(d, (s) => completeProject(s, d.deps, { id: p.id }));
}

export function deleteTaskTool(d: WriteToolDeps, taskId: string): WriteResult {
  return apply(d, (s) => deleteTask(s, d.deps, { id: taskId }));
}

export function restoreTaskTool(d: WriteToolDeps, taskId: string): WriteResult {
  return apply(d, (s) => restoreTask(s, d.deps, { id: taskId }));
}

// ------------------------------------------------------------------ 等待项

export function createWaitingFor(
  d: WriteToolDeps,
  a: { description: string } & Loose<{ delegatedTo: string; project: string }>,
): WriteResult {
  let projectId: Id | undefined;
  if (a.project !== undefined) {
    const p = resolveProject(d.store.snapshot(), a.project);
    if ('error' in p) return { ok: false, error: p.error };
    projectId = p.id;
  }
  return apply(d, (s) =>
    createWaitingForDirect(s, d.deps, {
      description: a.description,
      ...(a.delegatedTo !== undefined ? { delegatedTo: a.delegatedTo } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
    }),
  );
}

export function resolveWaiting(d: WriteToolDeps, id: string): WriteResult {
  return apply(d, (s) => resolveWaitingFor(s, d.deps, { id }));
}

export function followUp(d: WriteToolDeps, waitingForId: string): WriteResult {
  return apply(d, (s) => createFollowUp(s, d.deps, { waitingForId }));
}

// ------------------------------------------------------------------ 其它

export function comment(d: WriteToolDeps, a: { taskId: string; body: string }): WriteResult {
  return apply(d, (s) => addComment(s, d.deps, { taskId: a.taskId, body: a.body }));
}

export function createLabelTool(d: WriteToolDeps, name: string): WriteResult {
  return apply(d, (s) => createLabel(s, d.deps, { name }));
}

export function createFilterTool(
  d: WriteToolDeps,
  a: { name: string; query: string },
): WriteResult {
  return apply(d, (s) => createFilter(s, d.deps, { name: a.name, query: a.query }));
}
