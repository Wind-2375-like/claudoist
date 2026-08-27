import type { Id, Timestamp } from './common';

export type ListKind = 'someday' | 'reference' | 'trash';

/** Someday/Maybe、Reference、Trash 条目(INVARIANTS §2.7)。 */
export interface ListItem {
  id: Id;
  kind: ListKind;
  text: string;
  createdAt: Timestamp;
}
