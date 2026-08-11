import { describe, expect, it } from 'vitest';
import { ENGAGE_TOP_N, engageCandidates, engageMatches, todaysTimedTasks } from '../src/index';
import { snapshot, task, TODAY } from './helpers';

describe('INV-20 engage 过滤、排序、top-7、calendar-first', () => {
  it('8 条同 context 候选 → 只显示 priority 前 7,稳定排序', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task({ id: `t${i}`, priority: (i % 5) + 1 }));
    const got = engageCandidates(snapshot({ tasks }), null, 60, 'high', TODAY);
    expect(got).toHaveLength(7);
    const priorities = got.map((t) => t.priority);
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities); // 升序(1 = 最高)
    // 稳定排序:同优先级内保持创建序(t0 在 t5 前、t1 在 t6 前)
    const ids = got.map((t) => t.id);
    expect(ids.indexOf('t0')).toBeLessThan(ids.indexOf('t5'));
    expect(ids.indexOf('t1')).toBeLessThan(ids.indexOf('t6'));
    // 被裁掉的是最不重要的那条(D-29 后 5 = 最低)
    expect(ids).not.toContain('t4');
  });

  it('30 分钟可用时 45 分钟任务被过滤;deadline 不影响排序', () => {
    const snap = snapshot({
      tasks: [
        task({ id: 'big', estimatedMinutes: 45, priority: 1 }),
        task({
          id: 'urgent-ddl',
          estimatedMinutes: 10,
          priority: 4,
          deadline: '2026-08-09',
        }),
        task({
          id: 'high-pri',
          estimatedMinutes: 10,
          priority: 2,
          deadline: null,
        }),
      ],
    });
    const got = engageCandidates(snap, null, 30, 'high', TODAY).map((t) => t.id);
    expect(got).toEqual(['high-pri', 'urgent-ddl']); // priority 升序(1 最高);DDL 不参与
  });

  it('energy 过滤方向 + 未带该标签 / 非 active 排除(D-30:按标签而非 context)', () => {
    const snap = snapshot({
      tasks: [
        task({ id: 'ok', energy: 'low' }),
        task({ id: 'tooHard', energy: 'high' }),
        task({ id: 'elsewhere', energy: 'low' }),
        task({ id: 'done', energy: 'low', status: 'done' }),
      ],
      labels: [{ id: 'lc', name: 'computer', color: null }],
      taskLabels: [
        { taskId: 'ok', labelId: 'lc' },
        { taskId: 'tooHard', labelId: 'lc' },
        { taskId: 'done', labelId: 'lc' },
      ],
    });
    // 'elsewhere' 没带该标签 → 不入选
    expect(engageCandidates(snap, 'lc', 60, 'medium', TODAY).map((t) => t.id)).toEqual(['ok']);
  });

  it('engageMatches 不截断,且候选恰为其前 N 条("另有 N 条未列出"的唯一口径)', () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({ id: `t${i}`, priority: (i % 5) + 1 }),
    );
    // 不满足条件的不得计入:超时长 / 超精力 / someday
    tasks.push(
      task({ id: 'long', estimatedMinutes: 999 }),
      task({ id: 'hard', energy: 'high' }),
      task({ id: 'later', bucket: 'someday' }),
    );
    const snap = snapshot({ tasks });
    const matches = engageMatches(snap, null, 60, 'medium', TODAY);
    expect(matches).toHaveLength(10);
    expect(engageCandidates(snap, null, 60, 'medium', TODAY)).toEqual(
      matches.slice(0, ENGAGE_TOP_N),
    );
  });

  it('INV-20.2 今天已排期的任务只出现在 calendar-first,不重复进候选', () => {
    const snap = snapshot({
      tasks: [
        task({ id: 'committed', priority: 1, scheduledDate: TODAY }),
        task({ id: 'yesterday', priority: 2, scheduledDate: '2026-08-07' }),
        task({ id: 'free', priority: 3, scheduledDate: null }),
      ],
    });
    expect(engageCandidates(snap, null, 60, 'high', TODAY).map((t) => t.id)).toEqual([
      'yesterday', // 过期计划已滚入今天,但不属"今天已排期"段,仍可挑
      'free',
    ]);
    expect(todaysTimedTasks(snap, TODAY).map((t) => t.id)).toEqual(['committed']);
  });

  it('calendar-first(D-23/M6a):今天计划任务按 全天在前/startTime 升序;done/别日不入', () => {
    const snap = snapshot({
      tasks: [
        task({ id: 'b', scheduledDate: '2026-08-08', startTime: '15:00' }),
        task({ id: 'allday', scheduledDate: '2026-08-08', startTime: null }),
        task({ id: 'a', scheduledDate: '2026-08-08', startTime: '09:00' }),
        task({ id: 'tomorrow', scheduledDate: '2026-08-09', startTime: null }),
        task({ id: 'doneone', scheduledDate: '2026-08-08', startTime: null, status: 'done' }),
      ],
    });
    expect(todaysTimedTasks(snap, '2026-08-08').map((c) => c.id)).toEqual(['allday', 'a', 'b']);
  });
});
