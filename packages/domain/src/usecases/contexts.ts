import type { Id } from '../entities/common';
import type { Context } from '../entities/context';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import type { UsecaseResult } from './types';

/** Context 域 usecases(INV-24;"删除" = archive,DESIGN §5.3)。 */

// ------------------------------------------------------------------ addContext

export interface AddContextInput {
  name: string;
}

export interface AddContextConsequences {
  contextId: Id;
  /** 自动补 '@' 前缀后的入库名 */
  normalizedName: string;
}

export function addContext(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: AddContextInput,
): UsecaseResult<AddContextConsequences> {
  const raw = input.name.trim();
  if (!raw || raw === '@') return { error: '名称不能为空' };
  const name = raw.startsWith('@') ? raw : `@${raw}`; // INV-24.1 自动前缀
  // INV-24.1:重名(精确匹配)拒绝;判定包含 archived 行(名称不复用,DESIGN §5.3)
  if (snap.contexts.some((c) => c.name === name)) {
    return { error: `context 重名: ${name}` };
  }
  const maxOrder = snap.contexts.reduce((m, c) => Math.max(m, c.sortOrder), -1);
  const context: Context = {
    id: deps.idGen.next(),
    name,
    sortOrder: maxOrder + 1, // 追加到末尾(§2.1)
    archived: false,
    createdAt: deps.clock.now(),
  };
  return {
    commands: [{ kind: 'createContext', context }],
    consequences: { contextId: context.id, normalizedName: name },
  };
}

// --------------------------------------------------------------- removeContext

export interface RemoveContextInput {
  id: Id;
  /** 含 active Task 时必须显式 true 才执行(INV-24.4 先警告数量并确认) */
  confirmTrashTasks?: boolean;
}

export interface RemoveContextConsequences {
  trashedTaskCount: number;
}

/** 三态返回:成功 / 需确认(不发命令)/ 错误。 */
export type RemoveContextResult =
  | { commands: Command[]; consequences: RemoveContextConsequences }
  | { requiresConfirmation: { activeTaskCount: number } }
  | { error: string };

/**
 * INV-24.3:不能删除最后一个 active context。
 * INV-24.4/D-09:含 active Task 且未确认 → 只返回数量征询,不发命令;
 * 确认后:这些 Task 软删除进 Trash(保留原 contextId)+ context archive。
 */
export function removeContext(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: RemoveContextInput,
): RemoveContextResult {
  const context = snap.contexts.find((c) => c.id === input.id);
  if (!context || context.archived) return { error: `context 不存在或已归档: ${input.id}` };
  const activeContexts = snap.contexts.filter((c) => !c.archived);
  if (activeContexts.length <= 1) return { error: '不能删除最后一个 context' };
  const activeTasks = snap.tasks.filter((t) => t.contextId === context.id && t.status === 'active');
  if (activeTasks.length > 0 && input.confirmTrashTasks !== true) {
    return { requiresConfirmation: { activeTaskCount: activeTasks.length } };
  }
  const now = deps.clock.now();
  const commands: Command[] = [
    ...activeTasks.map((t): Command => ({
      kind: 'updateTask',
      id: t.id,
      patch: { status: 'deleted', deletedAt: now }, // 软删进 Trash,contextId 保留(D-09/§5.3)
    })),
    { kind: 'updateContext', id: context.id, patch: { archived: true } },
  ];
  return { commands, consequences: { trashedTaskCount: activeTasks.length } };
}
