import type { Id } from '../entities/common';
import type { Label } from '../entities/label';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import type { UsecaseResult } from './types';

/** Label 域 usecases(§2.9:自由多值标签,不参与不变量计算;操作幂等)。 */

// ----------------------------------------------------------------- createLabel

export interface CreateLabelInput {
  name: string;
  color?: string;
}

export interface CreateLabelConsequences {
  labelId: Id;
  /** false = 同名已存在,幂等返回既有 id */
  created: boolean;
}

export function createLabel(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: CreateLabelInput,
): UsecaseResult<CreateLabelConsequences> {
  const name = input.name.trim();
  if (!name) return { error: '名称不能为空' };
  const existing = snap.labels.find((l) => l.name === name);
  if (existing) {
    return { commands: [], consequences: { labelId: existing.id, created: false } };
  }
  const label: Label = { id: deps.idGen.next(), name, color: input.color ?? null };
  return {
    commands: [{ kind: 'createLabel', label }],
    consequences: { labelId: label.id, created: true },
  };
}

// ----------------------------------------------------------------- deleteLabel

export interface DeleteLabelInput {
  id: Id;
}

export interface DeleteLabelConsequences {
  deleted: boolean;
}

/** 幂等:不存在 → no-op。删除时关联 taskLabels 由 apply 层一并清除。 */
export function deleteLabel(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: DeleteLabelInput,
): UsecaseResult<DeleteLabelConsequences> {
  if (!snap.labels.some((l) => l.id === input.id)) {
    return { commands: [], consequences: { deleted: false } };
  }
  return { commands: [{ kind: 'deleteLabel', id: input.id }], consequences: { deleted: true } };
}

// ----------------------------------------------------------------- assignLabel

export interface AssignLabelInput {
  taskId: Id;
  labelId: Id;
}

export interface AssignLabelConsequences {
  /** false = 已指派,幂等 no-op */
  assigned: boolean;
}

export function assignLabel(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: AssignLabelInput,
): UsecaseResult<AssignLabelConsequences> {
  if (!snap.tasks.some((t) => t.id === input.taskId)) {
    return { error: `行动不存在: ${input.taskId}` };
  }
  if (!snap.labels.some((l) => l.id === input.labelId)) {
    return { error: `label 不存在: ${input.labelId}` };
  }
  const already = snap.taskLabels.some(
    (tl) => tl.taskId === input.taskId && tl.labelId === input.labelId,
  );
  if (already) return { commands: [], consequences: { assigned: false } };
  return {
    commands: [{ kind: 'assignLabel', taskId: input.taskId, labelId: input.labelId }],
    consequences: { assigned: true },
  };
}

// --------------------------------------------------------------- unassignLabel

export interface UnassignLabelInput {
  taskId: Id;
  labelId: Id;
}

export interface UnassignLabelConsequences {
  /** false = 本就未指派,幂等 no-op */
  unassigned: boolean;
}

export function unassignLabel(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: UnassignLabelInput,
): UsecaseResult<UnassignLabelConsequences> {
  const exists = snap.taskLabels.some(
    (tl) => tl.taskId === input.taskId && tl.labelId === input.labelId,
  );
  if (!exists) return { commands: [], consequences: { unassigned: false } };
  return {
    commands: [{ kind: 'unassignLabel', taskId: input.taskId, labelId: input.labelId }],
    consequences: { unassigned: true },
  };
}

// --------------------------------------------------------------- setTaskLabels

export interface SetTaskLabelsInput {
  taskId: Id;
  /** 目标 label 集合;与当前差异 → assign/unassign(详情右栏就地编辑,D-22) */
  labelIds: Id[];
}

export interface SetTaskLabelsConsequences {
  taskId: Id;
}

/** 把任务的 label 集合设为目标集合(diff 式:一批 assign/unassign,一个事务)。 */
export function setTaskLabels(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: SetTaskLabelsInput,
): UsecaseResult<SetTaskLabelsConsequences> {
  if (!snap.tasks.some((t) => t.id === input.taskId)) {
    return { error: `行动不存在: ${input.taskId}` };
  }
  const target = new Set(input.labelIds);
  for (const lid of target) {
    if (!snap.labels.some((l) => l.id === lid)) return { error: `label 不存在: ${lid}` };
  }
  const current = new Set(
    snap.taskLabels.filter((tl) => tl.taskId === input.taskId).map((tl) => tl.labelId),
  );
  const commands: Command[] = [];
  for (const lid of target) {
    if (!current.has(lid))
      commands.push({ kind: 'assignLabel', taskId: input.taskId, labelId: lid });
  }
  for (const lid of current) {
    if (!target.has(lid))
      commands.push({ kind: 'unassignLabel', taskId: input.taskId, labelId: lid });
  }
  return { commands, consequences: { taskId: input.taskId } };
}
