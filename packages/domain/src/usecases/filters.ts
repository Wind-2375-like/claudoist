import type { Id } from '../entities/common';
import type { SavedFilter } from '../entities/filter';
import type { GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import { parseFilterQuery } from '../rules/filterQuery';
import type { UsecaseResult } from './types';

/** Filter 域:保存的 filter CRUD;查询语言本身在 `rules/filterQuery.ts`(INV-33)。 */

// ------------------------------------------------------------- 写入侧校验

/** 保存前必须能解析 —— 存一条解析不了的查询,等于把错误推迟到每次打开时才炸。 */
function validateFilterQuery(q: string): string | null {
  const r = parseFilterQuery(q);
  return r.ok ? null : `查询语法错误:${r.error.message}`;
}

// ---------------------------------------------------------------- createFilter

export interface CreateFilterInput {
  name: string;
  query: string;
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
    query: input.query.trim(),
  };
  return { commands: [{ kind: 'createFilter', filter }], consequences: { filterId: filter.id } };
}

// ---------------------------------------------------------------- updateFilter

export interface UpdateFilterInput {
  id: Id;
  patch: { name?: string; query?: string; position?: number };
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
    clean.query = input.patch.query.trim();
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
