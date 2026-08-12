import type { Command, GtdSnapshot, GtdStore } from '../ports/gtdStore';
import { applyToSnapshot, emptySnapshot } from '../ports/gtdStore';

/**
 * store-contract 套件(docs/DESIGN.md §2.2):任何 GtdStore 适配器必须全绿。
 * 以纯函数 applyToSnapshot 为参照实现,对全部 Command 种类做结果对拍;
 * 另断言 apply 的事务原子性与 no-op 语义。纯 TS,无测试框架依赖 —— 场景失败
 * 直接 throw,由适配器包的测试框架承接。
 */

export interface StoreContractScenario {
  name: string;
  run(makeStore: () => GtdStore): void;
}

const T0 = '2026-08-08T12:00:00';

function fail(msg: string): never {
  throw new Error(`store-contract: ${msg}`);
}

/** 归一化(排序消除物理顺序差异)后深比较。 */
function normalize(snap: GtdSnapshot): GtdSnapshot {
  const byId = <T extends { id: string }>(arr: T[]): T[] =>
    [...arr].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    inbox: byId(snap.inbox),
    tasks: byId(snap.tasks),
    projects: byId(snap.projects),
    waiting: byId(snap.waiting),
    listItems: byId(snap.listItems),
    labels: byId(snap.labels),
    taskLabels: [...snap.taskLabels].sort((a, b) =>
      `${a.taskId}|${a.labelId}` < `${b.taskId}|${b.labelId}` ? -1 : 1,
    ),
    filters: byId(snap.filters),
    reminders: byId(snap.reminders),
    comments: byId(snap.comments),
  };
}

function expectSnapEqual(actual: GtdSnapshot, expected: GtdSnapshot, label: string): void {
  const a = JSON.stringify(normalize(actual));
  const e = JSON.stringify(normalize(expected));
  if (a !== e) fail(`${label}:快照与参照实现不一致\nactual:   ${a}\nexpected: ${e}`);
}

/** FK 合法的全命令覆盖脚本(分批,先建被引用实体)。 */
function batches(): Command[][] {
  return [
    // 批1:labels + inbox + filters(D-30:contexts 已并入 labels)
    [
      { kind: 'createLabel', label: { id: 'lctx1', name: 'computer', color: null } },
      { kind: 'createLabel', label: { id: 'l1', name: 'next', color: null } },
      { kind: 'createLabel', label: { id: 'l2', name: 'read', color: '#00f' } },
      { kind: 'createInboxItem', item: { id: 'i1', text: '想法A', createdAt: T0, position: 1 } },
      { kind: 'createInboxItem', item: { id: 'i2', text: '想法B', createdAt: T0, position: 2 } },
      {
        kind: 'createFilter',
        filter: { id: 'f1', name: 'low energy', position: 1, query: 'energy: low' },
      },
    ],
    // 批2:项目(平面,D-21)+ 任务(含子任务)+ waiting + lists
    [
      {
        kind: 'createProject',
        project: {
          id: 'p1',
          outcome: '项目一',
          deadline: '2026-09-01',
          status: 'active',
          createdAt: T0,
          completedAt: null,
          deletedAt: null,
        },
      },
      {
        kind: 'createProject',
        project: {
          id: 'p2',
          outcome: '项目二',
          deadline: null,
          status: 'active',
          createdAt: T0,
          completedAt: null,
          deletedAt: null,
        },
      },
      {
        kind: 'createTask',
        task: {
          id: 't1',
          title: '任务一',
          estimatedMinutes: 30,
          energy: 'high',
          priority: 5,
          projectId: 'p2',
          deadline: '2026-09-01',
          status: 'active',
          createdAt: T0,
          completedAt: null,
          deletedAt: null,
          description: '',
          scheduledDate: null,
          bucket: 'project',
          parentTaskId: null,
          sortOrder: 0,
          startTime: null,
          durationMinutes: null,
          externalId: null,
          externalCalendarId: null,
          pushedEventId: null,
          pushedFingerprint: null,
          timeZone: null,
        },
      },
      {
        kind: 'createTask',
        task: {
          id: 't2',
          title: '任务二',
          estimatedMinutes: 5,
          energy: 'low',
          priority: 1,
          projectId: null,
          deadline: null,
          status: 'active',
          createdAt: T0,
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
        },
      },
      {
        kind: 'createTask',
        task: {
          id: 't3',
          title: '子任务(t1 之下,D-21)',
          estimatedMinutes: 15,
          energy: 'medium',
          priority: 3,
          projectId: 'p2',
          deadline: null,
          status: 'active',
          createdAt: T0,
          completedAt: null,
          deletedAt: null,
          description: '',
          scheduledDate: null,
          bucket: 'project',
          parentTaskId: 't1',
          sortOrder: 0,
          startTime: null,
          durationMinutes: null,
          externalId: null,
          externalCalendarId: null,
          pushedEventId: null,
          pushedFingerprint: null,
          timeZone: null,
        },
      },
      {
        kind: 'createWaitingFor',
        item: {
          id: 'w1',
          description: '等回复',
          delegatedTo: '老王',
          projectId: 'p1',
          delegatedAt: T0,
          resolved: false,
          resolvedAt: null,
          sourceTaskJson: null,
        },
      },
      { kind: 'createListItem', item: { id: 's1', kind: 'someday', text: '学琴', createdAt: T0 } },
      {
        kind: 'createReminder',
        reminder: {
          id: 'r1',
          taskId: 't1',
          remindAt: '2026-08-09T09:00',
          dispatched: false,
          createdAt: T0,
        },
      },
      { kind: 'assignLabel', taskId: 't1', labelId: 'l1' },
      { kind: 'assignLabel', taskId: 't1', labelId: 'l2' },
      { kind: 'assignLabel', taskId: 't2', labelId: 'l1' },
      {
        kind: 'createComment',
        comment: { id: 'cm1', taskId: 't1', body: '第一条评论', createdAt: T0 },
      },
      {
        kind: 'createComment',
        comment: { id: 'cm2', taskId: 't1', body: '第二条评论', createdAt: T0 },
      },
    ],
    // 批3:各实体 update + 各类 delete + 幂等/级联
    [
      { kind: 'updateTask', id: 't1', patch: { status: 'done', completedAt: T0, priority: 4 } },
      { kind: 'updateProject', id: 'p2', patch: { status: 'complete', completedAt: T0 } },
      { kind: 'updateWaitingFor', id: 'w1', patch: { resolved: true, resolvedAt: T0 } },
      { kind: 'updateFilter', id: 'f1', patch: { name: '改名', query: 'est: 15' } },
      { kind: 'deleteInboxItem', id: 'i2' },
      { kind: 'deleteListItem', id: 's1' },
      { kind: 'assignLabel', taskId: 't2', labelId: 'l1' }, // 重复指派 → 幂等
      { kind: 'unassignLabel', taskId: 't1', labelId: 'l2' },
      { kind: 'deleteLabel', id: 'l1' }, // 级联清 task_labels
      { kind: 'deleteFilter', id: 'f1' },
      { kind: 'updateReminder', id: 'r1', patch: { dispatched: true } },
      { kind: 'updateTask', id: 't3', patch: { parentTaskId: null } }, // 子任务脱离父(INV-25.4)
      { kind: 'deleteComment', id: 'cm2' },
      {
        kind: 'createReminder',
        reminder: {
          id: 'r2',
          taskId: 't2',
          remindAt: '2026-08-08T14:30',
          dispatched: false,
          createdAt: T0,
        },
      },
      { kind: 'deleteReminder', id: 'r2' },
    ],
  ];
}

export const storeContractScenarios: StoreContractScenario[] = [
  {
    name: '全命令覆盖:逐批 apply 后快照与参照实现一致',
    run(makeStore) {
      const store = makeStore();
      let ref = emptySnapshot();
      for (const [i, batch] of batches().entries()) {
        store.apply(batch, 'user');
        ref = applyToSnapshot(ref, batch);
        expectSnapEqual(store.snapshot(), ref, `批${i + 1}`);
      }
    },
  },
  {
    name: '原子性:批内任一命令失败(主键冲突)→ 整批回滚且抛错',
    run(makeStore) {
      const store = makeStore();
      const [b1] = batches();
      store.apply(b1!, 'user');
      const before = store.snapshot();
      let threw = false;
      try {
        store.apply(
          [
            {
              kind: 'createInboxItem',
              item: { id: 'iX', text: '先成功', createdAt: T0, position: 9 },
            },
            // 主键冲突:i1 已存在
            {
              kind: 'createInboxItem',
              item: { id: 'i1', text: '撞车', createdAt: T0, position: 10 },
            },
          ],
          'user',
        );
      } catch {
        threw = true;
      }
      if (!threw) fail('原子性:期望主键冲突抛错');
      expectSnapEqual(store.snapshot(), before, '原子性回滚');
    },
  },
  {
    name: 'no-op 语义:update/delete 不存在的 id 静默通过(与参照一致)',
    run(makeStore) {
      const store = makeStore();
      const [b1] = batches();
      store.apply(b1!, 'user');
      const before = store.snapshot();
      store.apply(
        [
          { kind: 'updateTask', id: 'ghost', patch: { title: 'x' } },
          { kind: 'deleteInboxItem', id: 'ghost' },
          { kind: 'deleteFilter', id: 'ghost' },
          { kind: 'unassignLabel', taskId: 'ghost', labelId: 'ghost' },
        ],
        'agent',
      );
      expectSnapEqual(store.snapshot(), before, 'no-op');
    },
  },
  {
    name: '空 patch 的 update 是 no-op',
    run(makeStore) {
      const store = makeStore();
      const [b1] = batches();
      store.apply(b1!, 'user');
      const before = store.snapshot();
      store.apply([{ kind: 'updateFilter', id: 'f1', patch: {} }], 'user');
      expectSnapEqual(store.snapshot(), before, '空 patch');
    },
  },
];
