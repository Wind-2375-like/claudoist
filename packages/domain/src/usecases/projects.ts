import type { Id, IsoDate } from '../entities/common';
import type { Project } from '../entities/project';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import { isValidIsoDate } from '../rules/dates';
import { tasksWithInheritedDeadline } from '../rules/deadlineInheritance';
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
