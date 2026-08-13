import { describe, expect, it } from 'vitest';
import { applyToSnapshot, emptySnapshot } from '@gtd/domain';
import type { Clock, Command, GtdSnapshot, GtdStore, IdGen } from '@gtd/domain';
import * as W from '../src/writeTools';
import type { WriteToolDeps } from '../src/writeTools';

/**
 * 写工具层(M9)。这里测的**不是** domain 规则(那些在 packages/domain/test 里已逐条覆盖),
 * 而是工具层自己的三条纪律:
 *
 * 1. 一次 usecase = **一次** `store.apply`(INV-17 的原子性不能被工具层拆散);
 * 2. `changed` 如实反映"到底发没发命令" —— 零命令必须回 false,否则 agent 会说"改好了";
 * 3. consequences 原样透出,不被工具层吞掉(agent 靠它们判断该不该征询用户)。
 */

interface Harness extends WriteToolDeps {
  applies: Command[][];
  changedCalls: number;
  snap: () => GtdSnapshot;
}

function harness(initial: Partial<GtdSnapshot> = {}): Harness {
  let snap: GtdSnapshot = { ...emptySnapshot(), ...initial };
  const applies: Command[][] = [];
  let changedCalls = 0;
  const store: GtdStore = {
    snapshot: () => snap,
    apply: (commands) => {
      applies.push(commands);
      snap = applyToSnapshot(snap, commands);
    },
  };
  let n = 0;
  const idGen: IdGen = { next: () => `id-${++n}` };
  const clock: Clock = { now: () => '2026-08-11T09:00:00', today: () => '2026-08-11' };
  return {
    store,
    deps: { idGen, clock },
    onChanged: () => {
      changedCalls += 1;
    },
    rewindContext: () => null,
    applies,
    get changedCalls() {
      return changedCalls;
    },
    snap: () => snap,
  };
}

describe('M9 写工具:一次 usecase = 一个事务', () => {
  it('完成带子树的任务只发一次 apply,级联数如实返回', () => {
    const h = harness({
      tasks: [
        { ...base(), id: 'p', title: '父' },
        { ...base(), id: 'c1', title: '子1', parentTaskId: 'p' },
        { ...base(), id: 'c2', title: '子2', parentTaskId: 'p' },
      ],
    });
    const r = W.completeTaskTool(h, 'p');
    expect(r.ok).toBe(true);
    expect(r['completedSubtaskCount']).toBe(2);
    // 3 条 updateTask 必须在同一批里 —— 拆开就不再是一个事务
    expect(h.applies).toHaveLength(1);
    expect(h.applies[0]).toHaveLength(3);
    expect(h.changedCalls).toBe(1);
  });

  it('软删同样级联,数量如实返回', () => {
    const h = harness({
      tasks: [
        { ...base(), id: 'p' },
        { ...base(), id: 'c', parentTaskId: 'p' },
      ],
    });
    const r = W.deleteTaskTool(h, 'p');
    expect(r['deletedSubtaskCount']).toBe(1);
    expect(h.applies).toHaveLength(1);
  });
});

describe('M9 写工具:零命令 ≠ 做了事', () => {
  it('同名标签返回 created:false 且 changed:false', () => {
    const h = harness({ labels: [{ id: 'l1', name: 'errands', color: null }] });
    const r = W.createLabelTool(h, 'errands');
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(r['created']).toBe(false);
    expect(h.applies).toHaveLength(0);
    // 什么都没改就不该通知 UI 刷新
    expect(h.changedCalls).toBe(0);
  });

  it('空 patch 直接被工具层挡下(不必打扰 domain)', () => {
    const h = harness({ tasks: [{ ...base(), id: 'a' }] });
    const r = W.updateTaskTool(h, { taskId: 'a' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没给任何要改的字段');
  });
});

describe('M9 写工具:后果原样透出', () => {
  it('挂进有 deadline 的项目 → inheritedDeadline 出现在返回值里(INV-10)', () => {
    const h = harness({
      projects: [
        {
          id: 'p1',
          outcome: '搬家',
          deadline: '2026-09-01',
          status: 'active',
          createdAt: '2026-08-01T00:00:00',
          completedAt: null,
          deletedAt: null,
        },
      ],
    });
    const r = W.createTask(h, { title: '订车', project: '搬家' });
    expect(r.ok).toBe(true);
    expect(r['inheritedDeadline']).toBe('2026-09-01');
  });

  it('移动子任务 → detachedFromParent 出现在返回值里(INV-25.4)', () => {
    const h = harness({
      tasks: [
        { ...base(), id: 'p' },
        { ...base(), id: 'c', parentTaskId: 'p' },
      ],
    });
    const r = W.moveTaskTool(h, { taskId: 'c', to: 'someday' });
    expect(r.ok).toBe(true);
    expect(r['detachedFromParent']).toBe(true);
  });

  it('完成项目 → activeTaskCount 告知留下了几条活', () => {
    const h = harness({
      projects: [
        {
          id: 'p1',
          outcome: '搬家',
          deadline: null,
          status: 'active',
          createdAt: '2026-08-01T00:00:00',
          completedAt: null,
          deletedAt: null,
        },
      ],
      tasks: [{ ...base(), id: 'a', projectId: 'p1', bucket: 'project' }],
    });
    const r = W.completeProjectTool(h, '搬家');
    expect(r['activeTaskCount']).toBe(1);
  });
});

describe('M9 写工具:名字解析', () => {
  it('标签不存在时报错并列出现有标签 —— 绝不顺手新建', () => {
    const h = harness({
      tasks: [{ ...base(), id: 'a' }],
      labels: [{ id: 'l1', name: 'errands', color: null }],
    });
    const r = W.setLabels(h, { taskId: 'a', labels: ['erands'] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('@erands');
    expect(r.error).toContain('@errands');
    expect(h.applies).toHaveLength(0);
  });

  it('标签匹配忽略大小写与前导 @', () => {
    const h = harness({
      tasks: [{ ...base(), id: 'a' }],
      labels: [{ id: 'l1', name: 'Errands', color: null }],
    });
    expect(W.setLabels(h, { taskId: 'a', labels: ['@errands'] }).ok).toBe(true);
  });

  it('项目按名称、id、id 前缀都能找到;歧义时报错而不是猜', () => {
    const proj = (id: string, outcome: string): GtdSnapshot['projects'][number] => ({
      id,
      outcome,
      deadline: null,
      status: 'active',
      createdAt: '2026-08-01T00:00:00',
      completedAt: null,
      deletedAt: null,
    });
    const h = harness({ projects: [proj('aaa-1', '搬家计划'), proj('aaa-2', '搬家预算')] });
    expect(W.createTask(h, { title: 'x', project: '搬家计划' }).ok).toBe(true);
    expect(W.createTask(h, { title: 'x', project: 'aaa-2' }).ok).toBe(true);
    const amb = W.createTask(h, { title: 'x', project: '搬家' });
    expect(amb.ok).toBe(false);
    expect(amb.error).toContain('歧义');
  });

  it('to=project 却没给 project → 明确报错,不静默落进 Inbox', () => {
    const h = harness({ tasks: [{ ...base(), id: 'a' }] });
    const r = W.moveTaskTool(h, { taskId: 'a', to: 'project' });
    expect(r.ok).toBe(false);
    expect(h.applies).toHaveLength(0);
  });
});

function base(): GtdSnapshot['tasks'][number] {
  return {
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
  };
}

describe('INV-35 逆命令日志:必须真的被记下来', () => {
  /**
   * 这一组存在的理由很具体:`rewindContext` 曾经是**可选**字段,而它在主进程的构造点上
   * 被一次静默失败的字符串替换漏掉了 —— 编译通过、agent 照常写数据、回滚日志一行不记,
   * 功能整个是死的却没有任何报错(2026-08-13 从用户库里查出来的)。
   * 字段已改为必填;这里再从行为上钉一遍:给了上下文就**必须**产出 meta。
   */
  const spy = (ctx: WriteToolDeps['rewindContext']): { h: Harness; metas: unknown[] } => {
    const h = harness();
    const metas: unknown[] = [];
    const store: GtdStore = {
      snapshot: h.store.snapshot.bind(h.store),
      apply: (cmds, actor, meta) => {
        metas.push(meta);
        h.store.apply(cmds, actor);
      },
    };
    return { h: { ...h, store, rewindContext: ctx }, metas };
  };

  it('有回合上下文 → apply 带上逆命令批', () => {
    const { h, metas } = spy(() => ({
      conversationId: 'c1',
      turnId: 't1',
      anchorUuid: 'u1',
      toolUseId: null,
    }));
    expect(W.createTask(h, { title: '买牛奶' }).ok).toBe(true);
    expect(metas).toHaveLength(1);
    const log = (metas[0] as { rewindLog?: Record<string, unknown> }).rewindLog!;
    expect(log['conversationId']).toBe('c1');
    expect(log['turnId']).toBe('t1');
    expect(log['toolName']).toBe('create_task');
    // createTask 的逆是硬删 —— 回滚要让这行整个消失
    const batch = log['batch'] as { inverse: { kind: string }[] };
    expect(batch.inverse[0]!.kind).toBe('hardDeleteTask');
  });

  it('没有回合上下文(Google 同步 / CLI / 冒烟)→ 不记日志', () => {
    const { h, metas } = spy(() => null);
    expect(W.createTask(h, { title: 'x' }).ok).toBe(true);
    expect(metas[0]).toBeUndefined();
  });

  it('工具名如实记录 —— 预览界面靠它告诉用户会撤销什么', () => {
    const { h, metas } = spy(() => ({
      conversationId: 'c1',
      turnId: 't1',
      anchorUuid: null,
      toolUseId: null,
    }));
    W.createTask(h, { title: 'a' });
    W.capture(h, ['b']);
    const names = metas.map(
      (m) => ((m as { rewindLog?: { toolName?: string } }).rewindLog ?? {}).toolName,
    );
    expect(names).toEqual(['create_task', 'capture']);
  });
});

describe('D-37/INV-36 循环:工具层管道', () => {
  it('create_task 带 repeat → 真的设上了(白名单守卫);缺计划日 → 报错', () => {
    const h = harness();
    const r = W.createTask(h, {
      title: '写周会纪要',
      scheduledDate: '2026-08-12',
      repeat: { unit: 'week', weekdays: ['we'], until: '2026-12-31' },
    });
    expect(r.ok).toBe(true);
    const t = h.snap().tasks[0]!;
    // 漏了 taskFields 白名单会 ok:true 但 repeat 是 null —— 这条测试就是防那个
    expect(t.repeat).toMatchObject({ unit: 'week', weekdays: 8, until: '2026-12-31' });
    expect(t.seriesId).not.toBeNull();

    const bad = W.createTask(h, { title: 'x', repeat: { unit: 'day' } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('计划日');
  });

  it('update_task repeat:null 穿过 undefined 过滤(三态里的"关闭"不能被当成"省略")', () => {
    const h = harness({
      tasks: [
        {
          ...base(),
          id: 'r1',
          scheduledDate: '2026-08-12',
          repeat: {
            every: 1,
            unit: 'day',
            from: 'scheduled',
            weekdays: null,
            until: null,
            anchor: '2026-08-12',
          },
          seriesId: 's1',
        },
      ],
    });
    const r = W.updateTaskTool(h, { taskId: 'r1', repeat: null });
    expect(r.ok).toBe(true);
    expect(h.snap().tasks[0]!.repeat).toBeNull();
    expect(h.snap().tasks[0]!.seriesId).toBe('s1'); // 系列身份留着(INV-36.9)
  });

  it('add_subtask 带 repeat → 明确拒绝(domain 入参没有该字段,不拒会静默丢)', () => {
    const h = harness({ tasks: [{ ...base(), id: 'p' }] });
    const r = W.addSubtaskTool(h, { parentTaskId: 'p', title: '子', repeat: { unit: 'day' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('子任务');
    expect(h.applies).toHaveLength(0);
  });

  it('complete_task 对循环任务:consequences 带 nextOccurrence 且原样透出', () => {
    const h = harness({
      tasks: [
        {
          ...base(),
          id: 'r1',
          scheduledDate: '2026-08-12',
          repeat: {
            every: 1,
            unit: 'week',
            from: 'scheduled',
            weekdays: 8,
            until: null,
            anchor: '2026-08-12',
          },
          seriesId: 's1',
        },
      ],
    });
    const r = W.completeTaskTool(h, 'r1');
    expect(r.ok).toBe(true);
    expect(h.applies).toHaveLength(1); // 完成 + 生成同一批(INV-17)
    expect(r['nextOccurrence']).toMatchObject({ scheduledDate: '2026-08-19' });
  });
});
