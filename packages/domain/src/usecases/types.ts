import type { Command } from '../ports/gtdStore';

/**
 * usecase 统一返回约定(docs/DESIGN.md §6.3;UI IPC 与 agent MCP 工具共用的唯一写路径):
 * 成功 = { commands, consequences } —— 命令由宿主原子应用(一个事务,INV-17 载体),
 * consequences 供调用方向用户征询下一步(INV-15:系统绝不自动创建/完成/删除);
 * 失败 = { error },不抛异常。
 */
export interface UsecaseOk<C> {
  commands: Command[];
  consequences: C;
}

export interface UsecaseErr {
  error: string;
}

export type UsecaseResult<C> = UsecaseOk<C> | UsecaseErr;

export function isUsecaseError<C>(r: UsecaseResult<C>): r is UsecaseErr {
  return 'error' in r;
}

/**
 * 完成事件(Task / CalendarItem)的追问 payload(§4.7 agent 路径,INV-14/INV-15):
 * 三字段同进退 —— 全部缺席 ⟺ 无追问(无项目 / 项目已 complete,BUG-02 守卫)。
 * parentCompletionCandidate = 完成后项目已无余活动(INV-05 口径),
 * 仅供调用方征询;绝不据此自动完成任何实体。
 */
export interface CompletionFollowUpConsequences {
  projectBreadcrumb?: string;
  projectHasRemainingActivity?: boolean;
  parentCompletionCandidate?: boolean;
}
