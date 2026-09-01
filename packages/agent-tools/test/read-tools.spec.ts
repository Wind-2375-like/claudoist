import { describe, expect, it } from 'vitest';
import { applyToSnapshot, emptySnapshot, todayList } from '@gtd/domain';
import type { GtdSnapshot, GtdStore, RepeatRule, Task } from '@gtd/domain';
import * as R from '../src/readTools';

/**
 * 只读工具层。domain 规则已在 packages/domain/test 逐条覆盖,这里只测工具层自己的管道 ——
 * 目前是 INV-36.14 的折叠透传:searchAll 把 30 条 done occurrence 折成 1 条代表行后,
 * 若工具层不带上 occurrenceCount,agent 会把"完成过 30 次"答成"完成过 1 次"
 * (对抗审查抓到的信息丢失)。
 */

const RULE: RepeatRule = {
  every: 1,
  unit: 'day',
  from: 'scheduled',
  weekdays: null,
  until: null,
  anchor: '2026-08-01',
};

const base = (over: Partial<Task>): Task => ({
  id: 'x',
  title: 't',
  estimatedMinutes: 15,
  energy: 'medium',
  priority: 3,
  projectId: null,
  deadline: null,
  status: 'active',
  createdAt: '2026-08-01T00:00:00',
  completedAt: null,
  deletedAt: null,
  description: '',
  scheduledDate: null,
  bucket: 'inbox',
  parentTaskId: null,
  sortOrder: 0,
  startTime: null,
  durationMinutes: null,
  externalId: null,
  externalCalendarId: null,
  pushedEventId: null,
  pushedFingerprint: null,
  timeZone: null,
  repeat: null,
  seriesId: null,
  dayOrder: null,
  ...over,
});

function harness(tasks: Task[]): R.ReadToolDeps {
  const snap: GtdSnapshot = { ...emptySnapshot(), tasks };
  const store: GtdStore = {
    snapshot: () => snap,
    apply: (commands) => void applyToSnapshot(snap, commands),
  };
  return { store, clock: { now: () => '2026-08-13T12:00:00', today: () => '2026-08-13' } };
}

describe('search 工具:折叠次数透传(INV-36.14c)', () => {
  it('30 条 done occurrence → 1 条代表行,带 occurrenceCount: 30', () => {
    const rows: Task[] = [];
    for (let i = 1; i <= 30; i += 1) {
      rows.push(
        base({
          id: `d${String(i)}`,
          title: '每日站会',
          status: 'done',
          completedAt: `2026-07-${String(i).padStart(2, '0')}T08:00:00`,
          scheduledDate: `2026-07-${String(i).padStart(2, '0')}`,
          repeat: RULE,
          seriesId: 's1',
        }),
      );
    }
    rows.push(
      base({
        id: 'a1',
        title: '每日站会',
        scheduledDate: '2026-08-14',
        repeat: RULE,
        seriesId: 's1',
      }),
    );
    const r = R.search(harness(rows), '站会');
    if ('error' in r) throw new Error(r.error);
    expect(r.tasks).toHaveLength(2);
    const rep = r.tasks.find((t) => t.status === 'done')!;
    expect(rep.occurrenceCount).toBe(30);
    expect(r.tasks.find((t) => t.status === 'active')!.occurrenceCount).toBeUndefined();
    expect(r.totalMatched).toBe(2);
  });

  it('普通任务无 occurrenceCount(零回归)', () => {
    const r = R.search(harness([base({ id: 'p1', title: '写报告' })]), '报告');
    if ('error' in r) throw new Error(r.error);
    expect(r.tasks[0]!.occurrenceCount).toBeUndefined();
  });
});

describe('list_today 与桌面/CLI 同一口径(INV-20.6 / INV-38)', () => {
  const TODAY = '2026-08-13';

  it('两段序 + dayOrder 都与 domain todayList 逐字一致', () => {
    // 用户在 Today 里把 b 拖到了 a 前面;另有一条 09:00 的定时行和一条未排期的过期截止项。
    const tasks = [
      base({ id: 'a', title: 'a', scheduledDate: TODAY, dayOrder: 1 }),
      base({ id: 'b', title: 'b', scheduledDate: TODAY, dayOrder: 0 }),
      base({ id: 'm', title: '会议', scheduledDate: TODAY, startTime: '09:00' }),
      base({ id: 'd', title: '过期截止', deadline: '2026-08-01' }),
    ];
    const d = harness(tasks);
    const agent = R.listToday(d).tasks.map((t) => t.title);
    const domain = todayList(d.store.snapshot(), TODAY).all.map((t) => t.title);
    expect(agent).toEqual(domain);
    // 具体形状也钉住:拖过的 b 在 a 前,过期截止项在未定时段内,定时行垫底
    expect(agent).toEqual(['b', 'a', '过期截止', '会议']);
  });
});
