import { describe, expect, it } from 'vitest';
import type { RepeatRule, Task } from '../src/index';
import { foldDoneTasks, foldKeyOf, projectStats, searchAll } from '../src/index';
import { deps, project, snapshot, task } from './helpers';

/**
 * INV-36.14 系列折叠(2026-08-13 用户拍板):projectStats / searchAll / Completed
 * 共用一份归组键(seriesFold.foldKeyOf)。
 *
 * 折叠要解决的是数字失真:一个每日循环一年灌 365 条 done —— 进度条被推到接近 1 并永远
 * 卡在那;搜索/Completed 的 done 段被同标题行刷屏。零回归约束:不含循环的项目/结果逐字不变。
 */

const RULE: RepeatRule = {
  every: 1,
  unit: 'day',
  from: 'scheduled',
  weekdays: null,
  until: null,
  anchor: '2026-08-01',
};

/** 一个系列:N 条 done occurrence + 可选 1 条 active 当前次(共享 seriesId)。 */
function seriesRows(opts: {
  seriesId: string;
  title: string;
  doneCount: number;
  withActive: boolean;
  projectId?: string;
}): Task[] {
  const rows: Task[] = [];
  for (let i = 0; i < opts.doneCount; i += 1) {
    rows.push(
      task({
        title: opts.title,
        status: 'done',
        completedAt: `2026-08-${String(i + 1).padStart(2, '0')}T08:00:00`,
        scheduledDate: `2026-08-${String(i + 1).padStart(2, '0')}`,
        repeat: RULE,
        seriesId: opts.seriesId,
        ...(opts.projectId !== undefined ? { projectId: opts.projectId, bucket: 'project' } : {}),
      }),
    );
  }
  if (opts.withActive) {
    rows.push(
      task({
        title: opts.title,
        scheduledDate: '2026-08-20',
        repeat: RULE,
        seriesId: opts.seriesId,
        ...(opts.projectId !== undefined ? { projectId: opts.projectId, bucket: 'project' } : {}),
      }),
    );
  }
  return rows;
}

describe('foldKeyOf:归组键', () => {
  it('系列根按 seriesId;occurrence 子树副本沿 parent 链上溯按(系列, 标题)', () => {
    const root = task({
      title: '大扫除',
      repeat: RULE,
      seriesId: 's1',
      scheduledDate: '2026-08-01',
    });
    const kitchen = task({ title: '厨房', parentTaskId: root.id });
    const sink = task({ title: '水槽', parentTaskId: kitchen.id }); // 两层深也归到根的系列
    const plain = task({ title: '普通任务' });
    const snap = snapshot({ tasks: [root, kitchen, sink, plain] });
    expect(foldKeyOf(snap, root)).toBe('s:s1');
    expect(foldKeyOf(snap, kitchen)).toBe('t:s1|厨房');
    expect(foldKeyOf(snap, sink)).toBe('t:s1|水槽');
    expect(foldKeyOf(snap, plain)).toBeNull();
  });

  it('父链断裂(父被硬删)/ 无系列父链 → null,不炸', () => {
    const orphan = task({ title: '孤儿', parentTaskId: 'ghost' });
    const p1 = task({ title: '普通父' });
    const c1 = task({ title: '普通子', parentTaskId: p1.id });
    const snap = snapshot({ tasks: [orphan, p1, c1] });
    expect(foldKeyOf(snap, orphan)).toBeNull();
    expect(foldKeyOf(snap, c1)).toBeNull();
  });
});

describe('projectStats 按系列折叠(R8:进度条不被循环灌水)', () => {
  it('系列有 active → 计 1 active、0 done;done occurrence 不进分子', () => {
    const p = project();
    const rows = seriesRows({
      seriesId: 's1',
      title: '每日站会',
      doneCount: 30,
      withActive: true,
      projectId: p.id,
    });
    const snap = snapshot({ projects: [p], tasks: rows });
    const st = projectStats(snap, p.id);
    expect(st).toEqual({ activeCount: 1, doneCount: 0, progress: 0 });
  });

  it('系列结束(全 done)→ 作为一件事计 1 done', () => {
    const p = project();
    const rows = seriesRows({
      seriesId: 's1',
      title: '搬家收尾',
      doneCount: 4,
      withActive: false,
      projectId: p.id,
    });
    const snap = snapshot({ projects: [p], tasks: rows });
    expect(projectStats(snap, p.id)).toEqual({ activeCount: 0, doneCount: 1, progress: 1 });
  });

  it('occurrence 子树副本按(系列,标题)折叠:每周大扫除+3 子任务不随周数膨胀', () => {
    const p = project();
    const mk = (week: number, done: boolean): Task[] => {
      const root = task({
        title: '大扫除',
        status: done ? 'done' : 'active',
        completedAt: done ? `2026-08-0${week}T09:00:00` : null,
        scheduledDate: `2026-08-0${week}`,
        repeat: RULE,
        seriesId: 's1',
        projectId: p.id,
      });
      const subs = ['厨房', '卫生间', '阳台'].map((title) =>
        task({
          title,
          status: done ? 'done' : 'active',
          completedAt: done ? `2026-08-0${week}T09:00:00` : null,
          parentTaskId: root.id,
          projectId: p.id,
          bucket: 'project',
        }),
      );
      return [root, ...subs];
    };
    // 三期已完成 + 当前一期 active:16 行 → 折叠后 4 件事全 active
    const snap = snapshot({
      projects: [p],
      tasks: [...mk(1, true), ...mk(2, true), ...mk(3, true), ...mk(4, false)],
    });
    expect(projectStats(snap, p.id)).toEqual({ activeCount: 4, doneCount: 0, progress: 0 });
  });

  it('零回归:不含循环的项目数字逐字不变', () => {
    const p = project();
    const snap = snapshot({
      projects: [p],
      tasks: [
        task({ projectId: p.id, bucket: 'project' }),
        task({ projectId: p.id, bucket: 'project', status: 'done', completedAt: 'x' }),
        task({ projectId: p.id, bucket: 'project', status: 'done', completedAt: 'y' }),
        task({ projectId: p.id, bucket: 'project', status: 'deleted', deletedAt: 'z' }),
      ],
    });
    expect(projectStats(snap, p.id)).toEqual({ activeCount: 1, doneCount: 2, progress: 2 / 3 });
  });

  it('混合:普通任务照常计,系列折叠计', () => {
    const p = project();
    const snap = snapshot({
      projects: [p],
      tasks: [
        task({ projectId: p.id, bucket: 'project', title: '一次性活' }),
        ...seriesRows({
          seriesId: 's1',
          title: '每日站会',
          doneCount: 10,
          withActive: true,
          projectId: p.id,
        }),
      ],
    });
    // 1 普通 active + 1 系列 active = 2;done 0
    expect(projectStats(snap, p.id)).toEqual({ activeCount: 2, doneCount: 0, progress: 0 });
  });
});

describe('searchAll 按系列折叠(R9:done 段不被刷屏)', () => {
  it('30 条 done occurrence + 1 条 active → 2 条结果;代表是最近完成的一次;totalMatched 报折叠后', () => {
    const rows = seriesRows({ seriesId: 's1', title: '每日站会', doneCount: 30, withActive: true });
    const snap = snapshot({ tasks: rows });
    const r = searchAll(snap, deps(), { query: '站会' });
    if ('error' in r) throw new Error(r.error);
    const c = r.consequences;
    expect(c.tasks).toHaveLength(2);
    expect(c.tasks[0]!.status).toBe('active'); // active 永远单独成行且在前
    const rep = c.tasks[1]!;
    expect(rep.status).toBe('done');
    expect(rep.completedAt).toBe('2026-08-30T08:00:00'); // 最近一次做代表
    expect(c.doneFoldCounts[rep.id]).toBe(30);
    expect(c.totalMatched).toBe(2);
  });

  it('零回归:普通任务不折叠、doneFoldCounts 为空', () => {
    const snap = snapshot({
      tasks: [
        task({ title: '写报告' }),
        task({ title: '写报告草稿', status: 'done', completedAt: 'x' }),
      ],
    });
    const r = searchAll(snap, deps(), { query: '报告' });
    if ('error' in r) throw new Error(r.error);
    expect(r.consequences.tasks).toHaveLength(2);
    expect(r.consequences.doneFoldCounts).toEqual({});
  });

  it('limit 在折叠后生效:折叠把长尾让给别的结果', () => {
    const rows = seriesRows({
      seriesId: 's1',
      title: '每日站会',
      doneCount: 40,
      withActive: false,
    });
    const other = task({
      title: '站会纪要模板',
      status: 'done',
      completedAt: '2026-01-01T00:00:00',
    });
    const snap = snapshot({ tasks: [...rows, other] });
    const r = searchAll(snap, deps(), { query: '站会', limit: 5 });
    if ('error' in r) throw new Error(r.error);
    // 40 条折 1 + 1 条普通 = 2,远小于 limit —— 折叠前它们会占满 5 个位置把 other 挤没
    expect(r.consequences.tasks).toHaveLength(2);
  });
});

describe('foldDoneTasks(Completed 视图口径)', () => {
  it('保持输入顺序;代表取 completedAt 最大;普通任务原样穿过', () => {
    const rows = [
      task({ title: '普通A', status: 'done', completedAt: '2026-08-31T00:00:00' }),
      ...seriesRows({ seriesId: 's1', title: '每日站会', doneCount: 3, withActive: false }),
      task({ title: '普通B', status: 'done', completedAt: '2026-07-01T00:00:00' }),
    ];
    const snap = snapshot({ tasks: rows });
    // 输入按 completedAt 倒序(Completed 视图的口径)
    const sorted = [...rows].sort((a, b) =>
      (a.completedAt ?? '') > (b.completedAt ?? '') ? -1 : 1,
    );
    const folded = foldDoneTasks(snap, sorted);
    expect(folded.map((f) => [f.task.title, f.occurrenceCount])).toEqual([
      ['普通A', 1],
      ['每日站会', 3],
      ['普通B', 1],
    ]);
    expect(folded[1]!.task.completedAt).toBe('2026-08-03T08:00:00');
  });
});

describe('INV-36.14 修复回归钉子(对抗审查抓到的三条)', () => {
  it('searchAll:普通 done 任务(未折叠)不出现在 doneFoldCounts —— ⌘K 靠这一点区分「已完成」与「📅」分支', () => {
    const snap = snapshot({
      tasks: [
        task({
          title: '交季度报告',
          status: 'done',
          completedAt: '2026-08-12T09:00:00',
          scheduledDate: '2026-08-10', // INV-28:完成不清计划日
        }),
      ],
    });
    const r = searchAll(snap, deps(), { query: '季度' });
    if ('error' in r) throw new Error(r.error);
    expect(r.consequences.doneFoldCounts).toEqual({});
    // 只完成过一次的循环 occurrence 同样不进(fold 只含 >1 的组)
    const one = seriesRows({ seriesId: 's9', title: '新循环', doneCount: 1, withActive: false });
    const r2 = searchAll(snapshot({ tasks: one }), deps(), { query: '新循环' });
    if ('error' in r2) throw new Error(r2.error);
    expect(r2.consequences.doneFoldCounts).toEqual({});
  });
});
