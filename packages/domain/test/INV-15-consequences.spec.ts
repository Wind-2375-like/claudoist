import { describe, expect, it } from 'vitest';
import { completeTask, deleteTask, quickAddTask } from '../src/usecases/tasks';
import { completeProject } from '../src/usecases/projects';
import { activateSomeday } from '../src/usecases/lists';
import { isUsecaseError } from '../src/usecases/types';
import type { UsecaseResult } from '../src/usecases/types';
import type { Command } from '../src/index';
import { applyToSnapshot } from '../src/index';
import { deps, project, snapshot, task, waitingFor } from './helpers';

function ok<C>(r: UsecaseResult<C>): { commands: Command[]; consequences: C } {
  if (isUsecaseError(r)) throw new Error(r.error);
  return r;
}

describe('INV-15 completeTask:绝不自动级联,后果字段逐一断言', () => {
  const base = () => ({
    p1: project({ id: 'p1', outcome: '装修厨房' }),
    t1: task({ id: 't1', projectId: 'p1' }),
  });

  it('只发一条 updateTask;绝不发 updateProject(即使项目已无余活动)', () => {
    const { p1, t1 } = base();
    const snap = snapshot({ projects: [p1], tasks: [t1] });
    const r = ok(completeTask(snap, deps(), { id: 't1' }));
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toEqual({
      kind: 'updateTask',
      id: 't1',
      patch: { status: 'done', completedAt: '2026-08-08T12:00:00' },
    });
    expect(r.commands.some((c) => c.kind === 'updateProject')).toBe(false);
  });

  it('项目还有其他 active Task → projectHasRemainingActivity=true、candidate=false', () => {
    const { p1, t1 } = base();
    const snap = snapshot({ projects: [p1], tasks: [t1, task({ id: 't2', projectId: 'p1' })] });
    const r = ok(completeTask(snap, deps(), { id: 't1' }));
    expect(r.consequences.projectBreadcrumb).toBe('装修厨房');
    expect(r.consequences.projectHasRemainingActivity).toBe(true);
    expect(r.consequences.parentCompletionCandidate).toBe(false);
  });

  it('完成后无余活动 → candidate=true(完成后口径:被完成的行动不再计入)', () => {
    const { p1, t1 } = base();
    const snap = snapshot({ projects: [p1], tasks: [t1] });
    const r = ok(completeTask(snap, deps(), { id: 't1' }));
    expect(r.consequences.projectHasRemainingActivity).toBe(false);
    expect(r.consequences.parentCompletionCandidate).toBe(true);
  });

  it('余活动按 INV-05 口径:带时间的 active 任务(原日历项,D-23)计入', () => {
    const { p1, t1 } = base();
    const snap = snapshot({
      projects: [p1],
      tasks: [t1, task({ projectId: 'p1', scheduledDate: '2026-08-10', startTime: '09:00' })],
    });
    const r = ok(completeTask(snap, deps(), { id: 't1' }));
    expect(r.consequences.projectHasRemainingActivity).toBe(true);
    expect(r.consequences.parentCompletionCandidate).toBe(false);
  });

  it('余活动按 INV-05 口径:未解决 WaitingFor 计入', () => {
    const { p1, t1 } = base();
    const withWaiting = snapshot({
      projects: [p1],
      tasks: [t1],
      waiting: [waitingFor({ projectId: 'p1' })],
    });
    expect(
      ok(completeTask(withWaiting, deps(), { id: 't1' })).consequences.projectHasRemainingActivity,
    ).toBe(true);
  });

  it('BUG-02 守卫:项目已 complete → 项目后果缺席(不追问)', () => {
    const p1 = project({ id: 'p1', status: 'complete' });
    const snap = snapshot({ projects: [p1], tasks: [task({ id: 't1', projectId: 'p1' })] });
    const r = ok(completeTask(snap, deps(), { id: 't1' }));
    expect(r.consequences).toEqual({ completedSubtaskCount: 0 });
  });

  it('无项目行动 → 项目后果缺席', () => {
    const snap = snapshot({ tasks: [task({ id: 't1', projectId: null })] });
    const r = ok(completeTask(snap, deps(), { id: 't1' }));
    expect(r.consequences).toEqual({ completedSubtaskCount: 0 });
  });

  it('面包屑 = 项目名(D-21 平面化)', () => {
    const snap = snapshot({
      projects: [project({ id: 'pb', outcome: 'B' })],
      tasks: [task({ id: 't1', projectId: 'pb' })],
    });
    const r = ok(completeTask(snap, deps(), { id: 't1' }));
    expect(r.consequences.projectBreadcrumb).toBe('B');
  });
});

describe('INV-15 completeProject:不级联、activeTaskCount 供确认', () => {
  it('只发对项目自己的 updateProject;活跃任务数返回供调用方确认,任务状态不动', () => {
    const snap = snapshot({
      projects: [project({ id: 'A', outcome: '年度大计' })],
      tasks: [
        task({ id: 't1', projectId: 'A' }),
        task({ id: 't2', projectId: 'A', status: 'done' }),
      ],
    });
    const r = ok(completeProject(snap, deps(), { id: 'A' }));
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toEqual({
      kind: 'updateProject',
      id: 'A',
      patch: { status: 'complete', completedAt: '2026-08-08T12:00:00' },
    });
    expect(r.consequences.activeTaskCount).toBe(1);
    const after = applyToSnapshot(snap, r.commands);
    expect(after.tasks.find((t) => t.id === 't1')!.status).toBe('active'); // 绝不下行级联
  });

  it('重复完成 → 错误;无任务项目 activeTaskCount=0', () => {
    const snap = snapshot({
      projects: [project({ id: 'A' }), project({ id: 'B', status: 'complete' })],
    });
    expect(ok(completeProject(snap, deps(), { id: 'A' })).consequences.activeTaskCount).toBe(0);
    expect('error' in completeProject(snap, deps(), { id: 'B' })).toBe(true);
  });
});

describe('INV-15 其余后果字段口径', () => {
  it('quickAddTask:项目有 DDL → inheritedDeadline 后果 + 静默复制(INV-10)', () => {
    const snap = snapshot({
      projects: [project({ id: 'p1', deadline: '2026-09-01' })],
    });
    const r = ok(quickAddTask(snap, deps(), { title: '量尺寸', projectId: 'p1' }));
    expect(r.consequences.inheritedDeadline).toBe('2026-09-01');
    const cmd = r.commands[0]!;
    if (cmd.kind !== 'createTask') throw new Error('expected createTask');
    expect(cmd.task.deadline).toBe('2026-09-01');
  });

  it('quickAddTask:已完成项目 → 拒绝(与 moveTask 同口径,不写进不可见容器)', () => {
    const snap = snapshot({
      projects: [project({ id: 'pc', status: 'complete' })],
    });
    expect('error' in quickAddTask(snap, deps(), { title: 'x', projectId: 'pc' })).toBe(true);
  });

  it('deleteTask:deletedSubtaskCount 供确认文案(INV-26)', () => {
    const p1 = project({ id: 'p1' });
    const snap = snapshot({
      projects: [p1],
      tasks: [
        task({ id: 't1', projectId: 'p1' }),
        task({ id: 't2', projectId: 'p1', parentTaskId: 't1' }),
      ],
    });
    expect(ok(deleteTask(snap, deps(), { id: 't1' })).consequences.deletedSubtaskCount).toBe(1);
    expect(ok(deleteTask(snap, deps(), { id: 't2' })).consequences.deletedSubtaskCount).toBe(0);
  });

  it('完成带时间任务(原日历项,D-23/M6a):同一后果口径;不自动改项目', () => {
    const p1 = project({ id: 'p1', outcome: '办签证' });
    const c1 = task({ id: 'c1', projectId: 'p1', scheduledDate: '2026-08-09', startTime: '10:00' });
    const alone = snapshot({ projects: [p1], tasks: [c1] });
    const r1 = ok(completeTask(alone, deps(), { id: 'c1' }));
    expect(r1.consequences.parentCompletionCandidate).toBe(true);
    const busy = snapshot({
      projects: [p1],
      tasks: [c1, task({ projectId: 'p1' })],
    });
    const r2 = ok(completeTask(busy, deps(), { id: 'c1' }));
    expect(r2.consequences.projectHasRemainingActivity).toBe(true);
    expect(r2.consequences.parentCompletionCandidate).toBe(false);
    // 项目已 complete → 空后果(BUG-02 守卫)
    const done = snapshot({
      projects: [project({ id: 'p2', status: 'complete' })],
      tasks: [task({ id: 'c2', projectId: 'p2', scheduledDate: '2026-08-09', startTime: '10:00' })],
    });
    const rd = ok(completeTask(done, deps(), { id: 'c2' }));
    expect(rd.consequences.parentCompletionCandidate).toBeUndefined();
    expect(rd.consequences.projectHasRemainingActivity).toBeUndefined();
    expect(rd.consequences.projectBreadcrumb).toBeUndefined();
  });

  it('activateSomeday:routedToInbox=true、无任何 createTask(INV-21)', () => {
    const snap = snapshot({
      listItems: [{ id: 'li1', kind: 'someday', text: '学钢琴', createdAt: '2026-08-01T00:00:00' }],
      inbox: [],
    });
    const r = ok(activateSomeday(snap, deps(), { id: 'li1' }));
    expect(r.consequences.routedToInbox).toBe(true);
    expect(r.commands.some((c) => c.kind === 'createTask')).toBe(false);
    expect('taskId' in r.consequences).toBe(false);
    const after = applyToSnapshot(snap, r.commands);
    expect(after.listItems).toHaveLength(0);
    expect(after.inbox[0]!.text).toBe('学钢琴');
    expect(after.tasks).toHaveLength(0);
  });
});
