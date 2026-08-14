import type { Task } from '../entities/task';
import type { GtdSnapshot } from '../ports/gtdStore';

/**
 * 系列折叠(INV-36.14,2026-08-13 用户拍板)。
 *
 * ## 问题
 *
 * 循环任务的完成语义是"生成新行"(INV-36.5):一个每日循环一年产出 365 条 done,
 * 带 3 个子任务的每周大扫除一年再加 156 条。不折叠的话:项目进度条被推到接近 1 并永远
 * 卡在那(projectStats 失真,R8);搜索/Completed 的 done 段被同标题行刷屏(R9)。
 *
 * ## 归组键(foldKeyOf)
 *
 * - **系列根**(seriesId 非空):`s:<seriesId>` —— 一个系列的所有 occurrence 一组。
 * - **occurrence 子树副本**(自身无 seriesId,但沿 parent 链上溯到带 seriesId 的根):
 *   `t:<seriesId>|<标题>` —— 各期的「厨房」归一组、「阳台」归另一组。用标题归组是
 *   刻意的取舍:各期副本是不同的行,没有跨期的稳定身份,标题就是用户眼里的"同一件事"。
 *   代价:同一期里两个同名子任务会被折成一条(无害,视觉上本来就一样);改名会开新组
 *   (旧组作为历史保留)。
 * - 其余任务:null,不折叠 —— **零回归**:不含循环的项目/搜索结果逐字不变。
 *
 * ## 单一口径纪律
 *
 * projectStats(进度条/侧栏徽章)、searchAll(⌘K 与 CLI search)、Completed 视图
 * (桌面与 CLI list completed)全部用这一份键;各数各的迟早出现"进度条说 1 件、
 * 搜索列 300 条"(与 INV-20.6 / INV-32.6 / INV-33.9 同一条纪律)。
 */
export function foldKeyOf(snap: GtdSnapshot, t: Task): string | null {
  if (t.seriesId !== null) return `s:${t.seriesId}`;
  if (t.parentTaskId === null) return null;
  // 上溯 parent 链找系列根。链是历史数据,可能断(父被硬删/回滚),防环防悬空
  const seen = new Set<string>([t.id]);
  let cur: Task | undefined = t;
  while (cur.parentTaskId !== null) {
    if (seen.has(cur.parentTaskId)) return null;
    seen.add(cur.parentTaskId);
    cur = snap.tasks.find((x) => x.id === cur!.parentTaskId);
    if (cur === undefined) return null;
    if (cur.seriesId !== null) return `t:${cur.seriesId}|${t.title}`;
  }
  return null;
}

export interface FoldedDoneTask {
  task: Task;
  /** 该组折进来的 done 次数(≥1;1 = 没折叠,普通任务) */
  occurrenceCount: number;
}

/**
 * done 列表按系列折叠:每组保留**最近完成的一次**做代表 + 次数。
 * 顺序 = 各组代表(或未折叠任务)在输入里首次出现的位置 —— 调用方先按自己的口径排好序
 * (Completed 按 completedAt 倒序、searchAll 按相关性),折叠不重排。
 */
export function foldDoneTasks(snap: GtdSnapshot, tasks: Task[]): FoldedDoneTask[] {
  const groups = new Map<string, { rep: Task; count: number }>();
  const order: (Task | string)[] = [];
  for (const t of tasks) {
    const key = foldKeyOf(snap, t);
    if (key === null) {
      order.push(t);
      continue;
    }
    const g = groups.get(key);
    if (g === undefined) {
      groups.set(key, { rep: t, count: 1 });
      order.push(key);
      continue;
    }
    g.count += 1;
    // 代表 = completedAt 最大;平局按 id,保证确定性
    const a = t.completedAt ?? '';
    const b = g.rep.completedAt ?? '';
    if (a > b || (a === b && t.id > g.rep.id)) g.rep = t;
  }
  return order.map((e) =>
    typeof e === 'string'
      ? { task: groups.get(e)!.rep, occurrenceCount: groups.get(e)!.count }
      : { task: e, occurrenceCount: 1 },
  );
}
