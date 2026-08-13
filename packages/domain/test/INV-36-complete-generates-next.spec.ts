import { describe, expect, it } from 'vitest';
import type { Command, RepeatRule, Task } from '../src/index';
import {
  applyToSnapshot,
  completeTask,
  quickAddTask,
  reopenTask,
  reorderTask,
  updateTask,
} from '../src/index';
import type { deps } from './helpers';
import { fakeClock, label, project, seqIdGen, snapshot, task } from './helpers';

/**
 * INV-36.5–36.11:完成一个循环任务 = 完成这一次 + **同一命令批**生成下一次。
 * 字段口径(36.7)、子树复制(36.8)、四条守卫(36.6 G1–G4)、reopen 征询(36.10)。
 */

const WED_RULE: RepeatRule = {
  every: 1,
  unit: 'week',
  from: 'scheduled',
  weekdays: 8,
  until: null,
  anchor: '2026-08-12',
};

// 2026-08-12 是周三;测试基准 today=2026-08-08
const d = (): ReturnType<typeof deps> => ({ idGen: seqIdGen('new'), clock: fakeClock() });

const series = (over: Partial<Task> = {}): Task =>
  task({
    title: '写周会纪要',
    scheduledDate: '2026-08-12',
    startTime: '19:00',
    durationMinutes: 30,
    priority: 2,
    energy: 'high',
    estimatedMinutes: 45,
    description: '带上周的 action items',
    repeat: WED_RULE,
    seriesId: 'series-1',
    ...over,
  });

const createdTasks = (r: { commands: Command[] }): Task[] =>
  r.commands.filter((c) => c.kind === 'createTask').map((c) => (c as { task: Task }).task);

describe('INV-36.5 完成生成下一次(同一命令批 = 一个事务,INV-17)', () => {
  it('当前置 done + 新行出现在同一 commands 数组;日期按规则推进', () => {
    const t = series();
    const r = completeTask(snapshot({ tasks: [t] }), d(), { id: t.id });
    if ('error' in r) throw new Error(r.error);
    // 同一批:既有 done patch 也有 createTask
    expect(r.commands.some((c) => c.kind === 'updateTask' && c.id === t.id)).toBe(true);
    const [next] = createdTasks(r);
    expect(next).toBeDefined();
    expect(next!.scheduledDate).toBe('2026-08-19');
    expect(r.consequences.nextOccurrence).toMatchObject({
      taskId: next!.id,
      scheduledDate: '2026-08-19',
      copiedSubtaskCount: 0,
    });
  });

  it('INV-36.7 字段口径:系列属性逐字复制;身份字段强制清空;anchor 不变', () => {
    const t = series({ pushedEventId: 'evt-9', pushedFingerprint: 'fp-9', deadline: '2026-08-14' });
    const r = completeTask(snapshot({ tasks: [t] }), d(), { id: t.id });
    if ('error' in r) throw new Error(r.error);
    const [next] = createdTasks(r);
    // 逐字复制
    expect(next).toMatchObject({
      title: '写周会纪要',
      priority: 2,
      energy: 'high',
      estimatedMinutes: 45,
      description: '带上周的 action items',
      startTime: '19:00',
      durationMinutes: 30,
      bucket: 'inbox',
      seriesId: 'series-1',
    });
    // 规则随行前移,anchor 原封不动(INV-36.3:推进引擎永不改锚点)
    expect(next!.repeat).toEqual(WED_RULE);
    // 强制 null:外部身份(INV-29/30 —— 两条任务认领同一 Google 事件会互相覆盖、连带删除)
    expect(next!.externalId).toBeNull();
    expect(next!.pushedEventId).toBeNull();
    expect(next!.pushedFingerprint).toBeNull();
    expect(next!.completedAt).toBeNull();
    expect(next!.deletedAt).toBeNull();
    expect(next!.status).toBe('active');
    // deadline 无项目 → 按与 scheduledDate 相同的天数 delta 平移(8/14 + 7 天)
    expect(next!.deadline).toBe('2026-08-21');
  });

  it('INV-36.7 deadline:项目有 deadline → 走 INV-10 copy-on-create,不平移', () => {
    const p = project({ deadline: '2026-12-31' });
    const t = series({ projectId: p.id, bucket: 'project', deadline: '2026-12-31' });
    const r = completeTask(snapshot({ tasks: [t], projects: [p] }), d(), { id: t.id });
    if ('error' in r) throw new Error(r.error);
    expect(createdTasks(r)[0]!.deadline).toBe('2026-12-31');
  });

  it('INV-36.8 子树复制:结构复制、新 id、全 active、深度不变;done 子任务不带走', () => {
    const t = series();
    const kitchen = task({ title: '厨房', parentTaskId: t.id, scheduledDate: '2026-08-12' });
    const sink = task({ title: '水槽', parentTaskId: kitchen.id });
    const doneOld = task({
      title: '上周已完成',
      parentTaskId: t.id,
      status: 'done',
      completedAt: 'x',
    });
    const r = completeTask(snapshot({ tasks: [t, kitchen, sink, doneOld] }), d(), { id: t.id });
    if ('error' in r) throw new Error(r.error);
    const created = createdTasks(r);
    expect(created).toHaveLength(3); // 根 + 厨房 + 水槽;done 的不复制
    const [root, k2, s2] = created;
    expect(k2!.parentTaskId).toBe(root!.id);
    expect(s2!.parentTaskId).toBe(k2!.id);
    expect(created.every((c) => c.status === 'active')).toBe(true);
    // 子任务日期随系列平移(周内结构前移一周)
    expect(k2!.scheduledDate).toBe('2026-08-19');
    // 子树副本自身不带规则(INV-36.1:循环只挂在根上)
    expect(k2!.repeat).toBeNull();
    expect(k2!.seriesId).toBeNull();
    expect(root!.repeat).toEqual(WED_RULE);
    // INV-26.1 级联完成与复制互不影响
    expect(r.consequences.completedSubtaskCount).toBe(2);
    expect(r.consequences.nextOccurrence!.copiedSubtaskCount).toBe(2);
  });

  it('标签复制(系列属性);提醒平移复制且 dispatched=false;评论不复制', () => {
    const l = label({ name: 'health' });
    const t = series();
    const r = completeTask(
      snapshot({
        tasks: [t],
        labels: [l],
        taskLabels: [{ taskId: t.id, labelId: l.id }],
        reminders: [
          {
            id: 'rm-1',
            taskId: t.id,
            remindAt: '2026-08-12T18:50',
            dispatched: true,
            createdAt: 'x',
          },
        ],
        comments: [{ id: 'cm-1', taskId: t.id, body: '这次遇到投影仪坏了', createdAt: 'x' }],
      }),
      d(),
      { id: t.id },
    );
    if ('error' in r) throw new Error(r.error);
    const next = createdTasks(r)[0]!;
    const assigns = r.commands.filter((c) => c.kind === 'assignLabel');
    expect(assigns).toEqual([{ kind: 'assignLabel', taskId: next.id, labelId: l.id }]);
    const rems = r.commands.filter((c) => c.kind === 'createReminder');
    expect(rems).toHaveLength(1);
    expect(
      (rems[0] as { reminder: { remindAt: string; dispatched: boolean } }).reminder,
    ).toMatchObject({
      remindAt: '2026-08-19T18:50', // 同 delta 平移,时刻不变
      dispatched: false,
    });
    // 评论不复制:命令批里没有任何 comment 相关命令
    expect(r.commands.some((c) => c.kind.toLowerCase().includes('comment'))).toBe(false);
  });

  it('无 repeat 的任务:一条 createTask 都不产生(INV-15 基线)', () => {
    const t = task({ title: '一次性任务', scheduledDate: '2026-08-12' });
    const r = completeTask(snapshot({ tasks: [t] }), d(), { id: t.id });
    if ('error' in r) throw new Error(r.error);
    expect(createdTasks(r)).toHaveLength(0);
    expect(r.consequences.nextOccurrence).toBeUndefined();
  });
});

describe('INV-36.6 四条守卫', () => {
  it('G3:同系列已有其它 active → 不生成、报 nextOccurrenceSkipped(不自动删除)', () => {
    const t = series();
    const other = series({ id: 'other', scheduledDate: '2026-08-19' });
    const r = completeTask(snapshot({ tasks: [t, other] }), d(), { id: t.id });
    if ('error' in r) throw new Error(r.error);
    expect(createdTasks(r)).toHaveLength(0);
    expect(r.consequences.nextOccurrenceSkipped).toBe('series-has-active');
    // 只是"不创建",绝无删除:other 不被动
    expect(r.commands.some((c) => c.kind === 'updateTask' && c.id === 'other')).toBe(false);
  });

  it('G4:越过 Ends 日 → 不生成、报 repeatEnded', () => {
    const t = series({ repeat: { ...WED_RULE, until: '2026-08-12' } });
    const r = completeTask(snapshot({ tasks: [t] }), d(), { id: t.id });
    if ('error' in r) throw new Error(r.error);
    expect(createdTasks(r)).toHaveLength(0);
    expect(r.consequences.repeatEnded).toBe(true);
  });

  it('G1:一次完成恰生成一次(逾期多期也不批量补齐)', () => {
    // 计划 8/1 每天,今天 8/8:漏掉的 7 天绝不伪造,只生成未来第一格 8/9
    const t = series({
      scheduledDate: '2026-08-01',
      repeat: { ...WED_RULE, unit: 'day', weekdays: null, anchor: '2026-08-01' },
    });
    const r = completeTask(snapshot({ tasks: [t] }), d(), { id: t.id });
    if ('error' in r) throw new Error(r.error);
    expect(createdTasks(r)).toHaveLength(1);
    expect(createdTasks(r)[0]!.scheduledDate).toBe('2026-08-09');
  });
});

describe('INV-36.10 reopen 不自动删后继,报出来征询', () => {
  it('重开循环的某一次 → successorTaskId/successorScheduledDate;无删除命令', () => {
    const done = series({ status: 'done', completedAt: 'x' });
    const next = series({ id: 'succ', scheduledDate: '2026-08-19' });
    const r = reopenTask(snapshot({ tasks: [done, next] }), d(), { id: done.id });
    if ('error' in r) throw new Error(r.error);
    expect(r.consequences.successorTaskId).toBe('succ');
    expect(r.consequences.successorScheduledDate).toBe('2026-08-19');
    expect(r.commands).toHaveLength(1); // 只有重开自己那条 patch
  });

  it('reopen 后再完成旧一次:G3 挡住第二条下一次', () => {
    const done = series({ status: 'done', completedAt: 'x' });
    const next = series({ id: 'succ', scheduledDate: '2026-08-19' });
    const snap0 = snapshot({ tasks: [done, next] });
    const r1 = reopenTask(snap0, d(), { id: done.id });
    if ('error' in r1) throw new Error(r1.error);
    const snap1 = applyToSnapshot(snap0, r1.commands);
    const r2 = completeTask(snap1, d(), { id: done.id });
    if ('error' in r2) throw new Error(r2.error);
    expect(createdTasks(r2)).toHaveLength(0);
    expect(r2.consequences.nextOccurrenceSkipped).toBe('series-has-active');
  });
});

describe('INV-36.1/36.2/36.3 写入侧', () => {
  it('quickAdd 带 repeat 无 scheduledDate → 拒绝', () => {
    const r = quickAddTask(snapshot(), d(), { title: 'x', repeat: { unit: 'day' } });
    expect(r).toHaveProperty('error');
  });

  it('quickAdd 带 repeat → 生成 seriesId、anchor=计划日', () => {
    const r = quickAddTask(snapshot(), d(), {
      title: '写周会纪要',
      scheduledDate: '2026-08-12',
      repeat: { unit: 'week', weekdays: ['we'], until: '2026-12-31' },
    });
    if ('error' in r) throw new Error(r.error);
    const t = createdTasks(r)[0]!;
    expect(t.repeat).toEqual({ ...WED_RULE, until: '2026-12-31' });
    expect(t.seriesId).not.toBeNull();
  });

  it('update 设 repeat 于子任务 → 拒绝;于镜像任务 → 拒绝', () => {
    const parent = task({ scheduledDate: '2026-08-12' });
    const sub = task({ parentTaskId: parent.id, scheduledDate: '2026-08-12' });
    const mirror = task({ externalId: 'google:a:b:c', scheduledDate: '2026-08-12' });
    const snap = snapshot({ tasks: [parent, sub, mirror] });
    expect(
      updateTask(snap, d(), { id: sub.id, patch: { repeat: { unit: 'day' } } }),
    ).toHaveProperty('error');
    expect(
      updateTask(snap, d(), { id: mirror.id, patch: { repeat: { unit: 'day' } } }),
    ).toHaveProperty('error');
  });

  it('update 清计划日而循环还在 → 拒绝(不静默丢规则)', () => {
    const t = series();
    const r = updateTask(snapshot({ tasks: [t] }), d(), {
      id: t.id,
      patch: { scheduledDate: null },
    });
    expect(r).toHaveProperty('error');
  });

  it('update repeat:null 关闭循环;seriesId 留着(完成史仍按系列分组,INV-36.9)', () => {
    const t = series();
    const r = updateTask(snapshot({ tasks: [t] }), d(), { id: t.id, patch: { repeat: null } });
    if ('error' in r) throw new Error(r.error);
    const patch = (r.commands[0] as { patch: Partial<Task> }).patch;
    expect(patch.repeat).toBeNull();
    expect('seriesId' in patch).toBe(false);
  });

  it('INV-36.3 手动改计划日 = 重置 anchor(「每周三」被推迟后仍回周三的机制)', () => {
    const t = series();
    const r = updateTask(snapshot({ tasks: [t] }), d(), {
      id: t.id,
      patch: { scheduledDate: '2026-08-13' },
    });
    if ('error' in r) throw new Error(r.error);
    const patch = (r.commands[0] as { patch: Partial<Task> }).patch;
    expect(patch.repeat).toEqual({ ...WED_RULE, anchor: '2026-08-13' });
    // 掩码没动:下一次仍从新锚点找周三
  });

  it('首次给既有任务设 repeat → seriesId 诞生;再次替换规则 → seriesId 不变', () => {
    const t = task({ scheduledDate: '2026-08-12' });
    const snap0 = snapshot({ tasks: [t] });
    const r1 = updateTask(snap0, d(), { id: t.id, patch: { repeat: { unit: 'day' } } });
    if ('error' in r1) throw new Error(r1.error);
    const p1 = (r1.commands[0] as { patch: Partial<Task> }).patch;
    expect(p1.seriesId).toBeDefined();
    const snap1 = applyToSnapshot(snap0, r1.commands);
    const r2 = updateTask(snap1, d(), { id: t.id, patch: { repeat: { unit: 'month' } } });
    if ('error' in r2) throw new Error(r2.error);
    expect('seriesId' in (r2.commands[0] as { patch: Partial<Task> }).patch).toBe(false);
  });

  it('循环任务拖成子任务 → 拒绝(INV-36.1)', () => {
    const a = series();
    const b = task({ title: '别的任务' });
    const r = reorderTask(snapshot({ tasks: [a, b] }), d(), { id: a.id, parentTaskId: b.id });
    expect(r).toHaveProperty('error');
  });
});
