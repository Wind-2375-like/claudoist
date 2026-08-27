import type { Id, Timestamp } from './common';

/** GTD 情境(INVARIANTS §2.1)。规则见 INV-24。 */
export interface Context {
  id: Id;
  /** 必须 '@' 前缀;重名(含 archived)拒绝 */
  name: string;
  /** 语义负载:waiting follow-up 兜底 context 取 sortOrder 最小者(INV-23) */
  sortOrder: number;
  /** "删除" = archive(DESIGN §5.3):从选择器隐藏,历史 FK 保持有效 */
  archived: boolean;
  createdAt: Timestamp;
}

export const DEFAULT_CONTEXT_NAMES = ['@computer', '@phone', '@errands', '@home', '@office'];
