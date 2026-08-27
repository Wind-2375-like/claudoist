import type { Id } from '../entities/common';
import type { ListKind } from '../entities/listItem';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import type { UsecaseResult } from './types';
import { isUsecaseError } from './types';
import type { QuickAddTaskConsequences, QuickAddTaskInput } from './tasks';
import { quickAddTask } from './tasks';
import type { CreateProjectDirectConsequences, CreateProjectDirectInput } from './projects';
import { createProjectDirect } from './projects';

/**
 * 理清路径①:手动 specify(INVARIANTS D-18)。
 * 每个操作 = "该条目的全部产物 + deleteInboxItem" 一个事务(INV-17 的卡片化载体);
 * §4.3 的去向语义(六种去向、deadline 继承)由复用的 usecase 保证。
 */

function findInboxItem(
  snap: GtdSnapshot,
  id: Id,
): { error: string } | { text: string; remove: Command } {
  const item = snap.inbox.find((i) => i.id === id);
  if (!item) return { error: `inbox 条目不存在: ${id}` };
  return { text: item.text, remove: { kind: 'deleteInboxItem', id } };
}

// ------------------------------------------------------------------- → Task

export interface ClarifyToTaskInput {
  inboxItemId: Id;
  task: QuickAddTaskInput;
}

export function clarifyInboxToTask(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: ClarifyToTaskInput,
): UsecaseResult<QuickAddTaskConsequences> {
  const found = findInboxItem(snap, input.inboxItemId);
  if ('error' in found) return found;
  const r = quickAddTask(snap, deps, input.task);
  if (isUsecaseError(r)) return r;
  return { commands: [...r.commands, found.remove], consequences: r.consequences };
}

// ---------------------------------------------------------------- → Project

export interface ClarifyToProjectInput {
  inboxItemId: Id;
  project: CreateProjectDirectInput;
}

export function clarifyInboxToProject(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: ClarifyToProjectInput,
): UsecaseResult<CreateProjectDirectConsequences> {
  const found = findInboxItem(snap, input.inboxItemId);
  if ('error' in found) return found;
  const r = createProjectDirect(snap, deps, input.project);
  if (isUsecaseError(r)) return r;
  return { commands: [...r.commands, found.remove], consequences: r.consequences };
}

// ------------------------------------------------------- → Someday/Ref/Trash

export interface ClarifyToListInput {
  inboxItemId: Id;
  kind: ListKind;
}

export interface ClarifyToListConsequences {
  listItemId: Id;
}

export function clarifyInboxToList(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: ClarifyToListInput,
): UsecaseResult<ClarifyToListConsequences> {
  const found = findInboxItem(snap, input.inboxItemId);
  if ('error' in found) return found;
  const listItemId = deps.idGen.next();
  return {
    commands: [
      {
        kind: 'createListItem',
        item: { id: listItemId, kind: input.kind, text: found.text, createdAt: deps.clock.now() },
      },
      found.remove,
    ],
    consequences: { listItemId },
  };
}
