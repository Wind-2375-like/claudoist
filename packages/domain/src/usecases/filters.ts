import type { Id } from '../entities/common';
import type { FilterQuery, SavedFilter } from '../entities/filter';
import type { Task } from '../entities/task';
import type { GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import { isValidIsoDate } from '../rules/dates';
import { energyRank } from '../rules/energy';
import type { UsecaseResult } from './types';

/** Filter 域:查询解释器 + 保存的 filter CRUD(§2.9.3:比较语义复用 INV-01/INV-02)。 */

// ------------------------------------------------------------------ evalFilter

/**
 * FilterQuery 解释器(纯读,作用于 active Task):
 * - energyMax:energyRank(task) ≤ energyRank(max)(INV-02 序;未知值按 medium)
 * - priorityMin:task.priority ≥ min(INV-01:数值大 = 更高,不重编号)
 * - dueOnOrBefore:有 deadline 且字典序 ≤(INV-03;无 deadline 不命中)
 * - textQuery:title 大小写不敏感包含
 * - labelIds:**全含**(每个给定 label 都已指派)
 */
export function evalFilter(snap: GtdSnapshot, query: FilterQuery): Task[] {
  const text = query.textQuery?.trim().toLowerCase() ?? '';
  return snap.tasks.filter((t) => {
    if (t.status !== 'active') return false;
    if (query.contextId !== undefined && t.contextId !== query.contextId) return false;
    if (query.labelIds !== undefined && query.labelIds.length > 0) {
      const all = query.labelIds.every((lid) =>
        snap.taskLabels.some((tl) => tl.taskId === t.id && tl.labelId === lid),
      );
      if (!all) return false;
    }
    if (query.energyMax !== undefined && energyRank(t.energy) > energyRank(query.energyMax)) {
      return false;
    }
    if (query.maxMinutes !== undefined && t.estimatedMinutes > query.maxMinutes) return false;
    if (query.priorityMin !== undefined && t.priority < query.priorityMin) return false;
    if (query.dueOnOrBefore !== undefined) {
      if (t.deadline === null || t.deadline > query.dueOnOrBefore) return false;
    }
    if (query.noProject === true && t.projectId !== null) return false;
    if (text !== '' && !t.title.toLowerCase().includes(text)) return false;
    return true;
  });
}

/** 写入侧校验(INV-03 + INV-01/02 值域);读取路径(evalFilter)对存量宽容。 */
function validateFilterQuery(q: FilterQuery): string | null {
  if (q.dueOnOrBefore !== undefined && !isValidIsoDate(q.dueOnOrBefore)) {
    return `无效日期 ${q.dueOnOrBefore},格式须为 YYYY-MM-DD`;
  }
  if (q.energyMax !== undefined && !['low', 'medium', 'high'].includes(q.energyMax)) {
    return `无效 energyMax: ${q.energyMax}`;
  }
  if (
    q.priorityMin !== undefined &&
    (!Number.isInteger(q.priorityMin) || q.priorityMin < 1 || q.priorityMin > 5)
  ) {
    return `无效 priorityMin: ${q.priorityMin}(须为 1–5 整数)`;
  }
  if (q.maxMinutes !== undefined && (!Number.isInteger(q.maxMinutes) || q.maxMinutes < 1)) {
    return `无效 maxMinutes: ${q.maxMinutes}(须为 ≥1 整数)`;
  }
  return null;
}

// ---------------------------------------------------------------- createFilter

export interface CreateFilterInput {
  name: string;
  query: FilterQuery;
}

export interface CreateFilterConsequences {
  filterId: Id;
}

export function createFilter(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: CreateFilterInput,
): UsecaseResult<CreateFilterConsequences> {
  const name = input.name.trim();
  if (!name) return { error: '名称不能为空' };
  const invalid = validateFilterQuery(input.query);
  if (invalid !== null) return { error: invalid };
  const maxPos = snap.filters.reduce((m, f) => Math.max(m, f.position), -1);
  const filter: SavedFilter = {
    id: deps.idGen.next(),
    name,
    position: maxPos + 1,
    query: { ...input.query },
  };
  return { commands: [{ kind: 'createFilter', filter }], consequences: { filterId: filter.id } };
}

// ---------------------------------------------------------------- updateFilter

export interface UpdateFilterInput {
  id: Id;
  patch: { name?: string; query?: FilterQuery; position?: number };
}

export interface UpdateFilterConsequences {
  filterId: Id;
}

export function updateFilter(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: UpdateFilterInput,
): UsecaseResult<UpdateFilterConsequences> {
  const filter = snap.filters.find((f) => f.id === input.id);
  if (!filter) return { error: `filter 不存在: ${input.id}` };
  const clean: Partial<Omit<SavedFilter, 'id'>> = {};
  if (input.patch.name !== undefined) {
    const name = input.patch.name.trim();
    if (!name) return { error: '名称不能为空' };
    clean.name = name;
  }
  if (input.patch.query !== undefined) {
    const invalid = validateFilterQuery(input.patch.query);
    if (invalid !== null) return { error: invalid };
    clean.query = { ...input.patch.query };
  }
  if (input.patch.position !== undefined) clean.position = input.patch.position;
  return {
    commands:
      Object.keys(clean).length > 0 ? [{ kind: 'updateFilter', id: filter.id, patch: clean }] : [],
    consequences: { filterId: filter.id },
  };
}

// ---------------------------------------------------------------- deleteFilter

export interface DeleteFilterInput {
  id: Id;
}

export interface DeleteFilterConsequences {
  deleted: boolean;
}

/** 幂等:不存在 → no-op。 */
export function deleteFilter(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: DeleteFilterInput,
): UsecaseResult<DeleteFilterConsequences> {
  if (!snap.filters.some((f) => f.id === input.id)) {
    return { commands: [], consequences: { deleted: false } };
  }
  return { commands: [{ kind: 'deleteFilter', id: input.id }], consequences: { deleted: true } };
}
