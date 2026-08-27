import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOCK_MINUTES,
  SNAP_MINUTES,
  addDaysIso,
  blockFromDrag,
  endTimeLabel,
  blockEndMinutes,
  blockFromClick,
  blockFromRange,
  blockMinutes,
  calendarDay,
  isoTimeFromMinutes,
  minutesOfDay,
  snapToQuarter,
} from '../src/index';
import { ctx, project, snapshot, task } from './helpers';

/** INV-28(D-23/M6b):日历网格口径 —— 哪些任务上日历、四等分吸附、block 区间换算。 */
describe('INV-28 日历网格:刻度吸附与 block 区间', () => {
  it('minutesOfDay / isoTimeFromMinutes 互逆;越界钳到 0..23:59', () => {
    expect(minutesOfDay('09:15')).toBe(555);
    expect(isoTimeFromMinutes(555)).toBe('09:15');
    expect(isoTimeFromMinutes(-30)).toBe('00:00');
    expect(isoTimeFromMinutes(99999)).toBe('23:59');
  });

  it('snapToQuarter 向下吸附到 5 分钟刻度(2026-08-10 用户改定)', () => {
    expect(snapToQuarter(0)).toBe(0);
    expect(snapToQuarter(4)).toBe(0);
    expect(snapToQuarter(5)).toBe(5);
    expect(snapToQuarter(59)).toBe(55);
    expect(SNAP_MINUTES).toBe(5);
  });

  it('单击刻度 → 默认 30 分钟块(00→00:00-00:30,45→45 起跨到下一小时)', () => {
    expect(blockFromClick(0)).toEqual({ startTime: '00:00', durationMinutes: 30 });
    expect(blockFromClick(9 * 60 + 45)).toEqual({ startTime: '09:45', durationMinutes: 30 });
    // 5 分钟吸附:点 09:23 → 从 09:20 起 30 分钟
    expect(blockFromClick(9 * 60 + 23)).toEqual({ startTime: '09:20', durationMinutes: 30 });
    expect(DEFAULT_BLOCK_MINUTES).toBe(30);
  });

  it('拖选区间:start 向下吸附、end 向上吸附;最短一个刻度;不跨午夜', () => {
    expect(blockFromRange(14 * 60, 15 * 60 + 30)).toEqual({
      startTime: '14:00',
      durationMinutes: 90,
    });
    // 反向/零长拖选 → 至少一个刻度(5 分钟)
    expect(blockFromRange(10 * 60, 10 * 60)).toEqual({ startTime: '10:00', durationMinutes: 5 });
    // 末端钳到 24:00(23:55 起最多 5 分钟)
    expect(blockFromRange(23 * 60 + 55, 25 * 60)).toEqual({
      startTime: '23:55',
      durationMinutes: 5,
    });
  });

  it('blockMinutes:显式时长优先,否则回退 estimatedMinutes;end 不跨午夜', () => {
    const explicit = task({ startTime: '09:00', durationMinutes: 45, estimatedMinutes: 15 });
    expect(blockMinutes(explicit)).toBe(45);
    expect(blockEndMinutes(explicit)).toBe(9 * 60 + 45);
    const fallback = task({ startTime: '09:00', durationMinutes: null, estimatedMinutes: 25 });
    expect(blockMinutes(fallback)).toBe(25);
    // 跨午夜截断
    const late = task({ startTime: '23:30', durationMinutes: 120 });
    expect(blockEndMinutes(late)).toBe(1440);
    // 无 startTime(全天)→ 0
    expect(blockEndMinutes(task({ startTime: null }))).toBe(0);
  });

  it('addDaysIso 跨月/跨年正确(UTC 计算,不受本地时区影响)', () => {
    expect(addDaysIso('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('addDaysIso 非法输入原样返回、不抛异常(读取侧宽容;曾抛 RangeError/静默滚月)', () => {
    for (const bad of ['abc', '', '2026', '2026-13-45', '2026-02-30', '2026-8-1']) {
      expect(addDaysIso(bad, 1)).toBe(bad);
    }
  });

  it('blockFromDrag:位移不足一格 = 单击(30 分钟),否则取区间(UI 与 CLI 同一判定)', () => {
    // 09:00 按下、09:03 松开(不足一个 5 分钟刻度)→ 单击语义
    expect(blockFromDrag(540, 543)).toEqual({ startTime: '09:00', durationMinutes: 30 });
    // 反向拖选同样成立
    expect(blockFromDrag(543, 540)).toEqual({ startTime: '09:00', durationMinutes: 30 });
    // 越过一格 → 区间(end 向上吸附)
    expect(blockFromDrag(540, 620)).toEqual({ startTime: '09:00', durationMinutes: 80 });
  });

  it('endTimeLabel:1440 显示 24:00(isoTimeFromMinutes 只能到 23:59)', () => {
    expect(endTimeLabel(1440)).toBe('24:00');
    expect(endTimeLabel(1439)).toBe('23:59');
    expect(endTimeLabel(540)).toBe('09:00');
    // 23:30 起 60 分钟的块被钳到午夜 → 展示 24:00,而非 23:59
    expect(endTimeLabel(blockEndMinutes(task({ startTime: '23:30', durationMinutes: 60 })))).toBe(
      '24:00',
    );
  });
});

describe('INV-28 日历网格:某日的全天段与定时段', () => {
  const day = '2026-08-10';
  const base = () =>
    snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'timed-late', scheduledDate: day, startTime: '15:00' }),
        task({ id: 'timed-early', scheduledDate: day, startTime: '09:30' }),
        // 故意让 sortOrder 与 createdAt 相反:断言按 createdAt(a 早于 b)而非 sortOrder
        task({
          id: 'allday-b',
          scheduledDate: day,
          startTime: null,
          sortOrder: 0,
          createdAt: '2026-08-01T10:00:00',
        }),
        task({
          id: 'allday-a',
          scheduledDate: day,
          startTime: null,
          sortOrder: 1,
          createdAt: '2026-08-01T09:00:00',
        }),
        task({ id: 'done-timed', scheduledDate: day, startTime: '11:00', status: 'done' }),
        task({ id: 'deleted', scheduledDate: day, startTime: '12:00', status: 'deleted' }),
        task({ id: 'someday', scheduledDate: day, startTime: '13:00', bucket: 'someday' }),
        task({ id: 'reference', scheduledDate: day, startTime: '14:00', bucket: 'reference' }),
        task({ id: 'other-day', scheduledDate: addDaysIso(day, 1), startTime: '09:00' }),
        task({ id: 'unscheduled', scheduledDate: null, startTime: '09:00' }),
      ],
    });

  it('定时段按 startTime 升序;全天段按 createdAt(与 Today 同口径)', () => {
    const { allDay, timed } = calendarDay(base(), day);
    expect(timed.map((t) => t.id)).toEqual(['timed-early', 'done-timed', 'timed-late']);
    expect(allDay.map((t) => t.id)).toEqual(['allday-a', 'allday-b']);
  });

  it('全天段跨容器不按 sortOrder 排(否则与 Today 相互矛盾:项目任务会插到 inbox 中间)', () => {
    // inbox 组 sortOrder 0/1/2;项目任务在自己组内 sortOrder=0 但创建最晚
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      projects: [project({ id: 'p1' })],
      tasks: [
        task({
          id: 'a',
          scheduledDate: day,
          startTime: null,
          sortOrder: 0,
          createdAt: '2026-08-01T09:00:00',
        }),
        task({
          id: 'b',
          scheduledDate: day,
          startTime: null,
          sortOrder: 1,
          createdAt: '2026-08-01T10:00:00',
        }),
        task({
          id: 'c',
          scheduledDate: day,
          startTime: null,
          sortOrder: 2,
          createdAt: '2026-08-01T11:00:00',
        }),
        task({
          id: 'z',
          scheduledDate: day,
          startTime: null,
          projectId: 'p1',
          bucket: 'project',
          sortOrder: 0,
          createdAt: '2026-08-01T12:00:00',
        }),
      ],
    });
    expect(calendarDay(snap, day).allDay.map((t) => t.id)).toEqual(['a', 'b', 'c', 'z']);
  });

  it('done 任务仍在日历上(显示为完成,不移除);deleted / someday / reference / 别日 / 未计划不入', () => {
    const { allDay, timed } = calendarDay(base(), day);
    const ids = [...allDay, ...timed].map((t) => t.id);
    expect(ids).toContain('done-timed');
    for (const gone of ['deleted', 'someday', 'reference', 'other-day', 'unscheduled']) {
      expect(ids).not.toContain(gone);
    }
  });

  it('startTime 非空但未计划哪天 → 不上日历(须与 scheduledDate 搭配)', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [task({ id: 'dangling', scheduledDate: null, startTime: '10:00' })],
    });
    expect(calendarDay(snap, day).timed).toHaveLength(0);
  });
});
