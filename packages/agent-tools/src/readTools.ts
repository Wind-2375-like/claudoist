import {
  ENGAGE_TOP_N,
  calendarDay,
  descendantTaskIds,
  engageMatches,
  isTaskListRoot,
  isUsecaseError,
  parseFilterQuery,
  projectStats,
  runFilterQuery,
  searchAll,
  taskView,
  todaysTimedTasks,
  unknownNames,
} from '@gtd/domain';
import type { Clock, GtdSnapshot, GtdStore, Task } from '@gtd/domain';
import { timeContext, withRelativeTime } from './timeContext';
import type { TimedTaskView } from './timeContext';

/**
 * 只读 GTD 工具的**纯逻辑层**(M8)。这里不 import SDK —— 工具描述与 handler 是纯函数,
 * 由 `index.ts` 包成 `tool()` 定义。这样 domain 规则的对拍可以直接测这一层。
 *
 * 三条硬纪律(INV-20.6 / INV-32.6 / INV-33.9,合称"单一口径"):
 * 1. **`list_*` 只做列举**(按容器/项目/父任务),**不接受任何条件参数**。
 * 2. **一切条件查询走 `run_filter`**(即 domain `runFilterQuery`)。给 `list_tasks` 加
 *    `energyMax`/`dueBefore`/`query` 之类参数,等于在 agent 这一侧开第二套过滤口径 ——
 *    桌面与 CLI 已经因为各写一遍吃过亏(见 INV-20.6 的由来)。
 * 3. **择事走 `get_engage_recommendations`**,它是 `engageMatches` 的薄包装:不重排、
 *    不重截断、不补条件。
 */

export interface ReadToolDeps {
  store: GtdStore;
  clock: Clock;
}

const snapAnd = (d: ReadToolDeps): { snap: GtdSnapshot; today: string } => ({
  snap: d.store.snapshot(),
  today: d.clock.today(),
});

/** 列表根:active 且无活跃父任务(D-22:被 reopen 的子任务也在此成行,不悬空)。 */
const roots = (snap: GtdSnapshot): Task[] =>
  snap.tasks.filter((t) => t.status === 'active' && isTaskListRoot(snap, t));

/**
 * 任务投影 + **相对此刻的时间**。后者不是锦上添花:实测只给日期时,agent 会把下周的
 * 会议当成"现在可以做的候选"。让它直接看到"7 天后",比指望它算日期差可靠得多。
 */
const views = (snap: GtdSnapshot, ts: Task[], today: string): TimedTaskView[] => {
  const ctx = timeContext();
  return ts.map((t) => withRelativeTime(taskView(snap, t, today), ctx));
};

// ------------------------------------------------------------------ 列举

/** D-20:Inbox 是 `bucket='inbox'` 的 Task,**不是** `inbox_items`(那张表自容器模型起零写入)。 */
export function listInbox(d: ReadToolDeps): { tasks: TimedTaskView[] } {
  const { snap, today } = snapAnd(d);
  return {
    tasks: views(
      snap,
      // 外部镜像不进 Inbox(D-25/INV-29:它们已排进日历,不是待理清项)
      roots(snap).filter((t) => t.bucket === 'inbox' && t.externalId === null),
      today,
    ),
  };
}

export function listBucket(
  d: ReadToolDeps,
  kind: 'someday' | 'reference',
): { bucket: string; tasks: TimedTaskView[] } {
  const { snap, today } = snapAnd(d);
  return {
    bucket: kind,
    tasks: views(
      snap,
      roots(snap).filter((t) => t.bucket === kind),
      today,
    ),
  };
}

/**
 * Today 口径(D-19/D-23,与桌面 Today 视图同源):计划 ≤ 今天 ∪(截止 ≤ 今天且未计划)。
 * 计划到未来 = 用户显式推迟,**不再**因过期 deadline 赖在 Today。
 */
export function listToday(d: ReadToolDeps): { today: string; tasks: TimedTaskView[] } {
  const { snap, today } = snapAnd(d);
  const engageable = (t: Task): boolean =>
    t.status === 'active' && t.bucket !== 'someday' && t.bucket !== 'reference';
  const scheduled = snap.tasks
    .filter((t) => engageable(t) && t.scheduledDate !== null && t.scheduledDate <= today)
    .sort((a, b) => {
      if (a.scheduledDate !== b.scheduledDate) return a.scheduledDate! < b.scheduledDate! ? -1 : 1;
      if ((a.startTime === null) !== (b.startTime === null)) return a.startTime === null ? -1 : 1;
      if (a.startTime !== b.startTime) return (a.startTime ?? '') < (b.startTime ?? '') ? -1 : 1;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
  const seen = new Set(scheduled.map((t) => t.id));
  const due = snap.tasks
    .filter(
      (t) =>
        engageable(t) &&
        t.deadline !== null &&
        t.deadline <= today &&
        t.scheduledDate === null &&
        !seen.has(t.id),
    )
    .sort((a, b) => (a.deadline! < b.deadline! ? -1 : 1));
  return { today, tasks: views(snap, [...scheduled, ...due], today) };
}

/** D-23:日历 = 任务按 scheduledDate + startTime 的投影,无独立实体。 */
export function listCalendar(
  d: ReadToolDeps,
  fromDate: string,
  days: number,
): { days: { date: string; allDay: TimedTaskView[]; timed: TimedTaskView[] }[] } {
  const { snap, today } = snapAnd(d);
  const out: { date: string; allDay: TimedTaskView[]; timed: TimedTaskView[] }[] = [];
  const [y, m, dd] = fromDate.split('-').map(Number);
  for (let i = 0; i < Math.min(Math.max(days, 1), 31); i += 1) {
    const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (dd ?? 1) + i));
    const date = dt.toISOString().slice(0, 10);
    const day = calendarDay(snap, date);
    out.push({
      date,
      allDay: views(snap, day.allDay, today),
      timed: views(snap, day.timed, today),
    });
  }
  return { days: out };
}

export function listProjects(d: ReadToolDeps): {
  projects: {
    id: string;
    name: string;
    deadline: string | null;
    activeCount: number;
    doneCount: number;
    hasActiveNextAction: boolean;
  }[];
} {
  const { snap } = snapAnd(d);
  return {
    projects: snap.projects
      .filter((p) => p.status === 'active')
      .map((p) => {
        const st = projectStats(snap, p.id);
        return {
          id: p.id,
          name: p.outcome,
          deadline: p.deadline,
          activeCount: st.activeCount,
          doneCount: st.doneCount,
          // INV-05:完成后果提示要用它;M9 的写工具会返回同名 consequence
          hasActiveNextAction: st.activeCount > 0,
        };
      }),
  };
}

export function getProject(
  d: ReadToolDeps,
  projectId: string,
):
  | { error: string }
  | { project: { id: string; name: string; deadline: string | null }; tasks: TimedTaskView[] } {
  const { snap, today } = snapAnd(d);
  const p = snap.projects.find((x) => x.id === projectId || x.outcome === projectId);
  if (!p) return { error: `项目不存在: ${projectId}` };
  return {
    project: { id: p.id, name: p.outcome, deadline: p.deadline },
    tasks: views(
      snap,
      snap.tasks.filter(
        (t) => t.projectId === p.id && t.status === 'active' && isTaskListRoot(snap, t),
      ),
      today,
    ),
  };
}

/** 子任务树 + 评论:没有它 agent 看不到 D-21 的结构,也无法预判 D-22 的级联规模。 */
export function getTaskDetail(
  d: ReadToolDeps,
  taskId: string,
):
  | { error: string }
  | {
      task: TimedTaskView;
      activeDescendantCount: number;
      subtasks: TimedTaskView[];
      comments: { body: string; createdAt: string }[];
    } {
  const { snap, today } = snapAnd(d);
  const t = snap.tasks.find((x) => x.id === taskId);
  if (!t) return { error: `任务不存在: ${taskId}` };
  return {
    task: withRelativeTime(taskView(snap, t, today), timeContext()),
    activeDescendantCount: descendantTaskIds(snap, t.id).filter(
      (id) => snap.tasks.find((x) => x.id === id)?.status === 'active',
    ).length,
    subtasks: views(
      snap,
      snap.tasks.filter((c) => c.parentTaskId === t.id && c.status !== 'deleted'),
      today,
    ),
    comments: snap.comments
      .filter((c) => c.taskId === t.id)
      .map((c) => ({ body: c.body, createdAt: c.createdAt })),
  };
}

export function listLabels(d: ReadToolDeps): {
  labels: { name: string; activeTaskCount: number }[];
} {
  const { snap } = snapAnd(d);
  const active = new Set(snap.tasks.filter((t) => t.status === 'active').map((t) => t.id));
  return {
    labels: [...snap.labels]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((l) => ({
        name: l.name,
        activeTaskCount: snap.taskLabels.filter(
          (tl) => tl.labelId === l.id && active.has(tl.taskId),
        ).length,
      })),
  };
}

export function listFilters(d: ReadToolDeps): { filters: { name: string; query: string }[] } {
  const { snap } = snapAnd(d);
  return {
    filters: [...snap.filters]
      .sort((a, b) => a.position - b.position)
      .map((f) => ({ name: f.name, query: f.query })),
  };
}

export function listWaitingFor(d: ReadToolDeps): {
  waiting: { id: string; description: string; delegatedTo: string; delegatedAt: string }[];
} {
  const { snap } = snapAnd(d);
  return {
    waiting: snap.waiting
      .filter((w) => !w.resolved)
      .map((w) => ({
        id: w.id,
        description: w.description,
        delegatedTo: w.delegatedTo,
        delegatedAt: w.delegatedAt,
      })),
  };
}

// ------------------------------------------------------------------ 查询

/** INV-32 薄包装。**软删不返回**;done 可搜到但排在活跃之后。 */
export function search(
  d: ReadToolDeps,
  query: string,
  limit?: number,
):
  | { error: string }
  | { tasks: TimedTaskView[]; projects: { id: string; name: string }[]; totalMatched: number } {
  const { snap, today } = snapAnd(d);
  const r = searchAll(
    snap,
    { clock: d.clock, idGen: { next: () => '' } },
    {
      query,
      ...(limit !== undefined ? { limit } : {}),
    },
  );
  if (isUsecaseError(r)) return { error: r.error };
  return {
    tasks: views(snap, r.consequences.tasks, today),
    projects: r.consequences.projects.map((p) => ({ id: p.id, name: p.outcome })),
    totalMatched: r.consequences.totalMatched,
  };
}

/** INV-33 薄包装:**唯一**的条件查询入口。顶层逗号 = 多段并列。 */
export function runFilter(
  d: ReadToolDeps,
  query: string,
):
  | { error: string }
  | {
      sections: { source: string; tasks: TimedTaskView[] }[];
      unknownLabels: string[];
      unknownProjects: string[];
    } {
  const { snap, today } = snapAnd(d);
  const r = runFilterQuery(snap, query, { today });
  if ('error' in r) return { error: `查询语法错误:${r.error.message}` };
  const parsed = parseFilterQuery(query);
  const unknown = parsed.ok ? unknownNames(snap, parsed.ast) : { labels: [], projects: [] };
  return {
    sections: r.sections.map((s) => ({ source: s.source, tasks: views(snap, s.tasks, today) })),
    unknownLabels: unknown.labels,
    unknownProjects: unknown.projects,
  };
}

/** INV-20 薄包装。不给 labelName = 不按标签过滤(D-30 后情境即标签)。 */
export function engageRecommendations(
  d: ReadToolDeps,
  labelName: string | undefined,
  availableMinutes: number,
  energy: 'low' | 'medium' | 'high',
):
  | { error: string }
  | {
      calendarFirst: TimedTaskView[];
      candidates: TimedTaskView[];
      topN: number;
      matched: number;
    } {
  const { snap, today } = snapAnd(d);
  let labelId: string | null = null;
  if (labelName !== undefined) {
    const bare = labelName.replace(/^@/, '').toLowerCase();
    const hit = snap.labels.find((l) => l.name.toLowerCase() === bare);
    if (!hit) {
      const have = snap.labels.map((l) => `@${l.name}`).join(', ') || '(无)';
      return { error: `找不到标签 @${bare}(现有:${have})` };
    }
    labelId = hit.id;
  }
  const matches = engageMatches(snap, labelId, availableMinutes, energy, today);
  return {
    // INV-20.1:日历优先段是当天硬性日程,与所选标签无关,故不随之过滤
    calendarFirst: views(snap, todaysTimedTasks(snap, today), today),
    candidates: views(snap, matches.slice(0, ENGAGE_TOP_N), today),
    topN: ENGAGE_TOP_N,
    matched: matches.length,
  };
}

/** 会话起始注入 system prompt 的轻量快照(DESIGN §6.6)。 */
export function statusSnapshot(d: ReadToolDeps): {
  time: ReturnType<typeof timeContext>;
  today: string;
  inboxCount: number;
  todayCount: number;
  labels: { name: string; activeTaskCount: number }[];
  projects: { name: string; activeCount: number }[];
  hasSoftDeleted: boolean;
} {
  const { snap, today } = snapAnd(d);
  return {
    time: timeContext(),
    today,
    inboxCount: listInbox(d).tasks.length,
    todayCount: listToday(d).tasks.length,
    labels: listLabels(d).labels,
    projects: listProjects(d).projects.map((p) => ({ name: p.name, activeCount: p.activeCount })),
    // INV-32.3:软删不进搜索结果 —— agent 得知道"搜不到"不等于"不存在"
    hasSoftDeleted: snap.tasks.some((t) => t.status === 'deleted'),
  };
}
