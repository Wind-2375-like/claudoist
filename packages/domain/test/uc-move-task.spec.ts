import { describe, expect, it } from 'vitest';
import { applyToSnapshot, engageCandidates, isUsecaseError, moveTask } from '../src/index';
import { deps, project, snapshot, task, TODAY } from './helpers';

/** D-20 容器移动:任务永远在可见容器里,理清 = 挪动。 */
describe('D-20 moveTask:容器移动', () => {
  const base = snapshot({
    projects: [project({ id: 'p1', outcome: '发布', deadline: '2026-09-01' })],
    tasks: [task({ id: 't1', bucket: 'inbox' })],
  });

  it('挪入有 deadline 的项目:bucket/projectId 更新 + INV-10 静默继承', () => {
    const r = moveTask(base, deps(), { id: 't1', to: { bucket: 'project', projectId: 'p1' } });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.inheritedDeadline).toBe('2026-09-01');
    const after = applyToSnapshot(base, r.commands);
    const t = after.tasks[0]!;
    expect(t.bucket).toBe('project');
    expect(t.projectId).toBe('p1');
    expect(t.deadline).toBe('2026-09-01');
  });

  it('已有 deadline 的任务挪入项目 → 不覆盖', () => {
    const withDdl = snapshot({
      ...base,
      tasks: [task({ id: 't1', deadline: '2026-08-20' })],
    });
    const r = moveTask(withDdl, deps(), { id: 't1', to: { bucket: 'project', projectId: 'p1' } });
    if (isUsecaseError(r)) throw new Error(r.error);
    expect(r.consequences.inheritedDeadline).toBeUndefined();
    expect(applyToSnapshot(withDdl, r.commands).tasks[0]!.deadline).toBe('2026-08-20');
  });

  it('项目任务挪回 Inbox:projectId 清空;挪去 Someday 同理', () => {
    const inProject = snapshot({
      ...base,
      tasks: [task({ id: 't1', projectId: 'p1' })],
    });
    const r1 = moveTask(inProject, deps(), { id: 't1', to: { bucket: 'inbox' } });
    if (isUsecaseError(r1)) throw new Error(r1.error);
    const afterInbox = applyToSnapshot(inProject, r1.commands);
    expect(afterInbox.tasks[0]!.bucket).toBe('inbox');
    expect(afterInbox.tasks[0]!.projectId).toBeNull();

    const r2 = moveTask(afterInbox, deps(), { id: 't1', to: { bucket: 'someday' } });
    if (isUsecaseError(r2)) throw new Error(r2.error);
    expect(applyToSnapshot(afterInbox, r2.commands).tasks[0]!.bucket).toBe('someday');
  });

  it('someday/reference 容器的任务不参与 engage(孵化中)', () => {
    const snap = snapshot({
      tasks: [
        task({ id: 'active', bucket: 'inbox' }),
        task({ id: 'incubating', bucket: 'someday' }),
        task({ id: 'ref', bucket: 'reference' }),
      ],
    });
    expect(engageCandidates(snap, null, 60, 'high', TODAY).map((t) => t.id)).toEqual(['active']);
  });

  it('挪入不存在/已完成的项目 → 报错;非 active 任务不可挪', () => {
    const r = moveTask(base, deps(), { id: 't1', to: { bucket: 'project', projectId: 'ghost' } });
    expect(isUsecaseError(r)).toBe(true);
    const done = snapshot({ ...base, tasks: [task({ id: 't1', status: 'done' })] });
    expect(isUsecaseError(moveTask(done, deps(), { id: 't1', to: { bucket: 'inbox' } }))).toBe(
      true,
    );
  });
});
