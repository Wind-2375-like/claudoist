import type {
  Clock,
  FlowDeps,
  GtdSnapshot,
  GtdStore,
  Id,
  IsoDate,
  Project,
  Task,
  UsecaseResult,
} from '@gtd/domain';
import {
  addComment,
  addContext,
  addDaysIso,
  blockEndMinutes,
  calendarDay,
  endTimeLabel,
  addSubtask,
  captureToInbox,
  completeProject,
  completeTask,
  createLabel,
  createProjectDirect,
  deleteTask,
  isTaskListRoot,
  isUsecaseError,
  isValidIsoDate,
  moveTask,
  priorityLabel,
  projectBreadcrumb,
  projectStats,
  quickAddTask,
  reopenTask,
  reorderTask,
  tasksWithInheritedDeadline,
  updateProject,
  updateTask,
} from '@gtd/domain';

/**
 * CLI 命令层(DESIGN §6.7):薄封装 domain usecases(唯一写路径),
 * 以 actor='agent' 应用命令。handler 纯函数 (store, deps, args) → {data, text},
 * 便于 vitest 直接测试;进程封装(argv/退出码/JSON 打印)在 main.ts。
 */

export class CliError extends Error {}

export interface CliArgs {
  positionals: string[];
  opts: Record<string, string | true>;
}

export interface CliOutput {
  /** --json 输出体(含 id,供 Claude Code 后续命令引用) */
  data: unknown;
  /** 人读输出 */
  text: string;
}

// ------------------------------------------------------------------ deps

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本地 naive 时间(INV-03;与 apps/desktop/src/main/clock.ts 同一口径)。 */
export const localClock: Clock = {
  now(): string {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },
  today(): string {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },
};

export function makeDeps(clock: Clock = localClock): FlowDeps {
  return { clock, idGen: { next: () => crypto.randomUUID() } };
}

// ------------------------------------------------------------------ helpers

function opt(args: CliArgs, name: string): string | undefined {
  const v = args.opts[name];
  if (v === undefined) return undefined;
  if (v === true) throw new CliError(`--${name} 需要值:--${name}=...`);
  return v;
}

/** today/tomorrow 便捷词 → 本地 YYYY-MM-DD;其余原样交 usecase 校验(INV-03)。 */
function parseDay(s: string, clock: Clock): string {
  if (s === 'today') return clock.today();
  if (s === 'tomorrow') {
    const [y, m, d] = clock.today().split('-').map(Number);
    const t = new Date(y!, m! - 1, d! + 1);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }
  return s;
}

function parseEnergy(s: string): 'low' | 'medium' | 'high' {
  if (s === 'low' || s === 'medium' || s === 'high') return s;
  throw new CliError(`无效 energy: ${s}(low|medium|high)`);
}

/** --duration 解析:update 允许 'none'(清除);其余须为 ≥1 整数分钟(报错回显原输入,不吐 NaN)。 */
function parseDuration(raw: string, allowNone: boolean): number | null {
  if (raw === 'none') {
    if (allowNone) return null;
    throw new CliError('--duration=none 仅用于 update(清除);add 想不设时长直接省略即可');
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new CliError(`无效时长 ${raw}(须为 ≥1 的整数分钟)`);
  }
  return Number(raw);
}

/** 带时间但未设日期的提示(D-23:startTime 须与 scheduledDate 搭配才会上 Today/日历)。 */
function danglingTimeHint(j: TaskJson): string {
  return j.startTime !== null && j.scheduledDate === null
    ? '(提示:未设 --date,该时间暂不会出现在 Today/日历)'
    : '';
}

/** 同级组排序(INV-27):sortOrder 升序,createdAt 兜底(反对称:全等返回 0,与桌面口径一致)。 */
const bySort = (a: Task, b: Task): number => {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  return 0;
};

/** 跨同级组的展示排序(list all / list project 混合多个组):createdAt 为准,避免组内 sortOrder 撞值乱序。 */
const byCreatedAt = (a: Task, b: Task): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;

/** 布尔 flag:裸 --x 或 --x=true;其余值报错(--x=yes 之类静默当 false 太危险)。 */
function flag(args: CliArgs, name: string): boolean {
  const v = args.opts[name];
  if (v === undefined) return false;
  if (v === true || v === 'true') return true;
  throw new CliError(`--${name} 是开关,不接受值 "${String(v)}"(直接写 --${name})`);
}

function applyUsecase<C>(store: GtdStore, r: UsecaseResult<C>): C {
  if (isUsecaseError(r)) throw new CliError(r.error);
  store.apply(r.commands, 'agent');
  return r.consequences;
}

/**
 * 任务引用:完整 id > id 前缀(唯一)> 标题全等。标题优先解析到**唯一的 active**;
 * 无 active 同名时回退到唯一的非 deleted(含 done,便于 show/reopen 已完成任务)。
 * 这样 complete/move/update/delete(只作用于 active)不会被同名 done 任务撞成歧义。
 */
export function findTask(snap: GtdSnapshot, ref: string): Task {
  const exact = snap.tasks.find((t) => t.id === ref);
  if (exact) return exact;
  const byPrefix = snap.tasks.filter((t) => t.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0]!;
  const byActive = snap.tasks.filter((t) => t.status === 'active' && t.title === ref);
  if (byActive.length === 1) return byActive[0]!;
  const byTitle = snap.tasks.filter((t) => t.status !== 'deleted' && t.title === ref);
  if (byActive.length === 0 && byTitle.length === 1) return byTitle[0]!;
  const cands = byPrefix.length > 1 ? byPrefix : byActive.length > 1 ? byActive : byTitle;
  if (cands.length > 1) {
    const list = cands.map((t) => `${t.id.slice(0, 8)} ${t.title}[${t.status}]`).join(' | ');
    throw new CliError(`任务引用不唯一: ${ref}(候选:${list})`);
  }
  throw new CliError(`找不到任务: ${ref}(可用 id/id 前缀/标题全等引用)`);
}

function findProject(snap: GtdSnapshot, ref: string): Project {
  const exact = snap.projects.find((p) => p.id === ref);
  if (exact) return exact;
  const byPrefix = snap.projects.filter((p) => p.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0]!;
  const byName = snap.projects.filter((p) => p.status === 'active' && p.outcome === ref);
  if (byName.length === 1) return byName[0]!;
  if (byPrefix.length + byName.length > 1) throw new CliError(`项目引用不唯一: ${ref}`);
  throw new CliError(`找不到项目: ${ref}(可用 id/id 前缀/名称全等;projects 命令查看)`);
}

function resolveContextId(snap: GtdSnapshot, ref: string | undefined): Id {
  const active = snap.contexts.filter((c) => !c.archived);
  if (ref === undefined) {
    const def = [...active].sort((a, b) => a.sortOrder - b.sortOrder)[0];
    if (!def) throw new CliError('没有可用 context(先 context-add <名称>)');
    return def.id;
  }
  const hit = active.find((c) => c.id === ref || c.name === ref);
  if (!hit) {
    throw new CliError(`找不到 context: ${ref}(现有:${active.map((c) => c.name).join(', ')})`);
  }
  return hit.id;
}

function resolveLabelIds(snap: GtdSnapshot, csv: string): Id[] {
  return csv.split(',').map((raw) => {
    const name = raw.trim();
    const hit = snap.labels.find((l) => l.id === name || l.name === name);
    if (!hit) {
      const have = snap.labels.map((l) => l.name).join(', ') || '(无)';
      throw new CliError(`找不到 label: ${name}(现有:${have};可 label-add 新建)`);
    }
    return hit.id;
  });
}

// ------------------------------------------------------------------ 输出

interface TaskJson {
  id: Id;
  title: string;
  status: string;
  bucket: string;
  project: string | null;
  projectId: Id | null;
  description: string;
  context: string;
  scheduledDate: IsoDate | null;
  deadline: IsoDate | null;
  overdue: boolean;
  priority: number;
  priorityLabel: string;
  labels: string[];
  estimatedMinutes: number;
  energy: string;
  completedAt: string | null;
  parentTaskId: Id | null;
  startTime: string | null;
  durationMinutes: number | null;
  timeZone: string | null;
}

function taskJson(snap: GtdSnapshot, t: Task, today: IsoDate): TaskJson {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    bucket: t.bucket,
    project: t.projectId !== null ? projectBreadcrumb(snap, t.projectId) || null : null,
    projectId: t.projectId,
    description: t.description,
    context: snap.contexts.find((c) => c.id === t.contextId)?.name ?? '?',
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
  };
}

function taskLine(j: TaskJson): string {
  const bits = [j.id.slice(0, 8), `${j.parentTaskId !== null ? '↳ ' : ''}${j.title}`];
  if (j.project !== null) bits.push(`[${j.project}]`);
  else if (j.bucket !== 'inbox') bits.push(`[${j.bucket}]`);
  if (j.scheduledDate !== null) bits.push(`📅${j.scheduledDate}`);
  if (j.startTime !== null) {
    const tz = j.timeZone !== null ? `(${j.timeZone})` : '';
    bits.push(`🕐${j.startTime}·${j.durationMinutes ?? j.estimatedMinutes}m${tz}`);
  }
  if (j.deadline !== null) bits.push(`⏰${j.deadline}${j.overdue ? '(过期)' : ''}`);
  if (j.priority !== 3) bits.push(`优先级:${j.priorityLabel}`); // 非默认才展示(D-14 文字)
  if (j.labels.length > 0) bits.push(j.labels.map((l) => `#${l}`).join(' '));
  bits.push(j.context); // context 名自带 @ 前缀(INV-24.1)
  return bits.join('  ');
}

function taskSection(title: string, rows: TaskJson[]): string {
  const body = rows.length === 0 ? '(空)' : rows.map((r) => `- ${taskLine(r)}`).join('\n');
  return `${title}(${rows.length})\n${body}`;
}

// ------------------------------------------------------------------ handlers

type Handler = (store: GtdStore, deps: FlowDeps, args: CliArgs) => CliOutput;

const add: Handler = (store, deps, args) => {
  const title = args.positionals.join(' ').trim();
  if (!title)
    throw new CliError(
      '用法: add <标题> [--parent=父任务(建子任务)] [--desc=] [--project=] [--date=] [--deadline=] [--time=HH:MM] [--duration=分钟] [--priority=1..5] [--labels=a,b] [--remind=YYYY-MM-DDTHH:MM] [--context=] [--minutes=] [--energy=low|medium|high]',
    );
  const snap = store.snapshot();
  const projectRef = opt(args, 'project');
  const parentRef = opt(args, 'parent');
  const date = opt(args, 'date');
  const deadline = opt(args, 'deadline');
  const priority = opt(args, 'priority');
  const minutes = opt(args, 'minutes');
  const energy = opt(args, 'energy');
  const labels = opt(args, 'labels');
  const remind = opt(args, 'remind');
  const desc = opt(args, 'desc');
  const time = opt(args, 'time');
  if (time === 'none') throw new CliError('--time=none 仅用于 update(清除)');
  const tz = opt(args, 'tz');
  const durationRaw = opt(args, 'duration');
  const duration = durationRaw !== undefined ? parseDuration(durationRaw, false) : undefined;
  // --parent = 建子任务(INV-25:容器/项目/context 继承父,≤5 层;D-22 支持完整属性集)
  if (parentRef !== undefined) {
    if (projectRef !== undefined)
      throw new CliError('--parent 与 --project 不能同用(子任务跟随父任务的项目)');
    const parent = findTask(snap, parentRef);
    const context = opt(args, 'context');
    const c = applyUsecase(
      store,
      addSubtask(snap, deps, {
        parentTaskId: parent.id,
        title,
        ...(desc !== undefined && { description: desc }),
        ...(date !== undefined && { scheduledDate: parseDay(date, deps.clock) }),
        ...(deadline !== undefined && { deadline: parseDay(deadline, deps.clock) }),
        ...(priority !== undefined && { priority: Number(priority) }),
        ...(minutes !== undefined && { estimatedMinutes: Number(minutes) }),
        ...(energy !== undefined && { energy: parseEnergy(energy) }),
        ...(context !== undefined && { contextId: resolveContextId(snap, context) }),
        ...(labels !== undefined && { labelIds: resolveLabelIds(snap, labels) }),
        ...(remind !== undefined && { reminderAt: remind }),
        ...(time !== undefined && { startTime: time }),
        ...(duration !== undefined && duration !== null && { durationMinutes: duration }),
        ...(tz !== undefined && tz !== 'floating' && { timeZone: tz }),
      }),
    );
    const after = store.snapshot();
    const j = taskJson(after, findTask(after, c.taskId), deps.clock.today());
    return {
      data: { ...j, depth: c.depth },
      text: `已添加子任务(第 ${c.depth} 层,父:${parent.title}): ${taskLine(j)}${danglingTimeHint(j)}`,
    };
  }
  const input = {
    title,
    contextId: resolveContextId(snap, opt(args, 'context')),
    ...(projectRef !== undefined && { projectId: findProject(snap, projectRef).id }),
    ...(desc !== undefined && { description: desc }),
    ...(date !== undefined && { scheduledDate: parseDay(date, deps.clock) }),
    ...(deadline !== undefined && { deadline: parseDay(deadline, deps.clock) }),
    ...(priority !== undefined && { priority: Number(priority) }),
    ...(minutes !== undefined && { estimatedMinutes: Number(minutes) }),
    ...(energy !== undefined && { energy: parseEnergy(energy) }),
    ...(labels !== undefined && { labelIds: resolveLabelIds(snap, labels) }),
    ...(remind !== undefined && { reminderAt: remind }),
    ...(time !== undefined && { startTime: time }),
    ...(duration !== undefined && duration !== null && { durationMinutes: duration }),
    ...(tz !== undefined && tz !== 'floating' && { timeZone: tz }),
  };
  const c = applyUsecase(store, quickAddTask(snap, deps, input));
  const after = store.snapshot();
  const j = taskJson(after, findTask(after, c.taskId), deps.clock.today());
  const notes = c.inheritedDeadline ? `(继承项目 deadline ${c.inheritedDeadline},INV-10)` : '';
  return { data: j, text: `已添加: ${taskLine(j)} ${notes}${danglingTimeHint(j)}`.trim() };
};

const capture: Handler = (store, deps, args) => {
  if (args.positionals.length === 0) throw new CliError('用法: capture <想法> [<想法>...]');
  const c = applyUsecase(
    store,
    captureToInbox(store.snapshot(), deps, { texts: args.positionals }),
  );
  const after = store.snapshot();
  const rows = c.createdIds.map((id) => taskJson(after, findTask(after, id), deps.clock.today()));
  return {
    data: rows,
    text: `已捕捉 ${rows.length} 条进 Inbox:\n${rows.map((r) => `- ${taskLine(r)}`).join('\n')}`,
  };
};

const list: Handler = (store, deps, args) => {
  const kind = args.positionals[0] ?? 'inbox';
  const snap = store.snapshot();
  const today = deps.clock.today();
  const byCreated = bySort;
  let rows: TaskJson[];
  if (kind === 'completed') {
    const limitRaw = opt(args, 'limit') ?? '200';
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CliError(`--limit 需为正整数,得到 "${limitRaw}"`);
    }
    rows = snap.tasks
      .filter((t) => t.status === 'done')
      .sort((a, b) => ((a.completedAt ?? '') > (b.completedAt ?? '') ? -1 : 1))
      .slice(0, limit)
      .map((t) => taskJson(snap, t, today));
    return { data: rows, text: taskSection(kind, rows) };
  }
  if (kind === 'all') {
    // 跨所有容器/同级组:sortOrder 是组内相对序,跨组无意义 → 以 createdAt 展示,避免撞值乱序
    rows = snap.tasks
      .filter((t) => t.status === 'active')
      .sort(byCreatedAt)
      .map((t) => taskJson(snap, t, today));
    return { data: rows, text: taskSection(kind, rows) };
  }
  if (kind === 'inbox' || kind === 'someday' || kind === 'reference' || kind === 'project') {
    // 树状显示(M5R5):根 = active list-root;子 = active 子任务递归,缩进呈现
    interface TreeJson extends TaskJson {
      children: TreeJson[];
    }
    const build = (t: Task): TreeJson => ({
      ...taskJson(snap, t, today),
      children: snap.tasks
        .filter((c) => c.parentTaskId === t.id && c.status === 'active')
        .sort(byCreated)
        .map(build),
    });
    // project 视图跨多个项目,各项目根组 sortOrder 各自从 0 起 → 先按 projectId 分组再组内排序;
    // inbox/someday/reference 为单一根组,直接 bySort。
    const rootCmp =
      kind === 'project'
        ? (a: Task, b: Task): number =>
            (a.projectId ?? '') < (b.projectId ?? '')
              ? -1
              : (a.projectId ?? '') > (b.projectId ?? '')
                ? 1
                : byCreated(a, b)
        : byCreated;
    const treeRoots = snap.tasks
      .filter((t) => t.status === 'active' && t.bucket === kind && isTaskListRoot(snap, t))
      .sort(rootCmp)
      .map(build);
    const lines: string[] = [];
    let count = 0;
    const walk = (nodes: TreeJson[], depth: number): void => {
      for (const n of nodes) {
        count += 1;
        lines.push(`${'  '.repeat(depth)}- ${taskLine(n)}`);
        walk(n.children, depth + 1);
      }
    };
    walk(treeRoots, 0);
    return {
      data: treeRoots,
      text: `${kind}(${count})\n${lines.length > 0 ? lines.join('\n') : '(空)'}`,
    };
  }
  throw new CliError(`未知列表: ${kind}(inbox|someday|reference|project|completed|all)`);
};

/** Today 三段式 —— 与 apps/desktop/src/main/ipc/gtd.ts today() 同口径(改动需同步)。 */
const today: Handler = (store, deps, _args) => {
  const snap = store.snapshot();
  const day = deps.clock.today();
  // D-23/M6a:hard-landscape 并入任务(带时间任务即日历 block);计划段排序 =
  // 计划日升序 → 全天在前 → startTime 升序(与桌面 today() 同口径,改动需同步)
  const engageable = (t: Task): boolean =>
    t.status === 'active' && t.bucket !== 'someday' && t.bucket !== 'reference';
  const scheduledToday = snap.tasks
    .filter((t) => engageable(t) && t.scheduledDate !== null && t.scheduledDate <= day)
    .sort((a, b) => {
      if (a.scheduledDate !== b.scheduledDate) return a.scheduledDate! < b.scheduledDate! ? -1 : 1;
      if ((a.startTime === null) !== (b.startTime === null)) return a.startTime === null ? -1 : 1;
      if (a.startTime !== b.startTime) return (a.startTime ?? '') < (b.startTime ?? '') ? -1 : 1;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    })
    .map((t) => taskJson(snap, t, day));
  const scheduledIds = new Set(scheduledToday.map((t) => t.id));
  // due 仅收未计划的过期项(与桌面 today() 同口径):计划到未来 = 显式推迟,不留 Today
  const due = snap.tasks
    .filter(
      (t) =>
        engageable(t) &&
        t.deadline !== null &&
        t.deadline <= day &&
        t.scheduledDate === null &&
        !scheduledIds.has(t.id),
    )
    .sort((a, b) => (a.deadline! < b.deadline! ? -1 : 1))
    .map((t) => taskJson(snap, t, day));
  // 统一列表(D-21/D-23,与 App Today 同构):计划项在前,其余按 deadline
  const tasks = [...scheduledToday, ...due];
  return {
    data: { today: day, tasks },
    text: [`Today ${day}`, taskSection('待办', tasks)].join('\n\n'),
  };
};

/**
 * 日历周视图(D-23/INV-28/M6b):与桌面网格同口径(domain calendarDay)。
 * 默认今天起 7 天;每日先全天段、再定时段(按时刻序)。
 */
const calendar: Handler = (store, deps, args) => {
  const snap = store.snapshot();
  const today = deps.clock.today();
  const from = parseDay(opt(args, 'from') ?? today, deps.clock);
  // 纯读路径没有 usecase 兜底校验:非法值会让 addDaysIso 原样返回 → from/days 自相矛盾
  if (!isValidIsoDate(from)) {
    throw new CliError(`--from 需为 today|tomorrow|YYYY-MM-DD,得到 "${from}"`);
  }
  const daysRaw = opt(args, 'days') ?? '7';
  const count = Number(daysRaw);
  if (!Number.isInteger(count) || count < 1 || count > 31) {
    throw new CliError(`--days 需为 1..31 的整数,得到 "${daysRaw}"`);
  }
  const lines: string[] = [];
  const data = Array.from({ length: count }, (_, i) => {
    const date = addDaysIso(from, i);
    const { allDay, timed } = calendarDay(snap, date);
    lines.push(`${date}${date === today ? '(今天)' : ''}`);
    if (allDay.length === 0 && timed.length === 0) lines.push('  (空)');
    for (const t of allDay) lines.push(`  全天         ${taskLine(taskJson(snap, t, today))}`);
    for (const t of timed) {
      const span = `${t.startTime}–${endTimeLabel(blockEndMinutes(t))}`;
      lines.push(`  ${span}  ${taskLine(taskJson(snap, t, today))}`);
    }
    return {
      date,
      isToday: date === today,
      allDay: allDay.map((t) => taskJson(snap, t, today)),
      timed: timed.map((t) => taskJson(snap, t, today)),
    };
  });
  return {
    data: { from, to: addDaysIso(from, count - 1), days: data },
    text: `Calendar ${from} — ${addDaysIso(from, count - 1)}\n${lines.join('\n')}`,
  };
};

const projects: Handler = (store, _deps, _args) => {
  const snap = store.snapshot();
  const rows = snap.projects
    .filter((p) => p.status === 'active')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((p) => {
      const stats = projectStats(snap, p.id);
      return {
        id: p.id,
        name: p.outcome,
        deadline: p.deadline,
        activeCount: stats.activeCount,
        doneCount: stats.doneCount,
        progressPct: Math.round(stats.progress * 100),
      };
    });
  const bar = (pct: number): string => {
    const filled = Math.round(pct / 10);
    return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
  };
  const lines = rows.map(
    (p) =>
      `- ${p.id.slice(0, 8)}  ${p.name}${p.deadline ? `  ⏰${p.deadline}` : ''}  ${bar(p.progressPct)} ${p.progressPct}%(${p.activeCount} 未完成 / ${p.doneCount} 已完成)`,
  );
  return {
    data: rows,
    text: rows.length === 0 ? '(无 active 项目)' : `项目(D-21 平面)\n${lines.join('\n')}`,
  };
};

const projectAdd: Handler = (store, deps, args) => {
  const outcome = args.positionals.join(' ').trim();
  if (!outcome) throw new CliError('用法: project-add <成果描述> [--deadline=]');
  const snap = store.snapshot();
  const deadline = opt(args, 'deadline');
  const c = applyUsecase(
    store,
    createProjectDirect(snap, deps, {
      outcome,
      ...(deadline !== undefined && { deadline: parseDay(deadline, deps.clock) }),
    }),
  );
  return {
    data: { projectId: c.projectId },
    text: `已创建项目 ${c.projectId.slice(0, 8)}: ${outcome}(记得 add --project= 补第一个行动)`,
  };
};

const projectUpdate: Handler = (store, deps, args) => {
  const ref = args.positionals[0];
  if (!ref) {
    throw new CliError(
      '用法: project-update <项目> [--name=] [--deadline=|none] [--propagate|--keep-tasks]',
    );
  }
  const snap = store.snapshot();
  const project = findProject(snap, ref);
  const name = opt(args, 'name');
  const deadline = opt(args, 'deadline');
  const propagate = flag(args, 'propagate');
  const keepTasks = flag(args, 'keep-tasks');
  if (name === undefined && deadline === undefined) throw new CliError('没有要更新的字段');
  // §5.4 单次调用模型:旧值写掉后传播窗口即关闭 —— 改 deadline 且命中继承行动时,
  // 必须在**本次调用**显式二选一,不给"事后补跑"的死路
  const newDeadline =
    deadline === undefined
      ? undefined
      : deadline === 'none'
        ? null
        : parseDay(deadline, deps.clock);
  if (newDeadline !== undefined && newDeadline !== project.deadline && !propagate && !keepTasks) {
    const n = tasksWithInheritedDeadline(snap, project.id, project.deadline).length;
    if (n > 0) {
      throw new CliError(
        `该项目有 ${n} 个行动的 deadline 与旧值(${project.deadline})相同。请显式选择:\n` +
          `  --propagate   同步把这 ${n} 个行动的 deadline 也改为新值\n` +
          `  --keep-tasks  只改项目,行动保持不变\n` +
          `(传播只在本次改动时可选,事后无法按旧值补做 —— INV-12 copy 语义)`,
      );
    }
  }
  const c = applyUsecase(
    store,
    updateProject(snap, deps, {
      id: project.id,
      patch: {
        ...(name !== undefined && { outcome: name }),
        ...(newDeadline !== undefined && { deadline: newDeadline }),
      },
      ...(propagate && { propagateDeadline: true }),
    }),
  );
  const n = c.tasksWithInheritedDeadline?.length ?? 0;
  const note =
    c.propagated === true
      ? `(已同步更新 ${n} 个行动的 deadline)`
      : n > 0
        ? `(${n} 个行动的 deadline 保持不变)`
        : '';
  return {
    data: { projectId: project.id, ...c },
    text: `已更新项目: ${project.outcome} ${note}`.trim(),
  };
};

const projectComplete: Handler = (store, deps, args) => {
  const ref = args.positionals[0];
  if (!ref) throw new CliError('用法: project-complete <项目>');
  const snap = store.snapshot();
  const project = findProject(snap, ref);
  const c = applyUsecase(store, completeProject(snap, deps, { id: project.id }));
  const note =
    c.activeTaskCount > 0 ? `(其中 ${c.activeTaskCount} 个未完成任务保持不变,INV-15)` : '';
  return {
    data: { projectId: project.id, ...c },
    text: `已完成项目: ${project.outcome} ${note}`.trim(),
  };
};

const comment: Handler = (store, deps, args) => {
  const [taskRef, ...rest] = args.positionals;
  const body = rest.join(' ').trim();
  if (!taskRef || !body) throw new CliError('用法: comment <任务> <评论内容>');
  const snap = store.snapshot();
  const task = findTask(snap, taskRef);
  const c = applyUsecase(store, addComment(snap, deps, { taskId: task.id, body }));
  return {
    data: { commentId: c.commentId, taskId: task.id },
    text: `已评论「${task.title}」: ${body}`,
  };
};

const move: Handler = (store, deps, args) => {
  const [taskRef, dest] = args.positionals;
  if (!taskRef || !dest) throw new CliError('用法: move <任务> <inbox|someday|reference|项目引用>');
  const snap = store.snapshot();
  const task = findTask(snap, taskRef);
  const to =
    dest === 'inbox' || dest === 'someday' || dest === 'reference'
      ? ({ bucket: dest } as const)
      : ({ bucket: 'project', projectId: findProject(snap, dest).id } as const);
  const c = applyUsecase(store, moveTask(snap, deps, { id: task.id, to }));
  const after = store.snapshot();
  const j = taskJson(after, findTask(after, task.id), deps.clock.today());
  const notes = [
    c.inheritedDeadline ? `继承项目 deadline ${c.inheritedDeadline}` : '',
    c.detachedFromParent ? '已脱离原父任务(INV-25.4)' : '',
  ]
    .filter(Boolean)
    .join(';');
  return { data: j, text: `已移动(子任务随动): ${taskLine(j)}${notes ? `(${notes})` : ''}` };
};

const reorder: Handler = (store, deps, args) => {
  const ref = args.positionals[0];
  if (!ref) {
    throw new CliError(
      '用法: reorder <任务> [--parent=父任务|--top] [--before=同级任务]\n' +
        '  --parent 拖成某任务的子任务;--top 提到容器顶层;--before 插到某同级之前(缺省=末尾)',
    );
  }
  const snap = store.snapshot();
  const task = findTask(snap, ref);
  const parentRef = opt(args, 'parent');
  const beforeRef = opt(args, 'before');
  const top = flag(args, 'top'); // 开关校验:--top=value 报错而非静默忽略
  if (parentRef !== undefined && top) {
    throw new CliError('--parent 与 --top 不能同用');
  }
  // parentTaskId:--parent=<任务> → 其 id;--top → null;都不给 → 保持当前父
  const parentTaskId =
    parentRef !== undefined ? findTask(snap, parentRef).id : top ? null : task.parentTaskId;
  const c = applyUsecase(
    store,
    reorderTask(snap, deps, {
      id: task.id,
      parentTaskId,
      ...(beforeRef !== undefined && { beforeId: findTask(snap, beforeRef).id }),
    }),
  );
  const after = store.snapshot();
  const j = taskJson(after, findTask(after, task.id), deps.clock.today());
  return {
    data: { taskId: c.taskId, parentTaskId: c.parentTaskId },
    text: `已重排: ${taskLine(j)}${c.parentTaskId !== null ? '(现为子任务)' : ''}`,
  };
};

const complete: Handler = (store, deps, args) => {
  const ref = args.positionals[0];
  if (!ref) throw new CliError('用法: complete <任务>');
  const snap = store.snapshot();
  const task = findTask(snap, ref);
  const c = applyUsecase(store, completeTask(snap, deps, { id: task.id }));
  let followUp = '';
  // INV-26.1(D-22):完成向下级联;项目仍以后果征询,绝不自动完成项目
  if (c.completedSubtaskCount > 0) {
    followUp += `\n连同 ${c.completedSubtaskCount} 个子任务一并完成(D-22)。`;
  }
  if (c.parentCompletionCandidate === true) {
    followUp += `\n项目「${c.projectBreadcrumb}」已无余活动 —— 经用户确认后可用 project-complete 完成它。`;
  } else if (c.projectHasRemainingActivity === true) {
    followUp += `\n项目「${c.projectBreadcrumb}」仍有余活动。`;
  }
  return { data: { taskId: task.id, ...c }, text: `已完成: ${task.title}${followUp}` };
};

const reopen: Handler = (store, deps, args) => {
  const ref = args.positionals[0];
  if (!ref) throw new CliError('用法: reopen <任务>(撤销完成:done → active,仅当前任务)');
  const snap = store.snapshot();
  const task = findTask(snap, ref);
  const c = applyUsecase(store, reopenTask(snap, deps, { id: task.id }));
  return { data: { taskId: c.taskId }, text: `已重开: ${task.title}` };
};

const del: Handler = (store, deps, args) => {
  const ref = args.positionals[0];
  if (!ref) throw new CliError('用法: delete <任务>');
  const snap = store.snapshot();
  const task = findTask(snap, ref);
  const c = applyUsecase(store, deleteTask(snap, deps, { id: task.id }));
  const note =
    c.deletedSubtaskCount > 0 ? `(连同 ${c.deletedSubtaskCount} 个子任务一并软删,INV-26)` : '';
  return { data: { taskId: task.id, ...c }, text: `已删除(软删): ${task.title} ${note}`.trim() };
};

const update: Handler = (store, deps, args) => {
  const ref = args.positionals[0];
  if (!ref) {
    throw new CliError(
      '用法: update <任务> [--title=] [--desc=] [--date=|none] [--deadline=|none] [--time=HH:MM|none] [--duration=分钟|none] [--priority=] [--context=] [--minutes=] [--energy=]',
    );
  }
  const snap = store.snapshot();
  const task = findTask(snap, ref);
  const title = opt(args, 'title');
  const desc = opt(args, 'desc');
  const date = opt(args, 'date');
  const deadline = opt(args, 'deadline');
  const priority = opt(args, 'priority');
  const context = opt(args, 'context');
  const minutes = opt(args, 'minutes');
  const energy = opt(args, 'energy');
  const time = opt(args, 'time');
  const duration = opt(args, 'duration');
  const tzu = opt(args, 'tz');
  const patch = {
    ...(title !== undefined && { title }),
    ...(desc !== undefined && { description: desc }),
    ...(date !== undefined && {
      scheduledDate: date === 'none' ? null : parseDay(date, deps.clock),
    }),
    ...(deadline !== undefined && {
      deadline: deadline === 'none' ? null : parseDay(deadline, deps.clock),
    }),
    ...(priority !== undefined && { priority: Number(priority) }),
    ...(context !== undefined && { contextId: resolveContextId(snap, context) }),
    ...(minutes !== undefined && { estimatedMinutes: Number(minutes) }),
    ...(energy !== undefined && { energy: parseEnergy(energy) }),
    ...(time !== undefined && { startTime: time === 'none' ? null : time }),
    ...(duration !== undefined && { durationMinutes: parseDuration(duration, true) }),
    ...(tzu !== undefined && { timeZone: tzu === 'floating' || tzu === 'none' ? null : tzu }),
  };
  if (Object.keys(patch).length === 0) throw new CliError('没有要更新的字段');
  applyUsecase(store, updateTask(snap, deps, { id: task.id, patch }));
  const after = store.snapshot();
  const j = taskJson(after, findTask(after, task.id), deps.clock.today());
  return { data: j, text: `已更新: ${taskLine(j)}${danglingTimeHint(j)}` };
};

const show: Handler = (store, deps, args) => {
  const ref = args.positionals[0];
  if (!ref) throw new CliError('用法: show <任务>');
  const snap = store.snapshot();
  const t = findTask(snap, ref);
  const today = deps.clock.today();
  const j = taskJson(snap, t, today);
  const reminders = snap.reminders
    .filter((r) => r.taskId === t.id)
    .map((r) => r.remindAt + (r.dispatched ? '(已提醒)' : ''));
  // 子任务树(D-21;≤5 层,排除已删除)
  interface SubtaskJson extends TaskJson {
    children: SubtaskJson[];
  }
  const subtree = (parent: Task): SubtaskJson[] =>
    snap.tasks
      .filter((x) => x.parentTaskId === parent.id && x.status !== 'deleted')
      .sort(bySort)
      .map((x) => ({ ...taskJson(snap, x, today), children: subtree(x) }));
  const subtasks = subtree(t);
  const subtaskLines: string[] = [];
  const walk = (nodes: SubtaskJson[], depth: number): void => {
    for (const n of nodes) {
      subtaskLines.push(
        `${'  '.repeat(depth)}- ${n.completedAt !== null ? '✓ ' : ''}${n.id.slice(0, 8)}  ${n.title}`,
      );
      walk(n.children, depth + 1);
    }
  };
  walk(subtasks, 1);
  const comments = snap.comments
    .filter((c) => c.taskId === t.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt }));
  const parent =
    t.parentTaskId !== null ? snap.tasks.find((x) => x.id === t.parentTaskId) : undefined;
  const lines = [
    `${j.title}  [${j.status}]`,
    `id: ${j.id}`,
    `位置: ${j.project !== null ? `project: ${j.project}` : j.bucket}`,
    parent && `父任务: ${parent.id.slice(0, 8)}  ${parent.title}`,
    j.description && `描述: ${j.description}`,
    j.scheduledDate !== null && `计划日期: ${j.scheduledDate}`,
    j.deadline !== null && `deadline: ${j.deadline}${j.overdue ? '(过期)' : ''}`,
    `优先级: ${j.priorityLabel}  ·  ${j.context}  ·  ${j.estimatedMinutes} 分钟  ·  精力 ${j.energy}`,
    j.labels.length > 0 && `labels: ${j.labels.join(', ')}`,
    reminders.length > 0 && `提醒: ${reminders.join(', ')}`,
    j.completedAt !== null && `完成于: ${j.completedAt}`,
    subtaskLines.length > 0 && `子任务:\n${subtaskLines.join('\n')}`,
    comments.length > 0 &&
      `评论:\n${comments.map((c) => `  [${c.createdAt.replace('T', ' ')}] ${c.body}`).join('\n')}`,
  ].filter(Boolean);
  return { data: { ...j, reminders, subtasks, comments }, text: lines.join('\n') };
};

const contexts: Handler = (store, _deps, _args) => {
  const snap = store.snapshot();
  const rows = snap.contexts
    .filter((c) => !c.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((c) => ({
      id: c.id,
      name: c.name,
      activeTaskCount: snap.tasks.filter((t) => t.contextId === c.id && t.status === 'active')
        .length,
    }));
  return {
    data: rows,
    text:
      rows.length === 0
        ? '(无 context;context-add <名称> 新建)'
        : rows.map((c) => `- ${c.name}(${c.activeTaskCount} 行动)  ${c.id.slice(0, 8)}`).join('\n'),
  };
};

const contextAdd: Handler = (store, deps, args) => {
  const name = args.positionals.join(' ').trim();
  if (!name) throw new CliError('用法: context-add <名称>');
  const c = applyUsecase(store, addContext(store.snapshot(), deps, { name }));
  return { data: c, text: `已创建 context: ${name}` };
};

const labels: Handler = (store, _deps, _args) => {
  const rows = store.snapshot().labels.map((l) => ({ id: l.id, name: l.name }));
  return {
    data: rows,
    text:
      rows.length === 0
        ? '(无 label)'
        : rows.map((l) => `- #${l.name}  ${l.id.slice(0, 8)}`).join('\n'),
  };
};

const labelAdd: Handler = (store, deps, args) => {
  const name = args.positionals.join(' ').trim();
  if (!name) throw new CliError('用法: label-add <名称>');
  const c = applyUsecase(store, createLabel(store.snapshot(), deps, { name }));
  return { data: c, text: `已创建 label: #${name}` };
};

export const HELP = `Claudoist CLI — 经 domain usecase 操作任务数据(与 App 同一 DB,写入后 App 自动刷新)

用法: pnpm --silent cli <命令> [参数] [--json] [--db=路径|--dev|--prod]

命令:
  add <标题> [--parent=父任务(建子任务,≤5 层)] [--desc=] [--project=]
             [--date=today|tomorrow|YYYY-MM-DD] [--deadline=]
             [--time=HH:MM(日历 block,D-23)] [--duration=分钟] [--tz=floating|IANA]
             [--priority=1..5(1最低,5最高)] [--labels=a,b] [--remind=YYYY-MM-DDTHH:MM]
             [--context=] [--minutes=] [--energy=low|medium|high]
  capture <想法> [<想法>...]        逐条捕捉进 Inbox(零判断,INV-16)
  list [inbox|someday|reference|project|completed|all]   completed 可加 --limit=N
  today                             统一待办(计划 ≤ 今天 ∪ 截止 ≤ 今天;带时间任务按时刻排)
  calendar [--from=today|tomorrow|YYYY-MM-DD] [--days=1..31]  日历周视图(全天段 + 定时段,INV-28)
  show <任务>                       任务详情(含子任务树 / 评论 / 提醒)
  comment <任务> <内容>             加评论
  move <任务> <inbox|someday|reference|项目引用>   根任务子树随动;子任务先脱离父
  reorder <任务> [--parent=|--top] [--before=]     手动排序/拖成子任务(同容器,INV-27)
  complete <任务>                   完成(向下级联完成子树,D-22;项目余活动以提示返回)
  reopen <任务>                     撤销完成(done → active,仅当前任务)
  update <任务> [--title=] [--desc=] [--date=|none] [--deadline=|none] [--priority=] ...
  delete <任务>                     软删除(active 子树级联,输出数量;done 子任务保留)
  projects                          平面项目 + 进度 / project-add <成果> [--deadline=]
  project-update <项目> [--name=] [--deadline=|none] [--propagate|--keep-tasks]
                                    改 deadline 命中继承行动时须显式二选一(INV-12)
  project-complete <项目>           标记项目完成(任务状态不动,INV-15)
  contexts / context-add <名称>     labels / label-add <名称>

任务/项目引用:完整 id、id 前缀(唯一)或标题全等。--json 输出 {ok, db, data}(data 含 id)。
DB 定位:CLAUDOIST_DB 环境变量 > --db= > --prod/--dev > 自动(dev 库存在且 prod 不存在则 dev,否则 prod)。`;

const HANDLERS: Record<string, Handler> = {
  add,
  capture,
  list,
  today,
  calendar,
  show,
  comment,
  move,
  reorder,
  complete,
  reopen,
  update,
  delete: del,
  projects,
  'project-add': projectAdd,
  'project-update': projectUpdate,
  'project-complete': projectComplete,
  contexts,
  'context-add': contextAdd,
  labels,
  'label-add': labelAdd,
};

/** 每命令合法选项白名单(GLOBAL 由 main.ts 消化)——拼错的 -- 选项必须报错,不许无声丢数据。 */
const GLOBAL_OPTS = ['json', 'db', 'dev', 'prod', 'help'];
const COMMAND_OPTS: Record<string, string[]> = {
  calendar: ['from', 'days'],
  add: [
    'parent',
    'desc',
    'project',
    'date',
    'deadline',
    'time',
    'duration',
    'tz',
    'priority',
    'labels',
    'remind',
    'context',
    'minutes',
    'energy',
  ],
  capture: [],
  list: ['limit'],
  today: [],
  show: [],
  comment: [],
  move: [],
  reorder: ['parent', 'top', 'before'],
  complete: [],
  reopen: [],
  update: [
    'title',
    'desc',
    'date',
    'deadline',
    'time',
    'duration',
    'tz',
    'priority',
    'context',
    'minutes',
    'energy',
  ],
  delete: [],
  projects: [],
  'project-add': ['deadline'],
  'project-update': ['name', 'deadline', 'propagate', 'keep-tasks'],
  'project-complete': [],
  contexts: [],
  'context-add': [],
  labels: [],
  'label-add': [],
};

export function runCommand(cmd: string, store: GtdStore, deps: FlowDeps, args: CliArgs): CliOutput {
  const handler = HANDLERS[cmd];
  if (!handler) throw new CliError(`未知命令: ${cmd}\n\n${HELP}`);
  const allowed = new Set([...GLOBAL_OPTS, ...(COMMAND_OPTS[cmd] ?? [])]);
  const unknown = Object.keys(args.opts).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new CliError(
      `${cmd} 不认识选项:${unknown.map((k) => `--${k}`).join(', ')}(可用:${(COMMAND_OPTS[cmd] ?? []).map((k) => `--${k}`).join(', ') || '无'})`,
    );
  }
  return handler(store, deps, args);
}
