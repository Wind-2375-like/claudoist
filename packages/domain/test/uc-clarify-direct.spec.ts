import { describe, expect, it } from 'vitest';
import {
  applyToSnapshot,
  clarifyInboxToList,
  clarifyInboxToProject,
  clarifyInboxToTask,
  isUsecaseError,
} from '../src/index';
import { ctx, deps, inboxItem, label, project, snapshot } from './helpers';

/** D-18 理清路径①:卡片直接 specify;单条目一次事务(INV-17)。 */
describe('clarifyDirect:inbox 条目直接转化', () => {
  const base = snapshot({
    contexts: [ctx({ id: 'c1', name: '@computer' })],
    labels: [label({ id: 'l1', name: 'next' })],
    projects: [project({ id: 'p1', deadline: '2026-09-01' })],
    inbox: [inboxItem({ id: 'i1', text: '给论文加 ablation', position: 1 })],
  });

  it('转 Task:createTask(+labels+reminder)与 deleteInboxItem 同一事务;INV-10 继承生效', () => {
    const r = clarifyInboxToTask(base, deps(), {
      inboxItemId: 'i1',
      task: {
        title: '跑 ablation 实验',
        contextId: 'c1',
        projectId: 'p1',
        scheduledDate: '2026-08-09',
        labelIds: ['l1'],
        reminderAt: '2026-08-09T09:00',
        description: '对照三组设置',
      },
    });
    expect(isUsecaseError(r)).toBe(false);
    if (isUsecaseError(r)) return;
    const kinds = r.commands.map((c) => c.kind);
    expect(kinds).toEqual(['createTask', 'assignLabel', 'createReminder', 'deleteInboxItem']);
    expect(r.consequences.inheritedDeadline).toBe('2026-09-01'); // INV-10 无条件继承
    const after = applyToSnapshot(base, r.commands);
    expect(after.inbox).toHaveLength(0);
    const t = after.tasks[0]!;
    expect(t.scheduledDate).toBe('2026-08-09');
    expect(t.description).toBe('对照三组设置');
    expect(t.deadline).toBe('2026-09-01');
    expect(after.reminders[0]!.taskId).toBe(t.id);
    expect(after.reminders[0]!.dispatched).toBe(false);
  });

  it('转 Project:createProject + deleteInboxItem(D-21 平面,无孤儿概念)', () => {
    const r = clarifyInboxToProject(base, deps(), {
      inboxItemId: 'i1',
      project: { outcome: '完成论文修改', deadline: '2026-10-01' },
    });
    expect(isUsecaseError(r)).toBe(false);
    if (isUsecaseError(r)) return;
    expect(r.commands.map((c) => c.kind)).toEqual(['createProject', 'deleteInboxItem']);
    expect(r.consequences.projectId).toBeTruthy();
    const after = applyToSnapshot(base, r.commands);
    expect(after.inbox).toHaveLength(0);
    expect(after.projects.find((p) => p.outcome === '完成论文修改')).toBeTruthy();
  });

  it('归档三列表:原文逐字入 ListItem + 条目移除', () => {
    const r = clarifyInboxToList(base, deps(), { inboxItemId: 'i1', kind: 'someday' });
    expect(isUsecaseError(r)).toBe(false);
    if (isUsecaseError(r)) return;
    const after = applyToSnapshot(base, r.commands);
    expect(after.listItems[0]!.text).toBe('给论文加 ablation');
    expect(after.listItems[0]!.kind).toBe('someday');
    expect(after.inbox).toHaveLength(0);
  });

  it('子操作失败(坏日期/幽灵条目)→ 返回错误、零命令', () => {
    const bad = clarifyInboxToTask(base, deps(), {
      inboxItemId: 'i1',
      task: { title: 'x', contextId: 'c1', scheduledDate: '2026-8-9' },
    });
    expect(isUsecaseError(bad)).toBe(true);
    const ghost = clarifyInboxToList(base, deps(), { inboxItemId: 'ghost', kind: 'trash' });
    expect(isUsecaseError(ghost)).toBe(true);
  });
});
