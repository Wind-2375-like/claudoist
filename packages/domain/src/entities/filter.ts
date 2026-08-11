import type { Id } from './common';

/**
 * 保存的查询(INVARIANTS §2.9;查询语言见 INV-33 与 `rules/filterQuery.ts`)。
 *
 * `query` 存**查询原文**而非解析后的 AST:AST 是派生物,语法一演进就得写一次数据迁移;
 * 存原文则升级即重解析,而且用户在编辑器里看到的永远是自己写下的那一行。
 * (D-32 之前是结构化对象 `{contextId?, labelIds?, energyMax?, …}`,迁移 v13 转写为文本。)
 */
export interface SavedFilter {
  id: Id;
  name: string;
  position: number;
  query: string;
}
