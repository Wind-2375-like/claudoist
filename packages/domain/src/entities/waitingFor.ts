import type { Id, Timestamp } from './common';

/** 委派等待项(INVARIANTS §2.6)。未解决项计入项目 active next action(INV-05)。 */
export interface WaitingFor {
  id: Id;
  description: string;
  delegatedTo: string;
  projectId: Id | null;
  delegatedAt: Timestamp;
  resolved: boolean;
  resolvedAt: Timestamp | null;
  sourceTaskJson: string | null;
}

export const DELEGATED_TO_DEFAULT = 'someone';
