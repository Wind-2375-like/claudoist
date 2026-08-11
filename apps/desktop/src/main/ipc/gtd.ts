import { BrowserWindow, ipcMain } from 'electron';
import type { Clock, Command, FlowDeps, GtdSnapshot, GtdStore, Task } from '@gtd/domain';
import {
  addComment,
  addDaysIso,
  calendarDay,
  addContext,
  addReminder,
  addSubtask,
  captureToInbox,
  completeProject,
  completeTask,
  createProjectDirect,
  deleteReminder,
  deleteTask,
  ENGAGE_TOP_N,
  descendantTaskIds,
  engageMatches,
  isTaskListRoot,
  isUsecaseError,
  isValidIsoDate,
  moveTask,
  priorityLabel,
  projectStats,
  quickAddTask,
  reopenTask,
  reorderTask,
  setTaskLabels,
  subtreeHeight,
  taskDepth,
  tasksWithInheritedDeadline,
  todaysTimedTasks,
  updateProject,
  updateTask,
  MAX_SUBTASK_DEPTH,
} from '@gtd/domain';
import type {
  BucketCountsVM,
  ContextVM,
  ProjectListItemVM,
  ProjectViewVM,
  CalendarRangeVM,
  EngageVM,
  TaskDetailVM,
  TaskTreeVM,
  TaskVM,
  TodayVM,
} from '../../shared/viewModels';

/**
 * GTD 读写通道(D-21 平面项目 + 子任务)。handler 每次调用取全量快照 —
 * 个人规模数据下开销可忽略,换取零缓存一致性问题。
 */

export interface GtdViews {
  inbox(): TaskTreeVM[];
  bucketList(kind: 'someday' | 'reference'): TaskTreeVM[];
  bucketCounts(): BucketCountsVM;
  completed(): TaskVM[];
  projectsList(): ProjectListItemVM[];
  projectView(id: string): ProjectViewVM | null;
  taskDetail(id: string): TaskDetailVM | null;
  today(): TodayVM;
  /** 外部日历镜像任务(D-25/INV-29):独立容器,不与 Inbox 混淆 */
  upstream(): TaskTreeVM[];
  /** Focus/Engage(INV-20/M7a) */
  engage(contextId: string, minutes: number, energy: 'low' | 'medium' | 'high'): EngageVM;
  /** 日历区间(D-23/INV-28/M6b):from 起连续 days 天 */
  calendarRange(from: string, days: number): CalendarRangeVM;
  contexts(): ContextVM[];
}

export function createGtdViews(store: GtdStore, clock: Clock): GtdViews {
  const taskVM = (snap: GtdSnapshot, t: Task, today: string): TaskVM => ({
    id: t.id,
    title: t.title,
    description: t.description,
    contextId: t.contextId,
    contextName: snap.contexts.find((c) => c.id === t.contextId)?.name ?? '?',
    estimatedMinutes: t.estimatedMinutes,
    energy: t.energy,
    priority: t.priority,
    priorityLabel: priorityLabel(t.priority),
    deadline: t.deadline,
    overdue: t.deadline !== null && t.deadline < today,
    scheduledDate: t.scheduledDate,
    bucket: t.bucket,
    projectId: t.projectId,
    projectName:
      t.projectId !== null
        ? (snap.projects.find((p) => p.id === t.projectId)?.outcome ?? null)
        : null,
    labels: snap.taskLabels
      .filter((tl) => tl.taskId === t.id)
      .map((tl) => snap.labels.find((l) => l.id === tl.labelId))
      .filter((l) => l !== undefined)
      .map((l) => ({ id: l.id, name: l.name })),
    completedAt: t.completedAt,
    parentTaskId: t.parentTaskId,
    subtaskCount: descendantTaskIds(snap, t.id).filter(
      (id) => snap.tasks.find((x) => x.id === id)?.status === 'active',
    ).length,
    startTime: t.startTime,
    durationMinutes: t.durationMinutes,
    timeZone: t.timeZone,
    externalId: t.externalId,
    externalCalendarId: t.externalCalendarId,
  });

  // 同级组排序(INV-27):sortOrder 升序,createdAt 兜底(反对称:全等返回 0)
  const byCreated = (a: Task, b: Task): number => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return 0;
  };
  /**
   * 列表根 = active 且 isTaskListRoot(无活跃父任务):被 reopen 出来、父已完成/删除的
   * 活跃子任务也在此成行,不悬空(D-22)。
   */
  const roots = (snap: GtdSnapshot): Task[] =>
    snap.tasks.filter((t) => t.status === 'active' && isTaskListRoot(snap, t));

  /**
   * 任务树(M5R5):children = 活跃子任务递归;subtaskDone/subtaskTotal 按直接子任务
   * (非删除)统计,Todoist 式 "done/total" 徽章。done 子任务隐藏但计入分母。
   */
  const treeVM = (snap: GtdSnapshot, t: Task, today: string): TaskTreeVM => {
    const kids = snap.tasks.filter((c) => c.parentTaskId === t.id && c.status !== 'deleted');
    return {
      task: taskVM(snap, t, today),
      children: kids
        .filter((c) => c.status === 'active')
        .sort(byCreated)
        .map((c) => treeVM(snap, c, today)),
      subtaskDone: kids.filter((c) => c.status === 'done').length,
      subtaskTotal: kids.length,
      // 域口径子树高度(计 done 子任务,INV-25):拖拽缩进预算须与 reorderTask 校验一致,
      // 否则 UI 允许的落点会被 domain 拒(done 子任务隐藏但占层级)
      height: subtreeHeight(snap, t.id),
    };
  };

  return {
    inbox() {
      const snap = store.snapshot();
      const today = clock.today();
      return (
        roots(snap)
          // 外部日历镜像不进 Inbox:它们已在日历上被安排好,不是待理清项(D-25/INV-29)
          .filter((t) => t.bucket === 'inbox' && t.externalId === null)
          .sort(byCreated)
          .map((t) => treeVM(snap, t, today))
      );
    },
    bucketList(kind) {
      const snap = store.snapshot();
      const today = clock.today();
      return roots(snap)
        .filter((t) => t.bucket === kind)
        .sort(byCreated)
        .map((t) => treeVM(snap, t, today));
    },
    bucketCounts() {
      const snap = store.snapshot();
      const count = (kind: 'someday' | 'reference'): number =>
        roots(snap).filter((t) => t.bucket === kind && t.externalId === null).length;
      return {
        someday: count('someday'),
        reference: count('reference'),
        upstream: snap.tasks.filter((t) => t.status === 'active' && t.externalId !== null).length,
      };
    },
    completed() {
      const snap = store.snapshot();
      const today = clock.today();
      // 最近完成优先;上限 200(增长归档策略见 ROADMAP)
      return snap.tasks
        .filter((t) => t.status === 'done')
        .sort((a, b) => ((a.completedAt ?? '') > (b.completedAt ?? '') ? -1 : 1))
        .slice(0, 200)
        .map((t) => taskVM(snap, t, today));
    },
    projectsList() {
      const snap = store.snapshot();
      return snap.projects
        .filter((p) => p.status === 'active')
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .map((p) => {
          const stats = projectStats(snap, p.id);
          return {
            id: p.id,
            name: p.outcome,
            deadline: p.deadline,
            activeCount: stats.activeCount,
            doneCount: stats.doneCount,
            progressPct: Math.round(stats.progress * 100),
          };
        });
    },
    projectView(id) {
      const snap = store.snapshot();
      const project = snap.projects.find((p) => p.id === id);
      if (!project) return null;
      const today = clock.today();
      // 列表根 = active list-root(isTaskListRoot:无活跃父;reopen 出来、父 done/deleted 的
      // 活跃子任务在此成行,不悬空)。不再单列 "done 根",否则其活跃子任务会既作嵌套子节点
      // 又作独立根而重复渲染(与 inbox 口径一致)。
      return {
        id: project.id,
        name: project.outcome,
        deadline: project.deadline,
        complete: project.status === 'complete',
        tasks: snap.tasks
          .filter(
            (t) => t.projectId === project.id && t.status === 'active' && isTaskListRoot(snap, t),
          )
          .sort(byCreated)
          .map((t) => treeVM(snap, t, today)),
        doneCount: projectStats(snap, project.id).doneCount,
      };
    },
    taskDetail(id) {
      const snap = store.snapshot();
      const t = snap.tasks.find((x) => x.id === id);
      if (!t) return null;
      const today = clock.today();
      const parent =
        t.parentTaskId !== null ? snap.tasks.find((x) => x.id === t.parentTaskId) : undefined;
      const depth = taskDepth(snap, t.id);
      const locationLabel =
        t.projectId !== null
          ? (snap.projects.find((p) => p.id === t.projectId)?.outcome ?? '?')
          : t.bucket === 'someday'
            ? 'Someday/Maybe'
            : t.bucket === 'reference'
              ? 'Reference'
              : // D-25:镜像任务归 Upstream 容器,不是 Inbox(Inbox 只装未落实的想法)
                t.externalId !== null
                ? 'Upstream'
                : 'Inbox';
      return {
        task: taskVM(snap, t, today),
        locationLabel,
        parentTaskId: t.parentTaskId,
        parentTitle: parent?.title ?? null,
        depth,
        canAddSubtask: depth < MAX_SUBTASK_DEPTH,
        subtasks: snap.tasks
          .filter((c) => c.parentTaskId === t.id && c.status === 'active')
          .sort(byCreated)
          .map((c) => treeVM(snap, c, today)),
        comments: snap.comments
          .filter((c) => c.taskId === t.id)
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
          .map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt })),
        reminders: snap.reminders
          .filter((r) => r.taskId === t.id)
          .sort((a, b) => (a.remindAt < b.remindAt ? -1 : 1))
          .map((r) => ({ id: r.id, remindAt: r.remindAt, dispatched: r.dispatched })),
      };
    },
    upstream() {
      const snap = store.snapshot();
      const today = clock.today();
      // 镜像任务按日程排序(近的在前),与"收件箱按手动序"不同口径
      return snap.tasks
        .filter((t) => t.status === 'active' && t.externalId !== null && isTaskListRoot(snap, t))
        .sort((a, b) => {
          const ad = `${a.scheduledDate ?? ''}${a.startTime ?? ''}`;
          const bd = `${b.scheduledDate ?? ''}${b.startTime ?? ''}`;
          return ad < bd ? -1 : ad > bd ? 1 : 0;
        })
        .map((t) => treeVM(snap, t, today));
    },
    engage(contextId, minutes, energy) {
      const snap = store.snapshot();
      const today = clock.today();
      // 排序/过滤一律走 domain 规则(INV-20),UI 与 CLI 因此天然同口径;
      // matched 取自同一次匹配,避免"未列出 N 条"与候选用两套条件
      const matches = engageMatches(snap, contextId, minutes, energy, today);
      return {
        // INV-20.1 日历优先段是当天硬性日程,与所选 context 无关,故不参与过滤
        calendarFirst: todaysTimedTasks(snap, today).map((t) => taskVM(snap, t, today)),
        candidates: matches.slice(0, ENGAGE_TOP_N).map((t) => taskVM(snap, t, today)),
        topN: ENGAGE_TOP_N,
        matched: matches.length,
      };
    },
    today() {
      const snap = store.snapshot();
      const today = clock.today();
      // 统一列表(D-21/D-23 日历统一):计划 ≤ 今天 ∪ 截止 ≤ 今天;someday/reference 不入
      // (D-20);子任务同样计入。计划项在前 —— 按计划日,再全天在前 / startTime 升序
      // (原 hard-landscape §2.5 排序语义并入,无独立日程段);其余按 deadline。
      const engageable = (t: Task): boolean =>
        t.status === 'active' && t.bucket !== 'someday' && t.bucket !== 'reference';
      const scheduled = snap.tasks
        .filter((t) => engageable(t) && t.scheduledDate !== null && t.scheduledDate <= today)
        .sort((a, b) => {
          if (a.scheduledDate !== b.scheduledDate) {
            return a.scheduledDate! < b.scheduledDate! ? -1 : 1;
          }
          if ((a.startTime === null) !== (b.startTime === null)) {
            return a.startTime === null ? -1 : 1;
          }
          if (a.startTime !== b.startTime)
            return (a.startTime ?? '') < (b.startTime ?? '') ? -1 : 1;
          return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
        });
      const scheduledIds = new Set(scheduled.map((t) => t.id));
      // due 仅收未计划的过期项:计划到未来(scheduledDate>today)= 用户显式推迟,
      // 不再因过期 deadline 留在 Today(否则「推迟到明天」对过期截止项无效);
      // deadline 徽标仍在各视图标红,硬承诺不丢失。(计划≤今天的已在 scheduled 集)
      const due = snap.tasks
        .filter(
          (t) =>
            engageable(t) &&
            t.deadline !== null &&
            t.deadline <= today &&
            t.scheduledDate === null &&
            !scheduledIds.has(t.id),
        )
        .sort((a, b) => (a.deadline! < b.deadline! ? -1 : 1));
      return {
        today,
        tasks: [...scheduled, ...due].map((t) => taskVM(snap, t, today)),
      };
    },
    calendarRange(from, days) {
      const snap = store.snapshot();
      const today = clock.today();
      // 非法起始日回退今天:addDaysIso 对非法串原样返回,否则整周会退化成同一天
      const start = isValidIsoDate(from) ? from : today;
      // 天数钳到 1..31(防御异常入参把整表扫爆);口径全部走 domain calendarDay(INV-28)
      const count = Number.isInteger(days) ? Math.max(1, Math.min(31, days)) : 7;
      const dayVMs = Array.from({ length: count }, (_, i) => {
        const date = addDaysIso(start, i);
        const { allDay, timed } = calendarDay(snap, date);
        return {
          date,
          isToday: date === today,
          allDay: allDay.map((t) => taskVM(snap, t, today)),
          timed: timed.map((t) => taskVM(snap, t, today)),
        };
      });
      return { from: start, to: addDaysIso(start, count - 1), days: dayVMs };
    },
    contexts() {
      const snap = store.snapshot();
      return snap.contexts
        .filter((c) => !c.archived)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => ({
          id: c.id,
          name: c.name,
          activeTaskCount: snap.tasks.filter((t) => t.contextId === c.id && t.status === 'active')
            .length,
        }));
    },
  };
}

export function broadcastChanged(actor: 'user' | 'agent'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('gtd:changed', { entities: ['*'], actor });
    }
  }
}

export function registerGtdIpc(views: GtdViews, store: GtdStore, deps: FlowDeps): void {
  ipcMain.handle('gtd:inbox.list', () => views.inbox());
  ipcMain.handle('gtd:bucket.list', (_e, payload: { kind: 'someday' | 'reference' }) =>
    views.bucketList(payload.kind),
  );
  ipcMain.handle('gtd:bucket.counts', () => views.bucketCounts());
  ipcMain.handle('gtd:completed.list', () => views.completed());
  ipcMain.handle('gtd:projects.list', () => views.projectsList());
  ipcMain.handle('gtd:project.view', (_e, payload: { id: string }) =>
    views.projectView(payload.id),
  );
  ipcMain.handle('gtd:task.detail', (_e, payload: { id: string }) => views.taskDetail(payload.id));
  ipcMain.handle('gtd:today', () => views.today());
  ipcMain.handle('gtd:upstream.list', () => views.upstream());
  ipcMain.handle(
    'gtd:engage',
    (_e, p: { contextId: string; minutes: number; energy: 'low' | 'medium' | 'high' }) =>
      views.engage(p.contextId, p.minutes, p.energy),
  );
  ipcMain.handle('gtd:calendar.range', (_e, payload: { from: string; days: number }) =>
    views.calendarRange(payload.from, payload.days),
  );
  ipcMain.handle('gtd:contexts.list', () => views.contexts());
  // §5.4 单次调用模型:传播征询发生在写调用之前,这里给 UI 只读计数
  ipcMain.handle('gtd:projects.inheritCount', (_e, payload: { id: string }) => {
    const snap = store.snapshot();
    const project = snap.projects.find((p) => p.id === payload.id);
    if (!project) return 0;
    return tasksWithInheritedDeadline(snap, project.id, project.deadline).length;
  });

  // ── 写通道(usecase 是唯一写路径,apply 后广播 gtd:changed)──
  const applyResult = <C>(
    r: { error: string } | { commands: Command[]; consequences: C },
  ): { error: string } | { consequences: C } => {
    if (isUsecaseError(r)) return { error: r.error };
    store.apply(r.commands, 'user');
    broadcastChanged('user');
    return { consequences: r.consequences };
  };

  ipcMain.handle('gtd:capture', (_e, payload: { texts: string[] }) =>
    applyResult(captureToInbox(store.snapshot(), deps, { texts: payload.texts })),
  );
  ipcMain.handle('gtd:tasks.create', (_e, input) =>
    applyResult(quickAddTask(store.snapshot(), deps, input)),
  );
  ipcMain.handle('gtd:tasks.addSubtask', (_e, input) =>
    applyResult(addSubtask(store.snapshot(), deps, input)),
  );
  ipcMain.handle('gtd:comments.add', (_e, input: { taskId: string; body: string }) =>
    applyResult(addComment(store.snapshot(), deps, input)),
  );
  // 详情右栏就地编辑既有任务的 labels / reminders(D-22)
  ipcMain.handle('gtd:tasks.setLabels', (_e, input: { id: string; labelIds: string[] }) =>
    applyResult(
      setTaskLabels(store.snapshot(), deps, { taskId: input.id, labelIds: input.labelIds }),
    ),
  );
  ipcMain.handle('gtd:reminders.add', (_e, input: { taskId: string; remindAt: string }) =>
    applyResult(addReminder(store.snapshot(), deps, input)),
  );
  ipcMain.handle('gtd:reminders.delete', (_e, input: { id: string }) =>
    applyResult(deleteReminder(store.snapshot(), deps, input)),
  );
  ipcMain.handle('gtd:contexts.add', (_e, payload: { name: string }) =>
    applyResult(addContext(store.snapshot(), deps, { name: payload.name })),
  );
  ipcMain.handle('gtd:labels.list', () =>
    store.snapshot().labels.map((l) => ({ id: l.id, name: l.name })),
  );

  // ── 任务操作(D-20/D-21):move / update / complete / delete ──
  ipcMain.handle('gtd:tasks.move', (_e, input) =>
    applyResult(moveTask(store.snapshot(), deps, input)),
  );
  ipcMain.handle(
    'gtd:tasks.reorder',
    (_e, input: { id: string; parentTaskId: string | null; beforeId?: string }) =>
      applyResult(reorderTask(store.snapshot(), deps, input)),
  );
  ipcMain.handle('gtd:tasks.update', (_e, input) =>
    applyResult(updateTask(store.snapshot(), deps, input)),
  );
  ipcMain.handle('gtd:tasks.complete', (_e, input: { id: string }) =>
    applyResult(completeTask(store.snapshot(), deps, input)),
  );
  ipcMain.handle('gtd:tasks.reopen', (_e, input: { id: string }) =>
    applyResult(reopenTask(store.snapshot(), deps, input)),
  );
  ipcMain.handle('gtd:tasks.delete', (_e, input: { id: string }) =>
    applyResult(deleteTask(store.snapshot(), deps, input)),
  );

  // ── 项目操作(D-21 平面)──
  ipcMain.handle('gtd:projects.add', (_e, input: { outcome: string; deadline?: string }) =>
    applyResult(createProjectDirect(store.snapshot(), deps, input)),
  );
  ipcMain.handle('gtd:projects.update', (_e, input) =>
    applyResult(updateProject(store.snapshot(), deps, input)),
  );
  ipcMain.handle('gtd:projects.complete', (_e, input: { id: string }) =>
    applyResult(completeProject(store.snapshot(), deps, input)),
  );
}
