import type { Project } from '../entities/project';
import type { Task } from '../entities/task';
import type { WaitingFor } from '../entities/waitingFor';
import type { GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import type { UsecaseResult } from './types';
import { foldDoneTasks } from '../rules/seriesFold';

/** 跨实体搜索(⌘K 与 CLI `search` 的唯一数据源)。 */

export const SEARCH_DEFAULT_LIMIT = 50;

export interface SearchAllInput {
  query: string;
  /** 每类结果的上限;缺省 {@link SEARCH_DEFAULT_LIMIT }。截断前的总数见 totalMatched */
  limit?: number;
}

export interface SearchAllConsequences {
  /** 活跃在前、标题命中优先、再按创建时间倒序;含已完成(归档可搜),**不含软删除** */
  tasks: Task[];
  /** 含已完成的项目 */
  projects: Project[];
  waiting: WaitingFor[];
  /** 截断前的命中总数(三类之和,**按系列折叠后**,INV-36.14),用于"还有 N 条未列出" */
  totalMatched: number;
  /**
   * INV-36.14:done 段按系列折叠 —— 代表任务 id → 折进来的次数(仅 >1 的组出现)。
   * 调用方在该行追加「共 N 次」;active 任务永不折叠。
   */
  doneFoldCounts: Record<string, number>;
}

/**
 * 大小写不敏感的子串匹配。命中字段:Task 的 title 与 description、Project 的 outcome、
 * WaitingFor 的 description 与 delegatedTo。
 *
 * **容器模型口径(D-20/D-21/D-23)**:Inbox / Someday / Reference / 项目任务 / 日历块
 * 现在全都是带 `bucket`(与 `scheduledDate`)的 Task,因此它们统一落在 `tasks` 一组里,
 * 由调用方按 bucket/status 分组呈现。此前这里搜的是 `snap.inbox` 与 `snap.listItems`
 * (D-20 之前的 InboxItem / ListItem),那两张表自容器模型起就不再写入 —— 对应的
 * inbox/someday/reference/trash 四个分组恒为空,等于这些内容根本搜不到(2026-08-11 修)。
 *
 * **软删除任务不返回**:删除是可恢复的(INV-22),但当前没有 Trash 视图,搜出来也无处
 * 可去 —— 与其给一条点不动的结果,不如不给。将来有了恢复入口再放开。
 */
export function searchAll(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: SearchAllInput,
): UsecaseResult<SearchAllConsequences> {
  const q = input.query.trim().toLowerCase();
  if (q === '') return { error: '查询不能为空' };
  const limit = input.limit ?? SEARCH_DEFAULT_LIMIT;
  const hit = (s: string): boolean => s.toLowerCase().includes(q);

  const matchedTasks = snap.tasks.filter(
    (t) => t.status !== 'deleted' && (hit(t.title) || hit(t.description)),
  );
  // 活跃优先(找东西多半是要动它)→ 标题命中优先于仅描述命中 → 新的在前
  const tasks = [...matchedTasks].sort((a, b) => {
    const active = (t: Task): number => (t.status === 'active' ? 0 : 1);
    if (active(a) !== active(b)) return active(a) - active(b);
    const byTitle = (t: Task): number => (hit(t.title) ? 0 : 1);
    if (byTitle(a) !== byTitle(b)) return byTitle(a) - byTitle(b);
    if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // 已删项目**保留但排在最后**(INV-34):INV-32.3 当初不返回软删任务的理由是
  // "没有恢复入口,给一条点不动的结果不如不给" —— 而项目恰恰有了恢复入口(只读项目视图),
  // 过滤掉反而等于把软删变成用户永远看不见的硬删。调用方按 status 标注即可。
  const projectRank = (p: { status: string }): number =>
    p.status === 'active' ? 0 : p.status === 'complete' ? 1 : 2;
  const projects = snap.projects
    .filter((p) => hit(p.outcome))
    .sort((a, b) => projectRank(a) - projectRank(b));
  const waiting = snap.waiting.filter((w) => hit(w.description) || hit(w.delegatedTo));

  // INV-36.14:done 段按系列折叠(一个每日循环会在这里刷出几百条同标题结果,把别的
  // 东西挤没)。折叠只作用于 done —— active 的那一次是"要动的东西",永远单独成行。
  // totalMatched 报**折叠后**:用户心里那是一件事。
  const activeTasks = tasks.filter((t) => t.status === 'active');
  const foldedDone = foldDoneTasks(
    snap,
    tasks.filter((t) => t.status !== 'active'),
  );
  const doneFoldCounts: Record<string, number> = {};
  for (const f of foldedDone) {
    if (f.occurrenceCount > 1) doneFoldCounts[f.task.id] = f.occurrenceCount;
  }
  const foldedTasks = [...activeTasks, ...foldedDone.map((f) => f.task)];

  return {
    commands: [],
    consequences: {
      tasks: foldedTasks.slice(0, limit),
      projects: projects.slice(0, limit),
      waiting: waiting.slice(0, limit),
      totalMatched: foldedTasks.length + projects.length + waiting.length,
      doneFoldCounts,
    },
  };
}
