import type { Id } from '../entities/common';
import type { WaitingFor } from '../entities/waitingFor';
import { DELEGATED_TO_DEFAULT } from '../entities/waitingFor';
import type { Command, GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import { buildFollowUpTask } from '../rules/followUpTemplate';
import type { UsecaseResult } from './types';

/** WaitingFor 域 usecases(直建 / resolve / 催办)。resolve 与 follow-up 严格解耦(INV-23)。 */

// ------------------------------------------------------- createWaitingForDirect

export interface CreateWaitingForDirectInput {
  description: string;
  delegatedTo?: string;
  projectId?: Id;
}

export interface CreateWaitingForDirectConsequences {
  waitingForId: Id;
}

export function createWaitingForDirect(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: CreateWaitingForDirectInput,
): UsecaseResult<CreateWaitingForDirectConsequences> {
  const description = input.description.trim();
  if (!description) return { error: 'description 不能为空' };
  const projectId = input.projectId ?? null;
  // 必须是 active:往已完成/已删项目挂等待项 = 纯隐身数据,还会让 hasActiveNextAction 恒 true
  if (
    projectId !== null &&
    !snap.projects.some((p) => p.id === projectId && p.status === 'active')
  ) {
    return { error: `项目不存在或不可用(已完成/在回收站): ${projectId}` };
  }
  const delegatedTo = input.delegatedTo?.trim() || DELEGATED_TO_DEFAULT; // 留空 → 'someone'(§2.6)
  const item: WaitingFor = {
    id: deps.idGen.next(),
    description,
    delegatedTo,
    projectId,
    delegatedAt: deps.clock.now(),
    resolved: false,
    resolvedAt: null,
    sourceTaskJson: null, // 直建,无被转换行动(INV-19 仅 clarify 路由产生)
  };
  return {
    commands: [{ kind: 'createWaitingFor', item }],
    consequences: { waitingForId: item.id },
  };
}

// ------------------------------------------------------------ resolveWaitingFor

export interface ResolveWaitingForInput {
  id: Id;
}

/** INV-14 边界:resolve 不是追问漏斗入口 —— 无任何追问后果字段。 */
export type ResolveWaitingForConsequences = Record<string, never>;

/**
 * 仅置 resolved + resolvedAt。**不**建 follow-up、**不**触发完成后追问或孤儿提示
 * (即使这是项目最后的 active next action —— resolve 不触发任何完成后果提示,INV-14 边界)。
 */
export function resolveWaitingFor(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: ResolveWaitingForInput,
): UsecaseResult<ResolveWaitingForConsequences> {
  const w = snap.waiting.find((x) => x.id === input.id);
  if (!w) return { error: `等待项不存在: ${input.id}` };
  if (w.resolved) return { error: `等待项已解决: ${input.id}` };
  const commands: Command[] = [
    { kind: 'updateWaitingFor', id: w.id, patch: { resolved: true, resolvedAt: deps.clock.now() } },
  ];
  return { commands, consequences: {} };
}

// --------------------------------------------------------------- createFollowUp

export interface CreateFollowUpInput {
  waitingForId: Id;
}

export interface CreateFollowUpConsequences {
  /** 新建催办 Task 的 id */
  followUpCreated: Id;
}

/**
 * INV-23:对**未解决**的等待项按固定模板建催办行动;不改变 resolved 状态
 * (催办的对象正是还没回音的委派)。已 resolved → 错误。
 */
export function createFollowUp(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: CreateFollowUpInput,
): UsecaseResult<CreateFollowUpConsequences> {
  const w = snap.waiting.find((x) => x.id === input.waitingForId);
  if (!w) return { error: `等待项不存在: ${input.waitingForId}` };
  if (w.resolved) return { error: `等待项已解决,无需催办: ${input.waitingForId}` };
  const { task, commands } = buildFollowUpTask(snap, deps, w);
  // 只发 createTask;不发任何 updateWaitingFor(INV-23)
  return { commands, consequences: { followUpCreated: task.id } };
}
