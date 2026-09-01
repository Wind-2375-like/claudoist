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
 * INV-38 Today 手动排序(D-40 + D-41)。
 *
 * D-41(用户裁决,2026-09-02)把初版的两段模型拍平:**整个 Today 列表都能手动拖,
 * 带时间的日历块也不例外**。原来那条「带时间的任务在日历段按时刻排;要换位置请改它的
 * 时间」的拒绝理由连同两段模型一起删除。
 */

const list = (snap: ReturnType<typeof snapshot>): string[] =>
  todayList(snap, TODAY).map((t) => t.title);

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

describe('INV-38.1 成员与默认序', () => {
  it('默认序 = 扁平化之前的显示序,逐字不变(升级当天列表不自己重排)', () => {
    expect(list(fixture().snap)).toEqual(['A', 'B', 'C', '过期截止', '会议']);
  });

  it('默认序里的日历块按 (计划日, 时刻):过期那天的排在今天的前面', () => {
    const snap = snapshot({
      tasks: [
        task({ title: '今天 09:00', scheduledDate: TODAY, startTime: '09:00' }),
        task({ title: '昨天 15:00', scheduledDate: '2026-08-07', startTime: '15:00' }),
        task({ title: '无时刻', scheduledDate: TODAY }),
      ],
    });
    // 无时刻的仍然在前(默认序不变),日历块之间按 计划日 → 时刻
    expect(list(snap)).toEqual(['无时刻', '昨天 15:00', '今天 09:00']);
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
});

describe('INV-38.2 手动排序:整个列表,不分段(D-41)', () => {
  it('把 C 拖到最前:整列表 materialize 成 0..N-1(不能只写被拖的那条)', () => {
    const { snap, t } = fixture();
    const r = reorderTodayTask(snap, deps(), { id: t.C.id, beforeId: t.A.id });
    if ('error' in r) throw new Error(r.error);
    // 五条全部拿到 dayOrder —— 只写 C 的话它会因为别人是 null 而"跳到最前"
    expect(r.commands).toHaveLength(5);
    expect(list(applyToSnapshot(snap, r.commands))).toEqual(['C', 'A', 'B', '过期截止', '会议']);
  });

  it('**带时间的会议可以拖到任意位置**(D-41 的正题)', () => {
    const { snap, t } = fixture();
    expect(list(move(snap, t.M.id, t.A.id))).toEqual(['会议', 'A', 'B', 'C', '过期截止']);
  });

  it('也可以把别的行拖到会议之前/之后 —— 落点是会议不再被拒', () => {
    const { snap, t } = fixture();
    expect(list(move(snap, t.A.id, t.M.id))).toEqual(['B', 'C', '过期截止', 'A', '会议']);
  });

  it('拖完之后顺序稳定:会议留在用户放的位置,不被时刻拽回队尾', () => {
    const { snap, t } = fixture();
    const s1 = move(snap, t.M.id, t.B.id); // A 会议 B C 过期
    expect(list(s1)).toEqual(['A', '会议', 'B', 'C', '过期截止']);
    // 再拖别的行,会议的相对位置不该被重新按时刻排
    const s2 = move(s1, t.C.id, t.A.id);
    expect(list(s2)).toEqual(['C', 'A', '会议', 'B', '过期截止']);
  });

  it('拖到末尾 / 拖到自己身上 / 拖回原位', () => {
    const { snap, t } = fixture();
    expect(list(move(snap, t.A.id))).toEqual(['B', 'C', '过期截止', '会议', 'A']);
    const same = reorderTodayTask(snap, deps(), { id: t.A.id, beforeId: t.A.id });
    if ('error' in same) throw new Error(same.error);
    expect(same.commands).toEqual([]); // 拖到自己身上 = 原地,零命令
    const back = reorderTodayTask(snap, deps(), { id: t.A.id, beforeId: t.B.id });
    if ('error' in back) throw new Error(back.error);
    expect(back.commands).toEqual([]); // A 本来就在 B 前面
  });

  it('过期截止项也能拖', () => {
    const { snap, t } = fixture();
    expect(list(move(snap, t.D.id, t.A.id))).toEqual(['过期截止', 'A', 'B', 'C', '会议']);
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
    const sorted = move(snap, t.C.id, t.A.id); // C A B 过期 会议
    const fresh = task({ title: '新来的', scheduledDate: TODAY, createdAt: '2026-08-01T09:00:00' });
    const s2 = snapshot({ tasks: [...sorted.tasks, fresh] });
    expect(list(s2)).toEqual(['C', 'A', 'B', '过期截止', '会议', '新来的']);
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
    expect(list(applyToSnapshot(away, r2.commands))).toEqual(['A', 'B', '过期截止', '会议', 'C']);
  });

  it('**改时刻不再清手动序**(D-41):会议改了钟点,仍然待在用户放的位置', () => {
    const { snap, t } = fixture();
    const sorted = move(snap, t.M.id, t.B.id); // A 会议 B C 过期
    const r = updateTask(sorted, deps(), { id: t.M.id, patch: { startTime: '08:00' } });
    if ('error' in r) throw new Error(r.error);
    expect('dayOrder' in (r.commands[0] as { patch: object }).patch).toBe(false);
    expect(list(applyToSnapshot(sorted, r.commands))).toEqual(['A', '会议', 'B', 'C', '过期截止']);
  });

  it('改别的字段(优先级等)不动手动序', () => {
    const { snap, t } = fixture();
    const sorted = move(snap, t.C.id, t.A.id);
    const r = updateTask(sorted, deps(), { id: t.C.id, patch: { priority: 5 } });
    if ('error' in r) throw new Error(r.error);
    expect('dayOrder' in (r.commands[0] as { patch: object }).patch).toBe(false);
  });

  it('整包回传但值没变,不作废:再点一次「今天」序还在', () => {
    const { snap, t } = fixture();
    const sorted = move(snap, t.C.id, t.A.id);
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
  });

  it('挪进 someday 会清掉手动序(整个离开 Today)', () => {
    const { snap, t } = fixture();
    const sorted = move(snap, t.C.id, t.A.id);
    const r = moveTask(sorted, deps(), { id: t.C.id, to: { bucket: 'someday' } });
    if ('error' in r) throw new Error(r.error);
    const away = applyToSnapshot(sorted, r.commands);
    expect(away.tasks.find((x) => x.id === t.C.id)?.dayOrder).toBeNull();
    // 挪回来回队尾,不带着旧的 0 号位插队
    const back = moveTask(away, deps(), { id: t.C.id, to: { bucket: 'inbox' } });
    if ('error' in back) throw new Error(back.error);
    expect(list(applyToSnapshot(away, back.commands))).toEqual(['A', 'B', '过期截止', '会议', 'C']);
  });

  it('升级兼容:两段时代排过的 dayOrder(只在无时刻行上)照旧生效,列表不乱', () => {
    // 老库形态:A/B/C 在两段模型下被拖成 C A B(0/1/2),会议与过期项从未拿到 dayOrder
    const t = {
      A: task({ title: 'A', scheduledDate: TODAY, dayOrder: 1, createdAt: '2026-08-01T01:00:00' }),
      B: task({ title: 'B', scheduledDate: TODAY, dayOrder: 2, createdAt: '2026-08-01T02:00:00' }),
      C: task({ title: 'C', scheduledDate: TODAY, dayOrder: 0, createdAt: '2026-08-01T03:00:00' }),
      M: task({ title: '会议', scheduledDate: TODAY, startTime: '10:00' }),
      D: task({ title: '过期截止', deadline: '2026-08-01' }),
    };
    // 扁平化后显示序与两段模型下逐字相同 —— 老用户升级当天看不出任何变化
    expect(list(snapshot({ tasks: Object.values(t) }))).toEqual([
      'C',
      'A',
      'B',
      '过期截止',
      '会议',
    ]);
  });
});

describe('INV-28.2 Calendar 全天段与 Today 同序', () => {
  it('在 Today 拖完,今天的全天条跟着变', () => {
    const { snap, t } = fixture();
    expect(calendarDay(snap, TODAY).allDay.map((x) => x.title)).toEqual(['A', 'B', 'C']);
    const sorted = move(snap, t.C.id, t.A.id);
    const after = calendarDay(sorted, TODAY);
    expect(after.allDay.map((x) => x.title)).toEqual(['C', 'A', 'B']);
    // 与 Today 里那几行(去掉不上日历的 due 项和定时块)逐字一致
    expect(after.allDay.map((x) => x.title)).toEqual(
      todayList(sorted, TODAY)
        .filter((x) => x.scheduledDate !== null && x.startTime === null)
        .map((x) => x.title),
    );
  });

  it('Calendar 的定时段仍按时刻画,与 Today 的手动序**故意**不同(D-41 接受的代价)', () => {
    const snap = snapshot({
      tasks: [
        task({ title: '早会', scheduledDate: TODAY, startTime: '09:00' }),
        task({ title: '晚会', scheduledDate: TODAY, startTime: '17:00' }),
      ],
    });
    const t = snap.tasks;
    const sorted = move(snap, t[1]!.id, t[0]!.id); // 在 Today 把晚会拖到早会前面
    expect(list(sorted)).toEqual(['晚会', '早会']);
    // 日历不跟着换:一个把 17:00 画在 09:00 位置的日历是坏掉的日历
    expect(calendarDay(sorted, TODAY).timed.map((x) => x.title)).toEqual(['早会', '晚会']);
  });
});
