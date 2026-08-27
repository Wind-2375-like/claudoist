import type { Id } from '../entities/common';
import type { InboxItem } from '../entities/inboxItem';
import type { ListItem, ListKind } from '../entities/listItem';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import type { UsecaseResult } from './types';

/** List 域 usecases(someday/reference/trash;INV-21 激活必回 inbox)。 */

// ------------------------------------------------------------------ moveToList

export interface MoveToListInput {
  text: string;
  kind: ListKind;
}

export interface MoveToListConsequences {
  listItemId: Id;
}

/** 文本归档到三类列表之一(§2.7:逐字保存)。 */
export function moveToList(
  _snap: GtdSnapshot,
  deps: FlowDeps,
  input: MoveToListInput,
): UsecaseResult<MoveToListConsequences> {
  if (input.text.trim() === '') return { error: 'text 不能为空' };
  const item: ListItem = {
    id: deps.idGen.next(),
    kind: input.kind,
    text: input.text,
    createdAt: deps.clock.now(),
  };
  return { commands: [{ kind: 'createListItem', item }], consequences: { listItemId: item.id } };
}

// ------------------------------------------------------------- activateSomeday

export interface ActivateSomedayInput {
  id: Id;
}

export interface RoutedToInboxConsequences {
  routedToInbox: true;
  inboxItemId: Id;
  /** INV-21:绝不直达 Task —— 本后果永不含 taskId */
}

/** 队尾追加 inbox 条目 + 删除原 ListItem 的命令对。 */
function moveListItemToInbox(
  snap: GtdSnapshot,
  deps: FlowDeps,
  item: ListItem,
): { commands: Command[]; inboxItemId: Id } {
  const tail = snap.inbox.reduce((m, i) => Math.max(m, i.position), -1);
  const inboxItem: InboxItem = {
    id: deps.idGen.next(),
    text: item.text,
    createdAt: deps.clock.now(),
    position: tail + 1,
  };
  return {
    commands: [
      { kind: 'deleteListItem', id: item.id },
      { kind: 'createInboxItem', item: inboxItem },
    ],
    inboxItemId: inboxItem.id,
  };
}

/**
 * INV-21 ⚠SP:Someday 激活的**唯一**出口 = 移回 inbox 队尾重走 clarify;
 * 永不直接生成 Task/Project。
 */
export function activateSomeday(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: ActivateSomedayInput,
): UsecaseResult<RoutedToInboxConsequences> {
  const item = snap.listItems.find((x) => x.id === input.id);
  if (!item) return { error: `条目不存在: ${input.id}` };
  if (item.kind !== 'someday') return { error: `不是 someday 条目: ${input.id}` };
  const { commands, inboxItemId } = moveListItemToInbox(snap, deps, item);
  return { commands, consequences: { routedToInbox: true, inboxItemId } };
}

// ------------------------------------------------------- restoreTrashListItem

export interface RestoreTrashListItemInput {
  id: Id;
}

/** Trash 文本条目恢复:同样只回 inbox 队尾重走 clarify(与 INV-21 同构)。 */
export function restoreTrashListItem(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: RestoreTrashListItemInput,
): UsecaseResult<RoutedToInboxConsequences> {
  const item = snap.listItems.find((x) => x.id === input.id);
  if (!item) return { error: `条目不存在: ${input.id}` };
  if (item.kind !== 'trash') return { error: `不是 trash 条目: ${input.id}` };
  const { commands, inboxItemId } = moveListItemToInbox(snap, deps, item);
  return { commands, consequences: { routedToInbox: true, inboxItemId } };
}
