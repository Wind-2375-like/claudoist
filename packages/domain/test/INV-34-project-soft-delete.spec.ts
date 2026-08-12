import { describe, expect, it } from 'vitest';
import {
  applyToSnapshot,
  completeProject,
  completionFollowUpConsequences,
  createWaitingForDirect,
  deleteProject,
  isUsecaseError,
  projectDeletionPreview,
  reopenTask,
  restoreProject,
  restoreTask,
  searchAll,
  updateProject,
} from '../src/index';
import type { Command, GtdSnapshot } from '../src/index';
import { deps, project, snapshot, task, waitingFor } from './helpers';

/**
 * INV-34 项目软删除。
 *
 * 这条不变量的核心不是"能删",而是**删完之后不能留下任何活着却看不见的东西**:
 * 项目一旦进回收站,它下面的活跃任务就必须被带走 —— 留在原地的话,它们在任何容器视图里
 * 都不显示,却照样进 Today、进择事候选、进日历。用户以为整个项目都清掉了,它们还在后台
 * 挤他的注意力。
 */

const ok = <C>(r: ReturnType<typeof deleteProject> | { commands: Command[]; consequences: C }) => {
  if (isUsecaseError(r as never)) throw new Error((r as unknown as { error: string }).error);
  return r as { commands: Command[]; consequences: C };
};

const withProject = (over: Partial<GtdSnapshot> = {}): GtdSnapshot =>
  snapshot({ projects: [project({ id: 'p1', outcome: '搬家' })], ...over });

describe('INV-34 删除:项目进回收站,活跃任务必须有去向', () => {
  const base = (): GtdSnapshot =>
    withProject({
      tasks: [
        task({ id: 'a', projectId: 'p1', bucket: 'project' }),
        task({ id: 'b', projectId: 'p1', bucket: 'project', parentTaskId: 'a' }),
        task({ id: 'done', projectId: 'p1', bucket: 'project', status: 'done', completedAt: 'x' }),
      ],
    });

  it("contents='delete':项目与活跃任务一起进回收站,已完成的留档", () => {
    const snap = base();
    const r = ok(deleteProject(snap, deps(), { id: 'p1', contents: 'delete' }));
    expect(r.consequences.deletedTaskCount).toBe(2);
    expect(r.consequences.keptDoneTaskCount).toBe(1);
    const after = applyToSnapshot(snap, r.commands);
    expect(after.projects[0]!.status).toBe('deleted');
    expect(after.projects[0]!.deletedAt).not.toBeNull();
    expect(after.tasks.filter((t) => t.status === 'deleted').map((t) => t.id)).toEqual(['a', 'b']);
    // 完成记录不该被删除抹掉(与 INV-26.2 同源裁决)
    expect(after.tasks.find((t) => t.id === 'done')!.status).toBe('done');
    expect(after.tasks.find((t) => t.id === 'done')!.projectId).toBe('p1');
  });

  it("contents='toInbox':活跃任务退回 Inbox 并**清掉 projectId**", () => {
    const snap = base();
    const r = ok(deleteProject(snap, deps(), { id: 'p1', contents: 'toInbox' }));
    expect(r.consequences.movedToInboxCount).toBe(2);
    const after = applyToSnapshot(snap, r.commands);
    for (const id of ['a', 'b']) {
      const t = after.tasks.find((x) => x.id === id)!;
      expect(t.status).toBe('active');
      expect(t.bucket).toBe('inbox');
      // 不清 projectId 的话,任务会指着一个已删容器"活着但无处可见"
      expect(t.projectId).toBeNull();
    }
  });

  it('删完之后,项目里不留任何活跃任务(两个分支都是)', () => {
    for (const contents of ['delete', 'toInbox'] as const) {
      const snap = base();
      const after = applyToSnapshot(
        snap,
        ok(deleteProject(snap, deps(), { id: 'p1', contents })).commands,
      );
      const stranded = after.tasks.filter((t) => t.projectId === 'p1' && t.status === 'active');
      expect(stranded).toEqual([]);
    }
  });

  it('contents 必填 —— 没给合法去向一律拒绝(INV-15:不替用户决定)', () => {
    const r = deleteProject(base(), deps(), { id: 'p1' } as never);
    expect(isUsecaseError(r)).toBe(true);
  });

  it('未解决的等待项不动,但必须在 consequences 里点明(INV-05)', () => {
    const snap = withProject({
      waiting: [waitingFor({ id: 'w1', projectId: 'p1', resolved: false })],
    });
    const r = ok(deleteProject(snap, deps(), { id: 'p1', contents: 'delete' }));
    expect(r.consequences.unresolvedWaitingCount).toBe(1);
    expect(applyToSnapshot(snap, r.commands).waiting[0]!.resolved).toBe(false);
  });

  it('重复删除被拒', () => {
    const snap = withProject();
    const after = applyToSnapshot(
      snap,
      ok(deleteProject(snap, deps(), { id: 'p1', contents: 'delete' })).commands,
    );
    expect(isUsecaseError(deleteProject(after, deps(), { id: 'p1', contents: 'delete' }))).toBe(
      true,
    );
  });

  it('预检口径与 consequences 同源(确认框与结果不能对不上)', () => {
    const snap = base();
    const pv = projectDeletionPreview(snap, 'p1');
    const r = ok(deleteProject(snap, deps(), { id: 'p1', contents: 'delete' }));
    expect(pv.activeTaskCount).toBe(r.consequences.deletedTaskCount);
    expect(pv.doneTaskCount).toBe(r.consequences.keptDoneTaskCount);
  });
});

describe('INV-34 恢复', () => {
  const deleted = (): GtdSnapshot => {
    const snap = withProject({
      tasks: [
        task({ id: 'a', projectId: 'p1', bucket: 'project' }),
        task({
          id: 'old',
          projectId: 'p1',
          bucket: 'project',
          status: 'deleted',
          deletedAt: '2020-01-01T00:00:00',
        }),
      ],
    });
    return applyToSnapshot(
      snap,
      ok(deleteProject(snap, deps(), { id: 'p1', contents: 'delete' })).commands,
    );
  };

  it('默认只恢复项目自己,不连带任务(级联要用户点头)', () => {
    const snap = deleted();
    const r = ok(restoreProject(snap, deps(), { id: 'p1' }));
    expect(r.consequences.restoredTaskCount).toBe(0);
    expect(r.consequences.restorableTaskCount).toBe(1);
    const after = applyToSnapshot(snap, r.commands);
    expect(after.projects[0]!.status).toBe('active');
    expect(after.tasks.find((t) => t.id === 'a')!.status).toBe('deleted');
  });

  it('restoreContents=true 只捞回**同批**删的,不碰更早删掉的', () => {
    const snap = deleted();
    const after = applyToSnapshot(
      snap,
      ok(restoreProject(snap, deps(), { id: 'p1', restoreContents: true })).commands,
    );
    expect(after.tasks.find((t) => t.id === 'a')!.status).toBe('active');
    // 'old' 是删项目之前就单独删掉的,不该被顺手捞回来
    expect(after.tasks.find((t) => t.id === 'old')!.status).toBe('deleted');
  });

  it('删除前已完成的项目恢复回 complete,不洗掉完成记录', () => {
    const snap = snapshot({
      projects: [project({ id: 'p1', status: 'complete', completedAt: '2026-01-01T00:00:00' })],
    });
    const del = applyToSnapshot(
      snap,
      ok(deleteProject(snap, deps(), { id: 'p1', contents: 'delete' })).commands,
    );
    const r = ok(restoreProject(del, deps(), { id: 'p1' }));
    expect(r.consequences.restoredAs).toBe('complete');
    expect(applyToSnapshot(del, r.commands).projects[0]!.status).toBe('complete');
  });

  it('没删过的项目不能恢复', () => {
    expect(isUsecaseError(restoreProject(withProject(), deps(), { id: 'p1' }))).toBe(true);
  });
});

describe('INV-34 守卫:回收站里的项目不能被当成活项目', () => {
  const deletedSnap = (): GtdSnapshot => {
    const snap = withProject();
    return applyToSnapshot(
      snap,
      ok(deleteProject(snap, deps(), { id: 'p1', contents: 'delete' })).commands,
    );
  };

  it('不能"完成"一个回收站里的项目(否则会把它复活成 complete,deleted 永久丢失)', () => {
    expect(isUsecaseError(completeProject(deletedSnap(), deps(), { id: 'p1' }))).toBe(true);
  });

  it('不能编辑回收站里的项目(propagateDeadline 会传播给本该被带走的任务)', () => {
    const r = updateProject(deletedSnap(), deps(), { id: 'p1', patch: { outcome: '改名' } });
    expect(isUsecaseError(r)).toBe(true);
  });

  it('不能往回收站里的项目挂等待项', () => {
    const r = createWaitingForDirect(deletedSnap(), deps(), { description: 'x', projectId: 'p1' });
    expect(isUsecaseError(r)).toBe(true);
  });

  it('完成追问不再指向已删项目(守卫是 !== active,不是 === complete)', () => {
    const snap = deletedSnap();
    const c = completionFollowUpConsequences(snap, 'p1');
    expect(c.projectBreadcrumb).toBeUndefined();
    expect(c.parentCompletionCandidate).toBeUndefined();
  });

  it('重开 / 恢复任务时,项目已删则落回 Inbox —— 不造出不可见却仍参与排程的任务', () => {
    const snap = withProject({
      tasks: [
        task({ id: 'd', projectId: 'p1', bucket: 'project', status: 'done', completedAt: 'x' }),
      ],
    });
    const del = applyToSnapshot(
      snap,
      ok(deleteProject(snap, deps(), { id: 'p1', contents: 'delete' })).commands,
    );
    const after = applyToSnapshot(del, ok(reopenTask(del, deps(), { id: 'd' })).commands);
    const t = after.tasks.find((x) => x.id === 'd')!;
    expect(t.status).toBe('active');
    expect(t.bucket).toBe('inbox');
    expect(t.projectId).toBeNull();
  });

  it('restoreTask 同规', () => {
    const snap = withProject({
      tasks: [
        task({
          id: 'x',
          projectId: 'p1',
          bucket: 'project',
          status: 'deleted',
          deletedAt: '2020-01-01T00:00:00',
        }),
      ],
    });
    const del = applyToSnapshot(
      snap,
      ok(deleteProject(snap, deps(), { id: 'p1', contents: 'toInbox' })).commands,
    );
    const after = applyToSnapshot(del, ok(restoreTask(del, deps(), { id: 'x' })).commands);
    expect(after.tasks[0]!.bucket).toBe('inbox');
    expect(after.tasks[0]!.projectId).toBeNull();
  });
});

describe('INV-34 搜索:已删项目仍可搜到,但排在最后', () => {
  it('搜得到 —— 否则软删对用户就是不可见的硬删(恢复入口正是从这里进)', () => {
    const snap = snapshot({
      projects: [
        project({ id: 'p1', outcome: '搬家' }),
        project({ id: 'p2', outcome: '搬家预算' }),
      ],
    });
    const del = applyToSnapshot(
      snap,
      ok(deleteProject(snap, deps(), { id: 'p1', contents: 'delete' })).commands,
    );
    const r = searchAll(del, deps(), { query: '搬家' });
    if (isUsecaseError(r)) throw new Error(r.error);
    const ids = r.consequences.projects.map((p) => p.id);
    expect(ids).toContain('p1');
    // 活的排前面
    expect(ids.indexOf('p2')).toBeLessThan(ids.indexOf('p1'));
  });
});
