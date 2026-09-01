import { describe, expect, it } from 'vitest';
import type { Task } from '../src/index';
import {
  applyToSnapshot,
  calendarDay,
  moveTask,
  reorderTodayTask,
  todayList,
  updateTask,
} from '../src/index';
import { TODAY, deps, snapshot, task } from './helpers';

/**
 * INV-38 Today 手动排序(D-40)。两段模型:
 * 未定时段(可拖,dayOrder)+ 定时段(按时刻,拖不动 —— 它同时画在 Calendar 上)。
 */

const list = (snap: ReturnType<typeof snapshot>): string[] =>
  todayList(snap, TODAY).all.map((t) => t.title);

const move = (
  snap: ReturnType<typeof snapshot>,
  id: string,
  beforeId?: string,
): ReturnType<typeof snapshot> => {
  const r = reorderTodayTask(snap, deps(), beforeId === undefined ? { id } : { id, beforeId });
  if ('error' in r) throw new Error(r.error);
  return applyToSnapshot(snap, r.commands);
};

/** A/B/C 三条全天任务 + 一条 10:00 的日历块 + 一条过期截止项 */
type Fx = 'A' | 'B' | 'C' | 'M' | 'D';
const fixture = (): { snap: ReturnType<typeof snapshot>; t: Record<Fx, Task> } => {
  const t: Record<Fx, Task> = {
    A: task({ title: 'A', scheduledDate: TODAY, createdAt: '2026-08-01T01:00:00' }),
    B: task({ title: 'B', scheduledDate: TODAY, createdAt: '2026-08-01T02:00:00' }),
    C: task({ title: 'C', scheduledDate: TODAY, createdAt: '2026-08-01T03:00:00' }),
    M: task({ title: '会议', scheduledDate: TODAY, startTime: '10:00' }),
    D: task({ title: '过期截止', deadline: '2026-08-01' }),
  };
  return { snap: snapshot({ tasks: Object.values(t) }), t };
};

describe('INV-38.1 两段口径', () => {
  it('未定时段(全天 + 过期截止)在前,定时段按时刻在后', () => {
    expect(list(fixture().snap)).toEqual(['A', 'B', 'C', '过期截止', '会议']);
  });

  it('定时段按 (计划日, 时刻):过期那天的排在今天的前面', () => {
    const snap = snapshot({
      tasks: [
        task({ title: '今天 09:00', scheduledDate: TODAY, startTime: '09:00' }),
        task({ title: '昨天 15:00', scheduledDate: '2026-08-07', startTime: '15:00' }),
      ],
    });
    expect(list(snap)).toEqual(['昨天 15:00', '今天 09:00']);
  });

  it('someday/reference 与已完成不进 Today;计划到未来的不进', () => {
    const snap = snapshot({
      tasks: [
        task({ title: '在 Today', scheduledDate: TODAY }),
        task({ title: 'someday', scheduledDate: TODAY, bucket: 'someday' }),
        task({ title: '已完成', scheduledDate: TODAY, status: 'done', completedAt: 'x' }),
        task({ title: '明天', scheduledDate: '2026-08-09' }),
        // 已推迟到未来的过期截止项不该被 deadline 拽回来(D-19)
        task({ title: '推迟过的', deadline: '2026-08-01', scheduledDate: '2026-08-20' }),
      ],
    });
    expect(list(snap)).toEqual(['在 Today']);
  });

  it('todaySortable 判据:untimed 段可拖,timed 段不可', () => {
    const { snap } = fixture();
    const { untimed, timed } = todayList(snap, TODAY);
    expect(untimed.map((t) => t.title)).toEqual(['A', 'B', 'C', '过期截止']);
    expect(timed.map((t) => t.title)).toEqual(['会议']);
  });
});

describe('INV-38.2 手动排序', () => {
  it('把 C 拖到最前:整段 materialize 成 0..N-1(不能只写被拖的那条)', () => {
    const { snap, t } = fixture();
    const r = reorderTodayTask(snap, deps(), { id: t.C.id, beforeId: t.A.id });
    if ('error' in r) throw new Error(r.error);
    // 四条未定时任务全部拿到 dayOrder —— 只写 C 的话它会因为别人是 null 而"跳到最前"
    expect(r.commands).toHaveLength(4);
    expect(list(applyToSnapshot(snap, r.commands))).toEqual(['C', 'A', 'B', '过期截止', '会议']);
  });

  it('拖到末尾 / 拖到自己身上 / 拖回原位', () => {
    const { snap, t } = fixture();
    expect(list(move(snap, t.A.id))).toEqual(['B', 'C', '过期截止', 'A', '会议']);
    const same = reorderTodayTask(snap, deps(), { id: t.A.id, beforeId: t.A.id });
    if ('error' in same) throw new Error(same.error);
    expect(same.commands).toEqual([]); // 拖到自己身上 = 原地,零命令
    const back = reorderTodayTask(snap, deps(), { id: t.A.id, beforeId: t.B.id });
    if ('error' in back) throw new Error(back.error);
    expect(back.commands).toEqual([]); // A 本来就在 B 前面
  });

  it('过期截止项也能拖(它和全天任务同属未定时段)', () => {
    const { snap, t } = fixture();
    expect(list(move(snap, t.D.id, t.A.id))).toEqual(['过期截止', 'A', 'B', 'C', '会议']);
  });

  it('定时任务拒绝手动排序,理由可读(不静默无反应)', () => {
    const { snap, t } = fixture();
    const r = reorderTodayTask(snap, deps(), { id: t.M.id, beforeId: t.A.id });
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('时间');
    // 落点是定时任务同样拒绝
    expect(reorderTodayTask(snap, deps(), { id: t.A.id, beforeId: t.M.id })).toHaveProperty(
      'error',
    );
  });

  it('不在 Today 的任务报错', () => {
    const { snap } = fixture();
    const outside = task({ title: '明天', scheduledDate: '2026-08-20' });
    const s2 = snapshot({ tasks: [...snap.tasks, outside] });
    expect(reorderTodayTask(s2, deps(), { id: outside.id })).toHaveProperty('error');
    expect(reorderTodayTask(s2, deps(), { id: 'ghost' })).toHaveProperty('error');
  });
});

describe('INV-38.3 手动序的生命周期', () => {
  it('没排过的新任务垫底,不打乱已排好的顺序', () => {
    const { snap, t } = fixture();
    const sorted = move(snap, t.C.id, t.A.id); // C A B 过期
    const fresh = task({ title: '新来的', scheduledDate: TODAY, createdAt: '2026-08-01T09:00:00' });
    const s2 = snapshot({ tasks: [...sorted.tasks, fresh] });
    expect(list(s2)).toEqual(['C', 'A', 'B', '过期截止', '新来的', '会议']);
  });

  it('改计划日会清掉手动序:推迟再挪回来的任务回队尾,不带着旧位置插队', () => {
    const { snap, t } = fixture();
    const sorted = move(snap, t.C.id, t.A.id); // C 现在 dayOrder=0
    const r = updateTask(sorted, deps(), { id: t.C.id, patch: { scheduledDate: '2026-08-20' } });
    if ('error' in r) throw new Error(r.error);
    const patch = (r.commands[0] as { patch: Partial<Task> }).patch;
    expect(patch.dayOrder).toBeNull();
    // 挪回今天(第二次 update)同样是 null → 回队尾
    const away = applyToSnapshot(sorted, r.commands);
    const r2 = updateTask(away, deps(), { id: t.C.id, patch: { scheduledDate: TODAY } });
    if ('error' in r2) throw new Error(r2.error);
    expect(list(applyToSnapshot(away, r2.commands))).toEqual(['A', 'B', '过期截止', 'C', '会议']);
  });

  it('改别的字段(优先级等)不动手动序', () => {
    const { snap, t } = fixture();
    const sorted = move(snap, t.C.id, t.A.id);
    const r = updateTask(sorted, deps(), { id: t.C.id, patch: { priority: 5 } });
    if ('error' in r) throw new Error(r.error);
    expect('dayOrder' in (r.commands[0] as { patch: object }).patch).toBe(false);
  });

  it('整包回传但值没变,不作废:再点一次「今天」/只改时长,序都还在', () => {
    const { snap, t } = fixture();
    const sorted = move(snap, t.C.id, t.A.id);
    // ① 已经是今天了,详情页的「今天」按钮照样写一遍
    const again = updateTask(sorted, deps(), { id: t.C.id, patch: { scheduledDate: TODAY } });
    if ('error' in again) throw new Error(again.error);
    expect('dayOrder' in (again.commands[0] as { patch: object }).patch).toBe(false);
    expect(list(applyToSnapshot(sorted, again.commands))).toEqual([
      'C',
      'A',
      'B',
      '过期截止',
      '会议',
    ]);
    // ② 时间编辑器一次发 {startTime, durationMinutes, timeZone},只有时长真的变了
    const dur = updateTask(sorted, deps(), {
      id: t.C.id,
      patch: { startTime: null, durationMinutes: 45, timeZone: null },
    });
    if ('error' in dur) throw new Error(dur.error);
    expect('dayOrder' in (dur.commands[0] as { patch: object }).patch).toBe(false);
    expect(list(applyToSnapshot(sorted, dur.commands))).toEqual([
      'C',
      'A',
      'B',
      '过期截止',
      '会议',
    ]);
  });

  it('挪进 someday 会清掉手动序(离开 Today 就不再是那一段的成员)', () => {
    const { snap, t } = fixture();
    const sorted = move(snap, t.C.id, t.A.id);
    const r = moveTask(sorted, deps(), { id: t.C.id, to: { bucket: 'someday' } });
    if ('error' in r) throw new Error(r.error);
    const away = applyToSnapshot(sorted, r.commands);
    expect(away.tasks.find((x) => x.id === t.C.id)?.dayOrder).toBeNull();
    // 挪回来回队尾,不带着旧的 0 号位插队
    const back = moveTask(away, deps(), { id: t.C.id, to: { bucket: 'inbox' } });
    if ('error' in back) throw new Error(back.error);
    expect(list(applyToSnapshot(away, back.commands))).toEqual(['A', 'B', '过期截止', 'C', '会议']);
  });
});

describe('INV-28.2 Calendar 全天段与 Today 未定时段同序', () => {
  it('在 Today 拖完,今天的全天条跟着变(两个视图一个答案)', () => {
    const { snap, t } = fixture();
    const before = calendarDay(snap, TODAY);
    expect(before.allDay.map((x) => x.title)).toEqual(['A', 'B', 'C']);
    const sorted = move(snap, t.C.id, t.A.id);
    const after = calendarDay(sorted, TODAY);
    expect(after.allDay.map((x) => x.title)).toEqual(['C', 'A', 'B']);
    // 与 Today 未定时段(去掉不上日历的 due 项)逐字一致
    expect(after.allDay.map((x) => x.title)).toEqual(
      todayList(sorted, TODAY)
        .untimed.filter((x) => x.scheduledDate !== null)
        .map((x) => x.title),
    );
  });
});
