import { describe, expect, it } from 'vitest';
import { completeTask } from '../src/usecases/tasks';
import { isUsecaseError } from '../src/usecases/types';
import { ctx, deps, project, snapshot, task, waitingFor } from './helpers';

/**
 * INV-14(D-21 修订:后果返回,不弹向导):完成挂在项目下的 Task(含带时间任务,D-23)时
 * consequences 必携带项目状态;项目已 complete 或无项目 → 三字段全部缺席
 * (BUG-02/D-15 防复刻守卫)。系统绝不据此自动完成任何实体(INV-15)。
 */
describe('INV-14 完成后果提示(consequences 漏斗)', () => {
  const base = snapshot({
    contexts: [ctx({ id: 'c1' })],
    projects: [
      project({ id: 'p1', outcome: '发布 v1' }),
      project({ id: 'pc', outcome: '已完项目', status: 'complete' }),
    ],
  });

  it('完成项目最后一个活跃行动 → parentCompletionCandidate=true + 面包屑', () => {
    const snap = { ...base, tasks: [task({ id: 't1', projectId: 'p1' })] };
    const r = completeTask(snap, deps(), { id: 't1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.parentCompletionCandidate).toBe(true);
    expect(r.consequences.projectHasRemainingActivity).toBe(false);
    expect(r.consequences.projectBreadcrumb).toBe('发布 v1');
    // 绝不自动完成项目:命令批只有这一条 updateTask
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]!.kind).toBe('updateTask');
  });

  it('项目还有别的活跃项(带时间任务/waiting 也计入,INV-05)→ remainingActivity=true', () => {
    const snap = {
      ...base,
      tasks: [
        task({ id: 't1', projectId: 'p1' }),
        task({ projectId: 'p1', scheduledDate: '2026-08-10', startTime: '15:00' }),
      ],
    };
    const r = completeTask(snap, deps(), { id: 't1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.projectHasRemainingActivity).toBe(true);
    expect(r.consequences.parentCompletionCandidate).toBe(false);

    const snapW = {
      ...base,
      tasks: [task({ id: 't2', projectId: 'p1' })],
      waiting: [waitingFor({ projectId: 'p1' })],
    };
    const rw = completeTask(snapW, deps(), { id: 't2' });
    if (isUsecaseError(rw)) throw new Error(rw.error);
    expect(rw.consequences.projectHasRemainingActivity).toBe(true);
  });

  it('完成带时间任务(原日历项,D-23)→ 同一后果漏斗(completeTask)', () => {
    const snap = {
      ...base,
      tasks: [task({ id: 'k1', projectId: 'p1', scheduledDate: '2026-08-09', startTime: '15:00' })],
    };
    const r = completeTask(snap, deps(), { id: 'k1' });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.parentCompletionCandidate).toBe(true);
  });

  it('BUG-02 守卫:项目已 complete → 空后果;无项目 → 空后果', () => {
    const snap = {
      ...base,
      tasks: [task({ id: 't1', projectId: 'pc' }), task({ id: 't2', projectId: null })],
    };
    const r1 = completeTask(snap, deps(), { id: 't1' });
    if (isUsecaseError(r1)) throw new Error(r1.error);
    expect(r1.consequences.parentCompletionCandidate).toBeUndefined();
    expect(r1.consequences.projectHasRemainingActivity).toBeUndefined();
    expect(r1.consequences.projectBreadcrumb).toBeUndefined();
    const r2 = completeTask(snap, deps(), { id: 't2' });
    if (isUsecaseError(r2)) throw new Error(r2.error);
    expect(r2.consequences.projectBreadcrumb).toBeUndefined();
  });
});
