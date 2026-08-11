import { describe, expect, it } from 'vitest';
import { externalKey, isExternalTask, syncExternalTasks, updateTask } from '../src/index';
import { applyToSnapshot } from '../src/index';
import { isUsecaseError } from '../src/usecases/types';
import { deps, snapshot, task } from './helpers';

/** INV-29(D-25/M6c-3a):外部日历事件镜像为任务 —— 时间外部拥有,其余本地自治。 */
const KEY = externalKey('google', 'me@x.com', 'cal1', 'ev1');
const ev = (over: Partial<Parameters<typeof syncExternalTasks>[2]['events'][number]> = {}) => ({
  externalId: KEY,
  externalCalendarId: 'cal1',
  title: '组会',
  scheduledDate: '2026-08-10',
  startTime: '15:00' as string | null,
  durationMinutes: 60 as number | null,
  ...over,
});
const base = () => snapshot({});
const sync = (snap: ReturnType<typeof base>, events: ReturnType<typeof ev>[]) => {
  const r = syncExternalTasks(snap, deps(), {
    fromDate: '2026-08-10',
    toDate: '2026-08-16',
    events,
    fetchedCalendarIds: ['cal1'],
  });
  if (isUsecaseError(r)) throw new Error(r.error);
  return r;
};

describe('INV-29 外部镜像:同步为任务', () => {
  it('新事件 → 建镜像任务(带 externalId,时间照抄)', () => {
    const r = sync(base(), [ev()]);
    expect(r.consequences.created).toBe(1);
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createTask') throw new Error('expected createTask');
    expect(cmd.task.externalId).toBe(KEY);
    expect(cmd.task.startTime).toBe('15:00');
    expect(cmd.task.durationMinutes).toBe(60);
    expect(isExternalTask(cmd.task)).toBe(true);
  });

  it('幂等:同一批再同步一次 → 零命令', () => {
    const after = applyToSnapshot(base(), sync(base(), [ev()]).commands);
    expect(sync(after, [ev()]).commands).toHaveLength(0);
  });

  it('外部改时间 → 只更新时间字段;**不碰**本地已勾的完成状态', () => {
    const snap = snapshot({
      tasks: [
        task({
          id: 'm1',
          externalId: KEY,
          externalCalendarId: 'cal1',
          title: '组会',
          scheduledDate: '2026-08-10',
          startTime: '15:00',
          durationMinutes: 60,
          status: 'done',
          completedAt: '2026-08-10T16:00:00',
          priority: 5,
        }),
      ],
    });
    const r = sync(snap, [ev({ startTime: '16:30' })]);
    expect(r.consequences.updated).toBe(1);
    const after = applyToSnapshot(snap, r.commands);
    const m = after.tasks.find((t) => t.id === 'm1')!;
    expect(m.startTime).toBe('16:30');
    expect(m.status).toBe('done'); // 本地状态不被同步抹掉
    expect(m.priority).toBe(5);
  });

  it('外部删除 → 未完成镜像软删;已完成的保留作历史', () => {
    const snap = snapshot({
      tasks: [
        task({
          id: 'a',
          externalId: `${KEY}:a`,
          externalCalendarId: 'cal1',
          scheduledDate: '2026-08-11',
          startTime: '09:00',
        }),
        task({
          id: 'b',
          externalId: `${KEY}:b`,
          externalCalendarId: 'cal1',
          scheduledDate: '2026-08-11',
          startTime: '10:00',
          status: 'done',
          completedAt: '2026-08-11T11:00:00',
        }),
      ],
    });
    const after = applyToSnapshot(snap, sync(snap, []).commands);
    expect(after.tasks.find((t) => t.id === 'a')!.status).toBe('deleted');
    expect(after.tasks.find((t) => t.id === 'b')!.status).toBe('done');
  });

  it('拉取失败(本轮无成功日历)→ 一个都不退休(断网不该清空 Today)', () => {
    const snap = snapshot({
      tasks: [
        task({
          id: 'a',
          externalId: `${KEY}:a`,
          externalCalendarId: 'cal1',
          scheduledDate: '2026-08-11',
        }),
      ],
    });
    const r = syncExternalTasks(snap, deps(), {
      fromDate: '2026-08-10',
      toDate: '2026-08-16',
      events: [],
      fetchedCalendarIds: [], // 全部失败
    });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.commands).toHaveLength(0);
  });

  it('被退休的镜像再次出现 → **复活原任务**(保住标签/子任务,且不撞唯一索引)', () => {
    const snap = snapshot({
      tasks: [
        task({
          id: 'old',
          externalId: KEY,
          externalCalendarId: 'cal1',
          status: 'deleted',
          deletedAt: '2026-08-10T00:00:00',
          priority: 5,
        }),
      ],
    });
    const r = sync(snap, [ev()]);
    expect(r.commands).toHaveLength(1);
    const after = applyToSnapshot(snap, r.commands);
    const t = after.tasks.find((x) => x.id === 'old')!;
    expect(t.status).toBe('active');
    expect(t.priority).toBe(5); // 本地属性保住
    expect(after.tasks.filter((x) => x.externalId === KEY)).toHaveLength(1);
  });

  it('窗口外的镜像不被误退休', () => {
    const snap = snapshot({
      tasks: [
        task({
          id: 'far',
          externalId: 'google:me:cal:far',
          externalCalendarId: 'cal1',
          scheduledDate: '2026-09-01',
        }),
      ],
    });
    expect(sync(snap, []).commands).toHaveLength(0);
  });
});

describe('INV-29 外部镜像:本地可改什么', () => {
  const mirror = () =>
    snapshot({
      tasks: [
        task({
          id: 'm1',
          externalId: KEY,
          title: '组会',
          scheduledDate: '2026-08-10',
          startTime: '15:00',
        }),
      ],
    });

  it('拒绝本地改标题/日期/时刻/时长(会被下次同步覆盖,且我们不回写 Google)', () => {
    for (const patch of [
      { title: '改名' },
      { scheduledDate: '2026-08-11' },
      { startTime: '09:00' },
      { durationMinutes: 30 },
    ]) {
      const r = updateTask(mirror(), deps(), { id: 'm1', patch });
      expect('error' in r).toBe(true);
    }
  });

  it('允许本地改优先级/描述/截止(本地自治)', () => {
    for (const patch of [
      { priority: 5 },
      { description: '记得带电脑' },
      { deadline: '2026-08-12' },
    ]) {
      const r = updateTask(mirror(), deps(), { id: 'm1', patch });
      expect(isUsecaseError(r)).toBe(false);
    }
  });
});
