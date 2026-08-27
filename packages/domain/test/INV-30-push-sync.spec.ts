import { describe, expect, it } from 'vitest';
import {
  applyPulledEvents,
  applyToSnapshot,
  planPush,
  pushFingerprint,
  recordPushed,
  updateTask,
} from '../src/index';
import { isUsecaseError } from '../src/usecases/types';
import { ctx, deps, snapshot, task } from './helpers';

/** INV-30(D-26/M6c-3b):任务 ↔ 专用 Claudoist 日历的双向同步。 */
describe('INV-30 推送计划', () => {
  it('已排期任务 → 待推送;未排期/已删除/外部镜像不推', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'a', scheduledDate: '2026-08-12', startTime: '09:00', durationMinutes: 30 }),
        task({ id: 'b' }), // 未排期
        task({ id: 'c', scheduledDate: '2026-08-12', status: 'deleted' }),
        task({ id: 'm', scheduledDate: '2026-08-12', externalId: 'google:x:y:z' }), // 镜像不回推
      ],
    });
    expect(planPush(snap).upsert.map((u) => u.taskId)).toEqual(['a']);
  });

  it('指纹未变 → 不重复推送;改标题/时间/完成 → 重新推送', () => {
    const t = task({ id: 'a', scheduledDate: '2026-08-12', startTime: '09:00' });
    const pushed = { ...t, pushedEventId: 'ev1', pushedFingerprint: pushFingerprint(t) };
    const snap = snapshot({ contexts: [ctx({ id: 'c1' })], tasks: [pushed] });
    expect(planPush(snap).upsert).toHaveLength(0);

    for (const change of [{ title: '改名' }, { startTime: '10:00' }, { status: 'done' as const }]) {
      const changed = snapshot({
        contexts: [ctx({ id: 'c1' })],
        tasks: [{ ...pushed, ...change }],
      });
      expect(planPush(changed).upsert).toHaveLength(1);
    }
  });

  it('取消排期/删除已推送的任务 → 撤下事件', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [task({ id: 'a', scheduledDate: null, pushedEventId: 'ev1', pushedFingerprint: 'x' })],
    });
    expect(planPush(snap).remove).toEqual([{ taskId: 'a', eventId: 'ev1' }]);
  });

  it('recordPushed 把事件 id 与指纹写回任务', () => {
    const snap = snapshot({ contexts: [ctx({ id: 'c1' })], tasks: [task({ id: 'a' })] });
    const after = applyToSnapshot(
      snap,
      recordPushed([{ taskId: 'a', eventId: 'ev9', fingerprint: 'fp' }]),
    );
    expect(after.tasks[0]!.pushedEventId).toBe('ev9');
    expect(after.tasks[0]!.pushedFingerprint).toBe('fp');
  });
});

describe('INV-30 回同步(Google 侧改动 → 任务)', () => {
  /** 已推送且**指纹与本地一致**(= 本地没有未推送的改动)。 */
  const pushed = (over = {}) => {
    const t = task({
      id: 'a',
      scheduledDate: '2026-08-12',
      startTime: '09:00',
      durationMinutes: 30,
      pushedEventId: 'ev1',
      ...over,
    });
    return { ...t, pushedFingerprint: pushFingerprint(t) };
  };
  const run = (
    snap: ReturnType<typeof snapshot>,
    events: Parameters<typeof applyPulledEvents>[2],
  ) => {
    const r = applyPulledEvents(snap, deps(), events);
    if (isUsecaseError(r)) throw new Error(r.error);
    return { r, after: applyToSnapshot(snap, r.commands) };
  };

  it('在 Google 里拖动 block → 任务改期', () => {
    const snap = snapshot({ contexts: [ctx({ id: 'c1' })], tasks: [pushed()] });
    const { r, after } = run(snap, [
      {
        eventId: 'ev1',
        taskId: null,
        cancelled: false,
        date: '2026-08-13',
        startTime: '14:00',
        durationMinutes: 60,
      },
    ]);
    expect(r.consequences.rescheduled).toBe(1);
    const t = after.tasks[0]!;
    expect(t.scheduledDate).toBe('2026-08-13');
    expect(t.startTime).toBe('14:00');
    expect(t.durationMinutes).toBe(60);
  });

  it('在 Google 里删除 block → 任务软删(用户定案:删 block 才传播删除)', () => {
    const snap = snapshot({ contexts: [ctx({ id: 'c1' })], tasks: [pushed()] });
    const { r, after } = run(snap, [
      {
        eventId: 'ev1',
        taskId: null,
        cancelled: true,
        date: null,
        startTime: null,
        durationMinutes: null,
      },
    ]);
    expect(r.consequences.deleted).toBe(1);
    expect(after.tasks[0]!.status).toBe('deleted');
  });

  it('已完成的任务:日历改动不改期、删 block 只清账不复活', () => {
    const done = pushed({ status: 'done', completedAt: '2026-08-12T10:00:00' });
    const snap = snapshot({ contexts: [ctx({ id: 'c1' })], tasks: [done] });
    const moved = run(snap, [
      {
        eventId: 'ev1',
        taskId: null,
        cancelled: false,
        date: '2026-08-20',
        startTime: '08:00',
        durationMinutes: 15,
      },
    ]);
    expect(moved.after.tasks[0]!.scheduledDate).toBe('2026-08-12');
    const removed = run(snap, [
      {
        eventId: 'ev1',
        taskId: null,
        cancelled: true,
        date: null,
        startTime: null,
        durationMinutes: null,
      },
    ]);
    expect(removed.after.tasks[0]!.status).toBe('done');
    expect(removed.after.tasks[0]!.pushedEventId).toBeNull();
  });

  it('本地有未推送的改动 → 本轮拒绝回拉(否则一次推送失败就把改期永久覆盖回去)', () => {
    // 用户把 09:00 改到 14:00 但推送失败:pushedFingerprint 仍是 09:00 那版
    const stale = task({
      id: 'a',
      scheduledDate: '2026-08-12',
      startTime: '09:00',
      durationMinutes: 30,
    });
    const dirty = {
      ...stale,
      startTime: '14:00',
      pushedEventId: 'ev1',
      pushedFingerprint: pushFingerprint(stale),
    };
    const snap = snapshot({ contexts: [ctx({ id: 'c1' })], tasks: [dirty] });
    const { after } = run(snap, [
      {
        eventId: 'ev1',
        taskId: null,
        cancelled: false,
        date: '2026-08-12',
        startTime: '09:00',
        durationMinutes: 30,
      },
    ]);
    expect(after.tasks[0]!.startTime).toBe('14:00'); // 本地优先,没有被回滚
  });

  it('外部镜像任务不受专用日历回同步影响', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({
          id: 'm',
          externalId: 'google:x:y:z',
          scheduledDate: '2026-08-12',
          pushedEventId: 'ev1',
        }),
      ],
    });
    expect(
      run(snap, [
        {
          eventId: 'ev1',
          taskId: null,
          cancelled: true,
          date: null,
          startTime: null,
          durationMinutes: null,
        },
      ]).r.commands,
    ).toHaveLength(0);
  });
});

/** INV-31(D-27/M6d):时区 —— null = 浮动时间(跨时区墙上时间不变)。 */
describe('INV-31 时区', () => {
  it('时区参与推送指纹:只改时区也会重推', () => {
    const t = task({ id: 'a', scheduledDate: '2026-08-12', startTime: '09:00' });
    const pushed = { ...t, pushedEventId: 'ev1', pushedFingerprint: pushFingerprint(t) };
    expect(
      planPush(snapshot({ contexts: [ctx({ id: 'c1' })], tasks: [pushed] })).upsert,
    ).toHaveLength(0);
    const zoned = { ...pushed, timeZone: 'America/New_York' };
    expect(
      planPush(snapshot({ contexts: [ctx({ id: 'c1' })], tasks: [zoned] })).upsert,
    ).toHaveLength(1);
  });

  it('推送计划带上时区(null = 浮动,推送时不指定时区)', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [
        task({ id: 'f', scheduledDate: '2026-08-12', startTime: '09:00' }),
        task({
          id: 'z',
          scheduledDate: '2026-08-12',
          startTime: '10:00',
          timeZone: 'Asia/Shanghai',
        }),
      ],
    });
    const plan = planPush(snap);
    expect(plan.upsert.find((u) => u.taskId === 'f')!.timeZone).toBeNull();
    expect(plan.upsert.find((u) => u.taskId === 'z')!.timeZone).toBe('Asia/Shanghai');
  });

  it('镜像任务的时区同样归外部所有(本地改被拒)', () => {
    const snap = snapshot({
      contexts: [ctx({ id: 'c1' })],
      tasks: [task({ id: 'm', externalId: 'google:x:y:z', startTime: '09:00' })],
    });
    expect(
      'error' in updateTask(snap, deps(), { id: 'm', patch: { timeZone: 'Asia/Tokyo' } }),
    ).toBe(true);
  });

  it('无效时区被拒;null(浮动)合法', () => {
    const snap = snapshot({ contexts: [ctx({ id: 'c1' })], tasks: [task({ id: 'a' })] });
    expect(
      'error' in updateTask(snap, deps(), { id: 'a', patch: { timeZone: 'Mars/Olympus' } }),
    ).toBe(true);
    expect(isUsecaseError(updateTask(snap, deps(), { id: 'a', patch: { timeZone: null } }))).toBe(
      false,
    );
  });
});
