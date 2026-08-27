import type { Clock } from '../ports/clock';
import type { IdGen } from '../ports/idGen';

/**
 * usecase 依赖注入(历史上是向导流程框架;向导状态机已随 D-21 删除,
 * 保留此文件仅为 FlowDeps ——所有 usecase 的 (snap, deps, input) 签名依赖它)。
 */
export interface FlowDeps {
  idGen: IdGen;
  clock: Clock;
}
