import type {
  RepeatInput,
  Clock,
  FlowDeps,
  GtdSnapshot,
  GtdStore,
  Id,
  Project,
  Task,
  TaskView,
  UsecaseResult,
} from '@gtd/domain';
import {
  ENGAGE_TOP_N,
  addComment,
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
  engageMatches,
  isTaskListRoot,
  isUsecaseError,
  isValidIsoDate,
  moveTask,
  projectStats,
  byProjectSort,
  todayList,
  quickAddTask,
  reopenTask,
  reorderTask,
  createFilter,
  parseFilterQuery,
  foldDoneTasks,
  parseRepeatShorthand,
  weekdayMaskOf,
  runFilterQuery,
  searchAll,
  taskView,
  SEARCH_DEFAULT_LIMIT,
  unknownNames,
  tasksWithInheritedDeadline,
  todaysTimedTasks,
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
function danglingTimeHint(j: TaskView): string {
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

function taskLine(j: TaskView & { occurrenceCount?: number }): string {
  const bits = [j.id.slice(0, 8), `${j.parentTaskId !== null ? '↳ ' : ''}${j.title}`];
  // search 会把 done 与 active 混在一张表里,不标就分不出来(其余命令只列 active)
  if (j.status === 'done') bits.push('✓已完成');
  if (j.project !== null) bits.push(`[${j.project}]`);
  else if (j.bucket !== 'inbox') bits.push(`[${j.bucket}]`);
  if (j.scheduledDate !== null) bits.push(`📅${j.scheduledDate}`);
  // 🔁 紧贴 📅:循环是对计划日的修饰(list/today/search/filter 一次性全都显示)
  if (j.repeatShort !== null) bits.push(`🔁${j.repeatShort}`);
  if (j.startTime !== null) {
    const tz = j.timeZone !== null ? `(${j.timeZone})` : '';
    bits.push(`🕐${j.startTime}·${j.durationMinutes ?? j.estimatedMinutes}m${tz}`);
  }
  if (j.deadline !== null) bits.push(`⏰${j.deadline}${j.overdue ? '(过期)' : ''}`);
  if (j.priority !== 3) bits.push(`优先级:${j.priorityLabel}`); // 非默认才展示(D-14 文字)
  // 标签在界面与过滤器语法里都写作 @名字(D-30 起情境即标签)
  if (j.labels.length > 0) bits.push(j.labels.map((l) => `@${l}`).join(' '));
  // INV-36.14:done 段按系列折叠成最近一次;×N 让"这是一摞"可见
  if ((j.occurrenceCount ?? 1) > 1) bits.push(`×${j.occurrenceCount} 次`);
  return bits.join('  ');
}

function taskSectionFolded(
  title: string,
  rows: (TaskView & { occurrenceCount?: number })[],
): string {
  const body = rows.length === 0 ? '(空)' : rows.map((r) => `- ${taskLine(r)}`).join('\n');
  return `${title}(${rows.length})\n${body}`;
}

function taskSection(title: string, rows: TaskView[]): string {
  const body = rows.length === 0 ? '(空)' : rows.map((r) => `- ${taskLine(r)}`).join('\n');
  return `${title}(${rows.length})\n${body}`;
}

// ------------------------------------------------------------ 循环 flag 组装

const MASK_NAMES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'] as const;

/** 现有规则折回输入型(update 只给 --repeat-basis/--repeat-until 时在其上单改)。 */
function ruleToInput(r: NonNullable<Task['repeat']>): RepeatInput {
  return {
    unit: r.unit,
    every: r.every,
    from: r.from,
    until: r.until,
    ...(r.weekdays !== null
      ? { weekdays: MASK_NAMES.filter((_, i) => (r.weekdays! & (1 << i)) !== 0) }
      : {}),
  };
}

/**
 * `--repeat` / `--repeat-basis` / `--repeat-until` → RepeatInput(D-37)。
 * 文法解析在 domain 的 parseRepeatShorthand(INV-36.13 单一口径),这里只组装 flag。
 * `--repeat=none`(关闭)由 update 调用方先行分辨,不进这里。
 */
function buildRepeatInput(opts: {
  expr: string | undefined;
  basis: string | undefined;
  until: string | undefined;
  clock: Clock;
  /** update:任务现有循环(允许单改 basis/until);add 传 null */
  existing: Task['repeat'];
}): RepeatInput | undefined {
  const { expr, basis, until, clock, existing } = opts;
  if (basis !== undefined && basis !== 'scheduled' && basis !== 'completed') {
    throw new CliError(`--repeat-basis 只能是 scheduled 或 completed,得到 "${basis}"`);
  }
  let input: RepeatInput;
  if (expr !== undefined) {
    const r = parseRepeatShorthand(expr);
    if ('error' in r) throw new CliError(r.error);
    input = r;
  } else if (basis !== undefined || until !== undefined) {
    if (existing === null) {
      throw new CliError(
        '--repeat-basis / --repeat-until 需要任务已有循环,或与 --repeat= 同时给出',
      );
    }
    input = ruleToInput(existing);
  } else {
    return undefined;
  }
  if (basis !== undefined) input = { ...input, from: basis };
  if (until !== undefined) {
    input = { ...input, until: until === 'none' ? null : parseDay(until, clock) };
  }
  return input;
}

// ------------------------------------------------------------------ handlers

type Handler = (store: GtdStore, deps: FlowDeps, args: CliArgs) => CliOutput;

const add: Handler = (store, deps, args) => {
  const title = args.positionals.join(' ').trim();
  if (!title)
    throw new CliError(
      '用法: add <标题> [--parent=父任务(建子任务)] [--desc=] [--project=] [--date=] [--deadline=] [--time=HH:MM] [--duration=分钟] [--priority=1..5] [--labels=a,b] [--remind=YYYY-MM-DDTHH:MM] [--minutes=] [--energy=low|medium|high]',
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
  // 循环(D-37/INV-36)
  const repeatExpr = opt(args, 'repeat');
  if (repeatExpr === 'none') throw new CliError('--repeat=none 仅用于 update(关闭循环)');
  const repeat = buildRepeatInput({
    expr: repeatExpr,
    basis: opt(args, 'repeat-basis'),
    until: opt(args, 'repeat-until'),
    clock: deps.clock,
    existing: null,
  });
  // 循环未给 --date 时静默取今天 + **必须转告**(与 INV-10 继承 deadline 的既有范式一致)
  let repeatDateNote = '';
  if (repeat !== undefined && date === undefined && parentRef === undefined) {
    repeatDateNote = `(未给 --date,循环从今天 ${deps.clock.today()} 起算)`;
  }
  // --parent = 建子任务(INV-25:容器/项目继承父,≤5 层;D-22 支持完整属性集)
  if (parentRef !== undefined) {
    if (projectRef !== undefined)
      throw new CliError('--parent 与 --project 不能同用(子任务跟随父任务的项目)');
    if (repeat !== undefined)
      throw new CliError('子任务不能设循环(循环挂在根任务上,子任务随根任务一起重复)');
    const parent = findTask(snap, parentRef);
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
        ...(labels !== undefined && { labelIds: resolveLabelIds(snap, labels) }),
        ...(remind !== undefined && { reminderAt: remind }),
        ...(time !== undefined && { startTime: time }),
        ...(duration !== undefined && duration !== null && { durationMinutes: duration }),
        ...(tz !== undefined && tz !== 'floating' && { timeZone: tz }),
      }),
    );
    const after = store.snapshot();
    const j = taskView(after, findTask(after, c.taskId), deps.clock.today());
    return {
      data: { ...j, depth: c.depth },
      text: `已添加子任务(第 ${c.depth} 层,父:${parent.title}): ${taskLine(j)}${danglingTimeHint(j)}`,
    };
  }
  const input = {
    title,
    ...(projectRef !== undefined && { projectId: findProject(snap, projectRef).id }),
    ...(desc !== undefined && { description: desc }),
    ...(date !== undefined
      ? { scheduledDate: parseDay(date, deps.clock) }
      : repeat !== undefined
        ? { scheduledDate: deps.clock.today() }
        : {}),
    ...(deadline !== undefined && { deadline: parseDay(deadline, deps.clock) }),
    ...(priority !== undefined && { priority: Number(priority) }),
    ...(minutes !== undefined && { estimatedMinutes: Number(minutes) }),
    ...(energy !== undefined && { energy: parseEnergy(energy) }),
    ...(labels !== undefined && { labelIds: resolveLabelIds(snap, labels) }),
    ...(remind !== undefined && { reminderAt: remind }),
    ...(time !== undefined && { startTime: time }),
    ...(duration !== undefined && duration !== null && { durationMinutes: duration }),
    ...(tz !== undefined && tz !== 'floating' && { timeZone: tz }),
    ...(repeat !== undefined && { repeat }),
  };
  const c = applyUsecase(store, quickAddTask(snap, deps, input));
  const after = store.snapshot();
  const j = taskView(after, findTask(after, c.taskId), deps.clock.today());
  const notes = c.inheritedDeadline ? `(继承项目 deadline ${c.inheritedDeadline},INV-10)` : '';
  return {
    data: j,
    text: `已添加: ${taskLine(j)} ${notes}${repeatDateNote}${repeatAnchorNote(j)}${danglingTimeHint(j)}`.trim(),
  };
};

/**
 * `--repeat=weekly:wed` 撞上 `--date=周五`:**不报错,尊重用户给的日期**,
 * 但点明"首次落在计划日、之后按规则走" —— 否则用户会以为规则没生效。
 */
function repeatAnchorNote(j: TaskView): string {
  if (j.repeat === null || j.scheduledDate === null || j.repeat.weekdays === null) return '';
  if ((j.repeat.weekdays & weekdayMaskOf(j.scheduledDate)) !== 0) return '';
  return `(首次 ${j.scheduledDate},之后${j.repeatShort ?? ''}:${j.nextOccurrences.join('、')})`;
}

const capture: Handler = (store, deps, args) => {
  if (args.positionals.length === 0) throw new CliError('用法: capture <想法> [<想法>...]');
  const c = applyUsecase(
    store,
    captureToInbox(store.snapshot(), deps, { texts: args.positionals }),
  );
  const after = store.snapshot();
  const rows = c.createdIds.map((id) => taskView(after, findTask(after, id), deps.clock.today()));
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
  let rows: TaskView[];
  if (kind === 'completed') {
    const limitRaw = opt(args, 'limit') ?? '200';
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CliError(`--limit 需为正整数,得到 "${limitRaw}"`);
    }
    // INV-36.14:循环系列折叠成最近一次 + 次数(与桌面 Completed 同口径);limit 在折叠后取
    const foldedDone = foldDoneTasks(
      snap,
      snap.tasks
        .filter((t) => t.status === 'done')
        .sort((a, b) => ((a.completedAt ?? '') > (b.completedAt ?? '') ? -1 : 1)),
    ).slice(0, limit);
    const doneRows = foldedDone.map((f) => ({
      ...taskView(snap, f.task, today),
      occurrenceCount: f.occurrenceCount,
    }));
    return { data: doneRows, text: taskSectionFolded(kind, doneRows) };
  }
  if (kind === 'all') {
    // 跨所有容器/同级组:sortOrder 是组内相对序,跨组无意义 → 以 createdAt 展示,避免撞值乱序
    rows = snap.tasks
      .filter((t) => t.status === 'active')
      .sort(byCreatedAt)
      .map((t) => taskView(snap, t, today));
    return { data: rows, text: taskSection(kind, rows) };
  }
  if (kind === 'inbox' || kind === 'someday' || kind === 'reference' || kind === 'project') {
    // 树状显示(M5R5):根 = active list-root;子 = active 子任务递归,缩进呈现
    interface TreeJson extends TaskView {
      children: TreeJson[];
    }
    const build = (t: Task): TreeJson => ({
      ...taskView(snap, t, today),
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
  // 口径全在 domain 的 todayList(D-40)—— 桌面与 CLI 从此共用一份,不再靠注释"同步"
  const tasks = todayList(snap, day).all.map((t) => taskView(snap, t, day));
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
    for (const t of allDay) lines.push(`  全天         ${taskLine(taskView(snap, t, today))}`);
    for (const t of timed) {
      const span = `${t.startTime}–${endTimeLabel(blockEndMinutes(t))}`;
      lines.push(`  ${span}  ${taskLine(taskView(snap, t, today))}`);
    }
    return {
      date,
      isToday: date === today,
      allDay: allDay.map((t) => taskView(snap, t, today)),
      timed: timed.map((t) => taskView(snap, t, today)),
    };
  });
  return {
    data: { from, to: addDaysIso(from, count - 1), days: data },
    text: `Calendar ${from} — ${addDaysIso(from, count - 1)}\n${lines.join('\n')}`,
  };
};

/**
 * Focus/Engage(INV-20;与桌面 FocusPanel **同一套 domain 规则**,改动需同步)。
 * calendar-first:今天已排期任务先列;随后是该标签下 时间/精力 匹配的 top-7(D-30)。
 */
const engage: Handler = (store, deps, args) => {
  const snap = store.snapshot();
  const today = deps.clock.today();
  const labelRef = opt(args, 'label');
  const minutesRaw = opt(args, 'minutes') ?? '60';
  const minutes = Number(minutesRaw);
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new CliError(`--minutes 需为正整数,得到 "${minutesRaw}"`);
  }
  const energy = parseEnergy(opt(args, 'energy') ?? 'medium');
  // D-30:不给 --label 就是"不按标签过滤",看全部候选
  const label =
    labelRef === undefined
      ? undefined
      : snap.labels.find((l) => l.id === labelRef || l.name === labelRef.replace(/^@/, ''));
  if (labelRef !== undefined && label === undefined) {
    const have = snap.labels.map((l) => `@${l.name}`).join(', ') || '(无)';
    throw new CliError(`找不到标签: ${labelRef}(现有:${have})`);
  }
  const labelId = label?.id ?? null;
  const labelName = label === undefined ? '全部标签' : `@${label.name}`;

  // INV-20.1:日历优先段 = 当天硬性日程,与 --label 无关,故不随之过滤
  const first = todaysTimedTasks(snap, today).map((t) => taskView(snap, t, today));
  const matches = engageMatches(snap, labelId, minutes, energy, today);
  const cands = matches.slice(0, ENGAGE_TOP_N).map((t) => taskView(snap, t, today));
  const hidden = matches.length - cands.length;
  const text = [
    `Focus ${labelName} · ≤${minutes} 分钟 · 精力 ${energy}`,
    taskSection('今天已排期(先处理)', first),
    taskSection(`候选(优先级前 ${ENGAGE_TOP_N})`, cands),
    ...(hidden > 0 ? [`另有 ${hidden} 条符合条件的任务未列出。`] : []),
  ].join('\n\n');
  return {
    data: {
      label: labelName,
      minutes,
      energy,
      calendarFirst: first,
      candidates: cands,
      topN: ENGAGE_TOP_N,
      matched: matches.length,
    },
    text,
  };
};

/**
 * 跨实体搜索(M7a):与 ⌘K 同一个 domain `searchAll`。
 * CLI 比面板多列 waiting-for —— 面板里点它没有去处(桌面无等待项视图),终端里没这问题。
 */
const search: Handler = (store, deps, args) => {
  const q = args.positionals.join(' ').trim();
  if (!q) throw new CliError('用法:search <关键词> [--limit=50]');
  const limitRaw = opt(args, 'limit');
  const limit = limitRaw === undefined ? SEARCH_DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CliError(`--limit 需为正整数,得到 "${limitRaw}"`);
  }
  const snap = store.snapshot();
  const today = deps.clock.today();
  const r = searchAll(snap, deps, { query: q, limit });
  if (isUsecaseError(r)) throw new CliError(r.error);
  const { tasks, projects: hitProjects, waiting, totalMatched, doneFoldCounts } = r.consequences;
  const taskRows = tasks.map((t) => ({
    ...taskView(snap, t, today),
    // INV-36.14:done 段按系列折叠,这里只带次数,展示层加「×N 次」
    ...(doneFoldCounts[t.id] !== undefined ? { occurrenceCount: doneFoldCounts[t.id] } : {}),
  }));
  const projectRows = hitProjects.map((p) => ({
    id: p.id,
    name: p.outcome,
    status: p.status,
    deadline: p.deadline,
  }));
  const waitingRows = waiting.map((w) => ({
    id: w.id,
    description: w.description,
    delegatedTo: w.delegatedTo,
    resolved: w.resolvedAt !== null,
  }));
  const shown = taskRows.length + projectRows.length + waitingRows.length;
  const lines = [
    `搜索「${q}」`,
    taskSectionFolded('任务', taskRows),
    `项目(${projectRows.length})\n${
      projectRows.length === 0
        ? '(空)'
        : projectRows
            .map(
              (p) =>
                `- ${p.id.slice(0, 8)}  ${p.name}${p.status === 'complete' ? '  已完成' : ''}${
                  p.deadline !== null ? `  🎯${p.deadline}` : ''
                }`,
            )
            .join('\n')
    }`,
    `等待项(${waitingRows.length})\n${
      waitingRows.length === 0
        ? '(空)'
        : waitingRows
            .map(
              (w) =>
                `- ${w.id.slice(0, 8)}  ${w.description} → ${w.delegatedTo}${
                  w.resolved ? '  已解决' : ''
                }`,
            )
            .join('\n')
    }`,
  ];
  if (totalMatched > shown) lines.push(`另有 ${totalMatched - shown} 条未列出(--limit 可放宽)。`);
  return {
    data: {
      query: q,
      limit,
      totalMatched,
      tasks: taskRows,
      projects: projectRows,
      waiting: waitingRows,
    },
    text: lines.join('\n\n'),
  };
};

/**
 * 跑一条查询(INV-33 文本语法);--save=<名字> 顺带存成过滤器。
 * 与桌面 Filters 视图同一个 runFilterQuery,不另写一套过滤。
 */
const filter: Handler = (store, deps, args) => {
  const q = args.positionals.join(' ').trim();
  if (!q) throw new CliError('用法:filter <查询> [--save=名字]   (语法见 help)');
  const snap = store.snapshot();
  const today = deps.clock.today();
  const r = runFilterQuery(snap, q, { today });
  if ('error' in r) {
    // 指出出错位置:原文 + caret
    const caret =
      ' '.repeat(r.error.span.start) +
      '^'.repeat(Math.max(1, r.error.span.end - r.error.span.start));
    throw new CliError(`查询语法错误:${r.error.message}\n  ${q}\n  ${caret}`);
  }
  const save = opt(args, 'save');
  if (save !== undefined) {
    applyUsecase(store, createFilter(snap, deps, { name: save, query: q }));
  }
  const parsed = parseFilterQuery(q);
  const unknown = parsed.ok ? unknownNames(snap, parsed.ast) : { labels: [], projects: [] };
  const sections = r.sections.map((sec) => ({
    source: sec.source,
    tasks: sec.tasks.map((t) => taskView(snap, t, today)),
  }));
  const lines = [`查询「${q}」`];
  for (const sec of sections) {
    lines.push(taskSection(sections.length > 1 ? sec.source : '匹配', sec.tasks));
  }
  const miss = [...unknown.labels.map((n) => `@${n}`), ...unknown.projects.map((n) => `#${n}`)];
  if (miss.length > 0) lines.push(`注意:${miss.join('、')} 不存在,这些条件恒不成立。`);
  if (save !== undefined) lines.push(`已存为过滤器「${save}」。`);
  return { data: { query: q, sections, unknown }, text: lines.join('\n\n') };
};

const filters: Handler = (store, deps, _args) => {
  const snap = store.snapshot();
  const today = deps.clock.today();
  const rows = [...snap.filters]
    .sort((a, b) => a.position - b.position)
    .map((f) => {
      const r = runFilterQuery(snap, f.query, { today });
      return {
        id: f.id,
        name: f.name,
        query: f.query,
        matchCount: 'error' in r ? null : r.sections.reduce((n, s2) => n + s2.tasks.length, 0),
        error: 'error' in r ? r.error.message : null,
      };
    });
  return {
    data: rows,
    text:
      rows.length === 0
        ? '(无过滤器;filter <查询> --save=<名字> 可存一条)'
        : rows
            .map(
              (f) =>
                `- ${f.id.slice(0, 8)}  ${f.name}  ${f.error !== null ? `⚠ ${f.error}` : `(${String(f.matchCount)})`}\n    ${f.query}`,
            )
            .join('\n'),
  };
};

const projects: Handler = (store, _deps, _args) => {
  const snap = store.snapshot();
  const rows = snap.projects
    .filter((p) => p.status === 'active')
    // INV-37:与侧栏同一个显示序(用户拖出来的顺序,CLI 也照着显示)
    .sort(byProjectSort)
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
  const j = taskView(after, findTask(after, task.id), deps.clock.today());
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
  const j = taskView(after, findTask(after, task.id), deps.clock.today());
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
  // INV-36.6 G4:循环的后续必须复述给用户 —— 生成了下一次 / 系列结束 / 因已有 active 未生成
  if (c.nextOccurrence !== undefined) {
    const after = store.snapshot();
    const nv = taskView(after, findTask(after, c.nextOccurrence.taskId), deps.clock.today());
    const subs =
      c.nextOccurrence.copiedSubtaskCount > 0
        ? `,连同 ${c.nextOccurrence.copiedSubtaskCount} 个子任务`
        : '';
    followUp += `\n↻ 下一次:${c.nextOccurrence.scheduledDate}(${nv.repeatShort ?? '循环'}${subs})`;
  } else if (c.repeatEnded === true) {
    followUp += `\n↻ 循环已结束${task.repeat?.until != null ? `(到 ${task.repeat.until} 为止)` : ''}。`;
  } else if (c.nextOccurrenceSkipped !== undefined) {
    followUp += `\n↻ 该系列已有一条进行中的任务,未生成下一次。`;
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
      '用法: update <任务> [--title=] [--desc=] [--date=|none] [--deadline=|none] [--time=HH:MM|none] [--duration=分钟|none] [--priority=] [--minutes=] [--energy=]',
    );
  }
  const snap = store.snapshot();
  const task = findTask(snap, ref);
  const title = opt(args, 'title');
  const desc = opt(args, 'desc');
  const date = opt(args, 'date');
  const deadline = opt(args, 'deadline');
  const priority = opt(args, 'priority');
  const minutes = opt(args, 'minutes');
  const energy = opt(args, 'energy');
  const time = opt(args, 'time');
  const duration = opt(args, 'duration');
  const tzu = opt(args, 'tz');
  // 循环(D-37):--repeat=none 关闭;表达式 = 整条替换;只给 basis/until = 在现有规则上单改
  const repeatExpr = opt(args, 'repeat');
  const repeatOff = repeatExpr === 'none';
  const repeat = repeatOff
    ? undefined
    : buildRepeatInput({
        expr: repeatExpr,
        basis: opt(args, 'repeat-basis'),
        until: opt(args, 'repeat-until'),
        clock: deps.clock,
        existing: task.repeat,
      });
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
    ...(minutes !== undefined && { estimatedMinutes: Number(minutes) }),
    ...(energy !== undefined && { energy: parseEnergy(energy) }),
    ...(time !== undefined && { startTime: time === 'none' ? null : time }),
    ...(duration !== undefined && { durationMinutes: parseDuration(duration, true) }),
    ...(tzu !== undefined && { timeZone: tzu === 'floating' || tzu === 'none' ? null : tzu }),
    ...(repeatOff ? { repeat: null } : repeat !== undefined ? { repeat } : {}),
  };
  if (Object.keys(patch).length === 0) throw new CliError('没有要更新的字段');
  applyUsecase(store, updateTask(snap, deps, { id: task.id, patch }));
  const after = store.snapshot();
  const j = taskView(after, findTask(after, task.id), deps.clock.today());
  const offNote = repeatOff ? '(循环已关闭)' : '';
  return {
    data: j,
    text: `已更新: ${taskLine(j)}${offNote}${repeatAnchorNote(j)}${danglingTimeHint(j)}`,
  };
};

const show: Handler = (store, deps, args) => {
  const ref = args.positionals[0];
  if (!ref) throw new CliError('用法: show <任务>');
  const snap = store.snapshot();
  const t = findTask(snap, ref);
  const today = deps.clock.today();
  const j = taskView(snap, t, today);
  const reminders = snap.reminders
    .filter((r) => r.taskId === t.id)
    .map((r) => r.remindAt + (r.dispatched ? '(已提醒)' : ''));
  // 子任务树(D-21;≤5 层,排除已删除)
  interface SubtaskJson extends TaskView {
    children: SubtaskJson[];
  }
  const subtree = (parent: Task): SubtaskJson[] =>
    snap.tasks
      .filter((x) => x.parentTaskId === parent.id && x.status !== 'deleted')
      .sort(bySort)
      .map((x) => ({ ...taskView(snap, x, today), children: subtree(x) }));
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
    j.repeatLong !== null && `循环: ${j.repeatLong}`,
    j.nextOccurrences.length > 0 && `下三次: ${j.nextOccurrences.join(', ')}`,
    j.deadline !== null && `deadline: ${j.deadline}${j.overdue ? '(过期)' : ''}`,
    `优先级: ${j.priorityLabel}  ·  ${j.estimatedMinutes} 分钟  ·  精力 ${j.energy}`,
    j.labels.length > 0 && `labels: ${j.labels.join(', ')}`,
    reminders.length > 0 && `提醒: ${reminders.join(', ')}`,
    j.completedAt !== null && `完成于: ${j.completedAt}`,
    subtaskLines.length > 0 && `子任务:\n${subtaskLines.join('\n')}`,
    comments.length > 0 &&
      `评论:\n${comments.map((c) => `  [${c.createdAt.replace('T', ' ')}] ${c.body}`).join('\n')}`,
  ].filter(Boolean);
  return { data: { ...j, reminders, subtasks, comments }, text: lines.join('\n') };
};

const labels: Handler = (store, _deps, _args) => {
  const rows = store.snapshot().labels.map((l) => ({ id: l.id, name: l.name }));
  return {
    data: rows,
    text:
      rows.length === 0
        ? '(无 label)'
        : rows.map((l) => `- @${l.name}  ${l.id.slice(0, 8)}`).join('\n'),
  };
};

const labelAdd: Handler = (store, deps, args) => {
  const name = args.positionals.join(' ').trim();
  if (!name) throw new CliError('用法: label-add <名称>');
  const c = applyUsecase(store, createLabel(store.snapshot(), deps, { name }));
  return { data: c, text: `已创建 label: @${name}` };
};

export const HELP = `Claudoist CLI — 经 domain usecase 操作任务数据(与 App 同一 DB,写入后 App 自动刷新)

用法: pnpm --silent cli <命令> [参数] [--json] [--db=路径|--dev|--prod]

命令:
  add <标题> [--parent=父任务(建子任务,≤5 层)] [--desc=] [--project=]
             [--date=today|tomorrow|YYYY-MM-DD] [--deadline=]
             [--time=HH:MM(日历 block,D-23)] [--duration=分钟] [--tz=floating|IANA]
             [--priority=1..5(1最低,5最高)] [--labels=a,b] [--remind=YYYY-MM-DDTHH:MM]
             [--minutes=] [--energy=low|medium|high]
             [--repeat=表达式] [--repeat-basis=scheduled|completed] [--repeat-until=YYYY-MM-DD]
  capture <想法> [<想法>...]        逐条捕捉进 Inbox(零判断,INV-16)
  list [inbox|someday|reference|project|completed|all]   completed 可加 --limit=N
  today                             统一待办(计划 ≤ 今天 ∪ 截止 ≤ 今天;带时间任务按时刻排)
  calendar [--from=today|tomorrow|YYYY-MM-DD] [--days=1..31]  日历周视图(全天段 + 定时段,INV-28)
  engage [--label=] [--minutes=60] [--energy=low|medium|high]  择事:calendar-first + top-7(INV-20)
  search <关键词> [--limit=50]                      跨实体搜索(任务/项目/等待项,与 ⌘K 同口径)
  filter <查询> [--save=名字]                       跑一条过滤器查询(INV-33 语法,与桌面 Filters 同口径)
  filters                                          列出保存的过滤器 + 命中数

过滤器查询语法(filter 命令与桌面 Filters 视图共用):
  @标签  #项目          带该标签 / 属于该项目(名字带空格加引号:@"deep work")
  p5  p>=4             优先级(⚠ 本仓 p5 = 最高,与 Todoist 相反)
  today tomorrow overdue no date   **计划日**(裸关键字一律指计划日)
  deadline: today / deadline before: +7 days / no deadline   **截止日**
  next 7 days          未来 N 天(含今天)
  energy: low  est: 30 精力 ≤ / 预估分钟 ≤
  inbox someday reference bucket: project           容器
  done  status: active,done  status: any            状态(默认只看活跃;没提 deleted 就永不含软删)
  search: 词  title: 词  desc: 词                    文本搜索
  no labels / no project / no time / subtask / mirrored / recurring(循环任务)
  & | ! ( )            与/或/非/分组       a, b     顶层逗号 = 并列两段

循环任务(repeat,D-37/INV-36):完成一次 = 这一次照常记完成 + 自动生成下一次(子任务重置为
未完成一并复制;评论不带走)。--repeat= 表达式:
  daily | weekly | monthly | yearly    每 1 个单位;星期/几号由 --date 的那天决定
  weekday                              每个工作日(周一–周五)
  weekly:wed  weekly:mon,wed,fri       指定星期(仅每 1 周)
  "every 2 weeks"                      自定义间隔 ⚠ 有空格必须整体加引号 —— 不加引号时
                                       那三个词会被当成标题的一部分
  none                                 仅 update:关闭循环(已完成的历史保留)
--repeat-basis=completed = 从**实际完成日**起算、永不追赶(换滤芯每 3 个月);缺省 scheduled =
按**原计划日**网格推进、逾期一次补齐到未来(每周三例会)。--repeat-until 含当天。
关闭循环用 --repeat=none;清计划日(--date=none)会被拒 —— 循环必须挂在计划日上。
  show <任务>                       任务详情(含子任务树 / 评论 / 提醒)
  comment <任务> <内容>             加评论
  move <任务> <inbox|someday|reference|项目引用>   根任务子树随动;子任务先脱离父
  reorder <任务> [--parent=|--top] [--before=]     手动排序/拖成子任务(同容器,INV-27)
  complete <任务>                   完成(向下级联完成子树,D-22;项目余活动以提示返回)
  reopen <任务>                     撤销完成(done → active,仅当前任务)
  update <任务> [--title=] [--desc=] [--date=|none] [--deadline=|none] [--priority=]
                [--repeat=表达式|none] [--repeat-basis=] [--repeat-until=|none] ...
  delete <任务>                     软删除(active 子树级联,输出数量;done 子任务保留)
  projects                          平面项目 + 进度 / project-add <成果> [--deadline=]
  project-update <项目> [--name=] [--deadline=|none] [--propagate|--keep-tasks]
                                    改 deadline 命中继承行动时须显式二选一(INV-12)
  project-complete <项目>           标记项目完成(任务状态不动,INV-15)
  labels / label-add <名称>         标签管理(D-30:情境已并入标签,写作 @名字)

任务/项目引用:完整 id、id 前缀(唯一)或标题全等。--json 输出 {ok, db, data}(data 含 id)。
DB 定位:CLAUDOIST_DB 环境变量 > --db= > --prod/--dev > 自动(dev 库存在且 prod 不存在则 dev,否则 prod)。`;

const HANDLERS: Record<string, Handler> = {
  add,
  capture,
  list,
  today,
  calendar,
  engage,
  search,
  filter,
  filters,
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
  labels,
  'label-add': labelAdd,
};

/** 每命令合法选项白名单(GLOBAL 由 main.ts 消化)——拼错的 -- 选项必须报错,不许无声丢数据。 */
const GLOBAL_OPTS = ['json', 'db', 'dev', 'prod', 'help'];
const COMMAND_OPTS: Record<string, string[]> = {
  calendar: ['from', 'days'],
  engage: ['label', 'minutes', 'energy'],
  search: ['limit'],
  filter: ['save'],
  filters: [],
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
    'minutes',
    'energy',
    'repeat',
    'repeat-basis',
    'repeat-until',
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
    'minutes',
    'energy',
    'repeat',
    'repeat-basis',
    'repeat-until',
  ],
  delete: [],
  projects: [],
  'project-add': ['deadline'],
  'project-update': ['name', 'deadline', 'propagate', 'keep-tasks'],
  'project-complete': [],
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
