import type { Id, IsoDate } from './common';

/** 保存的查询(INVARIANTS §2.9);解释器对 energy/priority 复用 INV-01/INV-02 语义。 */
export interface FilterQuery {
  contextId?: Id;
  labelIds?: Id[];
  /** 任务 energy ≤ 此档(INV-02 序) */
  energyMax?: string;
  maxMinutes?: number;
  /** 任务 priority ≥ 此值(INV-01:数值大 = 更高) */
  priorityMin?: number;
  dueOnOrBefore?: IsoDate;
  noProject?: boolean;
  textQuery?: string;
}

export interface SavedFilter {
  id: Id;
  name: string;
  position: number;
  query: FilterQuery;
}
