import type { Id, IsoDate } from '../entities/common';
import type { Project } from '../entities/project';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import { isValidIsoDate } from '../rules/dates';
import { tasksWithInheritedDeadline } from '../rules/deadlineInheritance';
import { projectDeletionPreview } from '../rules/projectDeletion';
import type { UsecaseResult } from './types';

/** Project 域 usecases(D-21 平面模型:无父子、无孤儿概念)。 */

// -------------------------------------------------------- createProjectDirect

export interface CreateProjectDirectInput {
  outcome: string;
  deadline?: IsoDate;
}

export interface CreateProjectDirectConsequences {
  projectId: Id;
}

export function createProjectDirect(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: CreateProjectDirectInput,
): UsecaseResult<CreateProjectDirectConsequences> {
  const outcome = input.outcome.trim();
  if (!outcome) return { error: 'outcome 不能为空' };
  if (input.deadline !== undefined && !isValidIsoDate(input.deadline)) {
    return { error: `无效日期 ${input.deadline},格式须为 YYYY-MM-DD` }; // INV-03
  }
  const project: Project = {
    id: deps.idGen.next(),
    outcome,
    deadline: input.deadline ?? null,
    status: 'active',
    createdAt: deps.clock.now(),
    completedAt: null,
    deletedAt: null,
  };
  return {
    commands: [{ kind: 'createProject', project }],
    consequences: { projectId: project.id },
  };
}

// --------------------------------------------------------------- updateProject

/** patch 白名单:status/completedAt 不可经此修改(完成走 completeProject)。 */
export interface UpdateProjectPatch {
  outcome?: string;
  deadline?: IsoDate | null;
}

export interface UpdateProjectInput {
  id: Id;
  patch: UpdateProjectPatch;
  /** INV-12:显式 true 才把新 deadline 传播到"旧值相同"的行动 */
  propagateDeadline?: boolean;
}

export interface UpdateProjectConsequences {
  /** 改 deadline 时必返:deadline 与旧值相同的 active 行动 id(供一次性提示"同步更新 N 个?") */
  tasksWithInheritedDeadline?: Id[];
  /** 本次调用实际发出了行动更新命令 */
  propagated?: boolean;
}

export function updateProject(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: UpdateProjectInput,
): UsecaseResult<UpdateProjectConsequences> {
  const project = snap.projects.find((p) => p.id === input.id);
  if (!project) return { error: `项目不存在: ${input.id}` };
  // 回收站里的项目不能编辑:改了也没人看得见,而 propagateDeadline 还会把新 deadline
  // 传播给它下面的活跃任务 —— 那些任务本该已经被带走了
  if (project.status === 'deleted') {
    return { error: `项目在回收站里,先恢复它再操作: ${input.id}` };
  }
  const p = input.patch;
  const clean: Partial<Omit<Project, 'id'>> = {};
  if (p.outcome !== undefined) {
    const outcome = p.outcome.trim();
    if (!outcome) return { error: 'outcome 不能为空' };
    clean.outcome = outcome;
  }
  if (p.deadline !== undefined) {
    if (p.deadline !== null && !isValidIsoDate(p.deadline)) {
      return { error: `无效日期 ${p.deadline},格式须为 YYYY-MM-DD` }; // INV-03
    }
    clean.deadline = p.deadline;
  }
  const commands: Command[] =
    Object.keys(clean).length > 0 ? [{ kind: 'updateProject', id: project.id, patch: clean }] : [];
  const consequences: UpdateProjectConsequences = {};
  // INV-12:继承是 copy-on-create;deadline 变更时返回"旧值相同"的行动,
  // 显式 propagateDeadline:true 才连带 update 该批行动 —— 绝不静默级联
  if (p.deadline !== undefined && p.deadline !== project.deadline) {
    const taskIds = tasksWithInheritedDeadline(snap, project.id, project.deadline);
    consequences.tasksWithInheritedDeadline = taskIds;
    if (input.propagateDeadline === true && taskIds.length > 0) {
      for (const tid of taskIds) {
        commands.push({ kind: 'updateTask', id: tid, patch: { deadline: p.deadline } });
      }
      consequences.propagated = true;
    }
  }
  return { commands, consequences };
}

// ------------------------------------------------------------- completeProject

export interface CompleteProjectInput {
  id: Id;
}

export interface CompleteProjectConsequences {
  /** 完成时项目仍有 active 行动的数量(>0 时调用方应先向用户确认;INV-15 系统不阻止也不静默改动它们) */
  activeTaskCount: number;
}

export function completeProject(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: CompleteProjectInput,
): UsecaseResult<CompleteProjectConsequences> {
  const project = snap.projects.find((p) => p.id === input.id);
  if (!project) return { error: `项目不存在: ${input.id}` };
  if (project.status === 'complete') return { error: `项目已完成: ${input.id}` };
  // 不挡这一条的话,"完成"一个回收站里的项目会把它复活成 complete,deleted 状态永久丢失
  if (project.status === 'deleted') {
    return { error: `项目在回收站里,先恢复它再操作: ${input.id}` };
  }
  const commands: Command[] = [
    {
      kind: 'updateProject',
      id: project.id,
      patch: { status: 'complete', completedAt: deps.clock.now() },
    },
  ];
  // 不存在任何级联:项目下行动状态一律不动(INV-15)
  const activeTaskCount = snap.tasks.filter(
    (t) => t.projectId === project.id && t.status === 'active',
  ).length;
  return { commands, consequences: { activeTaskCount } };
}

// -------------------------------------------------------------- deleteProject

/**
 * 项目下**活跃**任务的去向。这是两种完全不同的用户意图,所以**没有默认值** ——
 * 调用方必须显式选(INV-15:系统绝不替用户决定跨实体的连锁)。
 */
export type ProjectContentsDisposition =
  /** 项目取消了,里面的事也不做了 → 一并软删 */
  | 'delete'
  /** 项目归类错了,但事还要做 → 退回 Inbox */
  | 'toInbox';

export interface DeleteProjectInput {
  id: Id;
  contents: ProjectContentsDisposition;
}

export interface DeleteProjectConsequences {
  /** contents='delete' 时软删的活跃任务数 */
  deletedTaskCount: number;
  /** contents='toInbox' 时退回 Inbox 的活跃任务数 */
  movedToInboxCount: number;
  /** 保留在项目里、未受影响的已完成任务数(完成记录不该被删除抹掉) */
  keptDoneTaskCount: number;
  /** 退回 Inbox 的任务里有几条是外部日历镜像(INV-29:时间仍归外部) */
  movedMirrorCount: number;
  /** 仍指向本项目的未解决等待项:本次**不动**,须向用户点明(INV-05) */
  unresolvedWaitingCount: number;
}

/**
 * 软删项目(INV-34),与 Task 的软删同规。
 *
 * **为什么不硬删**:① 这个 schema 上没有"只删项目"的硬删 —— 外键开着时
 * `DELETE FROM projects` 会被拒,要硬删就得级联硬删 tasks/waiting_for/comments/labels,
 * 那正是 D-01 明确否决过的"一次确认蒸发整张清单、无 undo";② 已完成任务保留 projectId
 * 是既定设计,硬删会让"这件事当初属于哪个项目"永久消失;③ 误删撤销是软删唯一
 * 不可替代的价值 —— `contents:'delete'` 一次带走整批活跃任务,只有软删能原样拿回来。
 *
 * **活跃任务绝不能留在已删项目里**:留下的话它们照样进 Today、进择事候选、进日历,
 * 而用户以为整个项目都清掉了。所以两个分支都必须把它们**带走**。
 */
export function deleteProject(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: DeleteProjectInput,
): UsecaseResult<DeleteProjectConsequences> {
  const project = snap.projects.find((p) => p.id === input.id);
  if (!project) return { error: `项目不存在: ${input.id}` };
  if (project.status === 'deleted') return { error: `项目已在回收站: ${input.id}` };
  if (input.contents !== 'delete' && input.contents !== 'toInbox') {
    return { error: "必须指定项目内容的去向:'delete'(一并删除)或 'toInbox'(退回 Inbox)" };
  }

  const now = deps.clock.now();
  const pv = projectDeletionPreview(snap, project.id);
  const commands: Command[] = [
    { kind: 'updateProject', id: project.id, patch: { status: 'deleted', deletedAt: now } },
  ];

  const active = snap.tasks.filter((t) => t.projectId === project.id && t.status === 'active');
  for (const t of active) {
    if (input.contents === 'delete') {
      commands.push({
        kind: 'updateTask',
        id: t.id,
        patch: { status: 'deleted', deletedAt: now },
      });
    } else {
      // 退回 Inbox:必须同时清 projectId,否则任务会指着一个已删容器"活着但无处可见"。
      // 父任务若留在项目里(done/deleted),子任务要脱离父,免得挂在看不见的父下面(INV-25.4)。
      const parentGone = t.parentTaskId !== null && !active.some((x) => x.id === t.parentTaskId);
      commands.push({
        kind: 'updateTask',
        id: t.id,
        patch: {
          bucket: 'inbox',
          projectId: null,
          ...(parentGone ? { parentTaskId: null } : {}),
        },
      });
    }
  }

  return {
    commands,
    consequences: {
      deletedTaskCount: input.contents === 'delete' ? active.length : 0,
      movedToInboxCount: input.contents === 'toInbox' ? active.length : 0,
      keptDoneTaskCount: pv.doneTaskCount,
      movedMirrorCount: input.contents === 'toInbox' ? pv.mirrorTaskCount : 0,
      unresolvedWaitingCount: pv.unresolvedWaitingCount,
    },
  };
}

// ------------------------------------------------------------- restoreProject

export interface RestoreProjectInput {
  id: Id;
  /**
   * 显式 true 才连带恢复"随本次删除一起软删"的那批任务。
   * 与 `updateProject.propagateDeadline` 同形:级联要用户点头(INV-12/INV-15)。
   */
  restoreContents?: boolean;
}

export interface RestoreProjectConsequences {
  /** 删除前若已完成,恢复回 'complete'(同 restoreTask 的裁决:不洗掉完成记录) */
  restoredAs: 'active' | 'complete';
  /** 同批被删的任务数(判据:deletedAt 与项目相同) */
  restorableTaskCount: number;
  /** 本次实际恢复的任务数;restoreContents 非 true 时为 0 */
  restoredTaskCount: number;
}

/**
 * 从回收站恢复项目。
 *
 * 同批判据是 `task.deletedAt === project.deletedAt` —— 时间戳没有毫秒,所以理论上会把
 * "同一秒里被单独删掉的同项目任务"一起捞回来。为此加一列 batchId 不值当:最坏后果是
 * 多恢复一条,而用户在确认框里看得到这个数字。
 */
export function restoreProject(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: RestoreProjectInput,
): UsecaseResult<RestoreProjectConsequences> {
  const project = snap.projects.find((p) => p.id === input.id);
  if (!project) return { error: `项目不存在: ${input.id}` };
  if (project.status !== 'deleted') return { error: `项目不在回收站中: ${input.id}` };

  const restoredAs: 'active' | 'complete' = project.completedAt !== null ? 'complete' : 'active';
  const commands: Command[] = [
    {
      kind: 'updateProject',
      id: project.id,
      patch: { status: restoredAs, deletedAt: null },
    },
  ];

  const sameBatch = snap.tasks.filter(
    (t) =>
      t.projectId === project.id && t.status === 'deleted' && t.deletedAt === project.deletedAt,
  );
  if (input.restoreContents === true) {
    for (const t of sameBatch) {
      // 与 restoreTask 同规:删除前已完成的回 done,别洗掉完成记录
      commands.push({
        kind: 'updateTask',
        id: t.id,
        patch:
          t.completedAt !== null
            ? { status: 'done', deletedAt: null }
            : { status: 'active', deletedAt: null, completedAt: null },
      });
    }
  }

  return {
    commands,
    consequences: {
      restoredAs,
      restorableTaskCount: sameBatch.length,
      restoredTaskCount: input.restoreContents === true ? sameBatch.length : 0,
    },
  };
}
