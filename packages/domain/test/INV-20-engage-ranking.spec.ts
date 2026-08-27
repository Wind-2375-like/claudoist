import { describe, expect, it } from 'vitest';
import { engageCandidates, todaysTimedTasks } from '../src/index';
import { snapshot, task } from './helpers';

describe('INV-20 engage 过滤、排序、top-7、calendar-first', () => {
  it('8 条同 context 候选 → 只显示 priority 前 7,稳定排序', () => {
    const tasks = Array.from({ length: 8 }, (_, i) =>
      task({ id: `t${i}`, contextId: 'c1', priority: (i % 5) + 1 }),
    );
    const got = engageCandidates(snapshot({ tasks }), 'c1', 60, 'high');
    expect(got).toHaveLength(7);
    const priorities = got.map((t) => t.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities); // 降序
    // 稳定排序:同为 P1 时先创建的 t0 保留,后创建的 t5 被裁
    expect(got.map((t) => t.id)).toContain('t0');
    expect(got.map((t) => t.id)).not.toContain('t5');
  });

  it('30 分钟可用时 45 分钟任务被过滤;deadline 不影响排序', () => {
    const snap = snapshot({
      tasks: [
        task({ id: 'big', contextId: 'c1', estimatedMinutes: 45, priority: 5 }),
        task({
          id: 'urgent-ddl',
          contextId: 'c1',
          estimatedMinutes: 10,
          priority: 2,
          deadline: '2026-08-09',
        }),
        task({
          id: 'high-pri',
          contextId: 'c1',
          estimatedMinutes: 10,
          priority: 4,
          deadline: null,
        }),
      ],
    });
    const got = engageCandidates(snap, 'c1', 30, 'high').map((t) => t.id);
    expect(got).toEqual(['high-pri', 'urgent-ddl']); // priority 降序;DDL 不参与
  });

  it('energy 过滤方向 + 其他 context / 非 active 排除', () => {
    const snap = snapshot({
      tasks: [
        task({ id: 'ok', contextId: 'c1', energy: 'low' }),
        task({ id: 'tooHard', contextId: 'c1', energy: 'high' }),
        task({ id: 'elsewhere', contextId: 'c2', energy: 'low' }),
        task({ id: 'done', contextId: 'c1', energy: 'low', status: 'done' }),
      ],
    });
    expect(engageCandidates(snap, 'c1', 60, 'medium').map((t) => t.id)).toEqual(['ok']);
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
