import { describe, expect, it } from 'vitest';
import { hasActiveNextAction } from '../src/index';
import { project, snapshot, task, waitingFor } from './helpers';

describe('INV-05 active next action:task ∨ waiting,直属口径(D-23/M6a:日历项即带时间任务)', () => {
  const p = project({ id: 'p1' });

  it('仅一条带时间的 active 任务(原日历项,D-23)→ true', () => {
    const snap = snapshot({
      projects: [p],
      tasks: [task({ projectId: 'p1', scheduledDate: '2026-08-10', startTime: '09:00' })],
    });
    expect(hasActiveNextAction(snap, 'p1')).toBe(true);
  });

  it('仅一条未解决 WaitingFor → true', () => {
    const snap = snapshot({ projects: [p], waiting: [waitingFor({ projectId: 'p1' })] });
    expect(hasActiveNextAction(snap, 'p1')).toBe(true);
  });

  it('两者皆无(或均已完成/解决)→ false', () => {
    const snap = snapshot({
      projects: [p],
      tasks: [
        task({ projectId: 'p1', status: 'done' }),
        task({ projectId: 'p1', status: 'done', scheduledDate: '2026-08-10', startTime: '09:00' }),
      ],
      waiting: [waitingFor({ projectId: 'p1', resolved: true })],
    });
    expect(hasActiveNextAction(snap, 'p1')).toBe(false);
  });

  it('别的项目有行动而本项目没有 → false(projectId 全等口径)', () => {
    const other = project({ id: 'p2' });
    const snap = snapshot({
      projects: [p, other],
      tasks: [task({ projectId: 'p2' })],
    });
    expect(hasActiveNextAction(snap, 'p1')).toBe(false);
  });

  it('子任务同样携带 projectId,计入(D-21)', () => {
    const root = task({ id: 't1', projectId: 'p1', status: 'done' });
    const sub = task({ projectId: 'p1', parentTaskId: 't1' });
    const snap = snapshot({ projects: [p], tasks: [root, sub] });
    expect(hasActiveNextAction(snap, 'p1')).toBe(true);
  });
});
