/** 基础标量语义见 docs/INVARIANTS.md §2。 */

export type Id = string;
/** YYYY-MM-DD(本地 naive,INV-03) */
export type IsoDate = string;
/** HH:MM */
export type IsoTime = string;
/** ISO-8601 本地时间戳 */
export type Timestamp = string;

export type Energy = 'low' | 'medium' | 'high';

/** INV-01:1 = 最低,5 = 最高。任何界面/序列化都不重编号。 */
export type Priority = 1 | 2 | 3 | 4 | 5;
