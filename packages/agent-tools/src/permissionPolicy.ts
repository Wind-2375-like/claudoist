import { descendantTaskIds } from '@gtd/domain';
import type { GtdStore } from '@gtd/domain';
import type { PermissionMode as SdkPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { shortToolName, toolKind } from './toolCatalog';

/**
 * 权限策略(M9)—— **判定逻辑只此一处**。
 *
 * 为什么要单独一个模块:审批的正确性靠"每条路径都走同一段代码"来保证。散在
 * sessionManager 和 IPC handler 里,迟早出现"某条路径忘了查 destructive"这种漏洞,
 * 而它的表现是 agent 在自动模式下直接删了任务 —— 用户不会原谅这种 bug。
 *
 * 放在 agent-tools 而不是 desktop,也是为了它**不依赖 Electron**:五种模式 × 四类工具
 * 的判定表必须能被单元测试逐格断言(见 test/permission-policy.spec.ts)。
 *
 * ## 与 SDK 的关系
 *
 * SDK 自己有 `permissionMode` 和 `allowedTools`,但**我们几乎不用它们做放行**:
 *
 * - `allowedTools` 会让工具**绕过** `canUseTool`,于是那次调用不进审计。审计要完整,
 *   就得让每一次调用都经过 `canUseTool` —— 它是进程内函数调用,零网络开销。
 * - `bypassPermissions` 同理会跳过 `canUseTool`,连"放行"这件事都记不下来。所以
 *   "全部放行"模式在我们这儿实现为 **canUseTool 一律返回 allow**,而不是把决定权
 *   交出去。附带好处:不需要 `allowDangerouslySkipPermissions`。
 *
 * 唯一真正交给 SDK 的是 `plan`:它让模型自己知道"现在是计划阶段",行为更贴切。
 * 但**保证不写**这件事仍由 canUseTool 兜底(SDK 的 plan 是引导,不是围栏)。
 *
 * ## 破坏性的动态升级
 *
 * `complete_task` 平时只是改个状态(还能 reopen),但目标有活跃子任务时它会
 * **级联完成整棵子树**(INV-26.1),而级联数量只在返回值里 —— 事后才知道。
 * 所以这里按当前快照判断:有活跃后代 → 升级为 destructive → 即使自动模式也弹窗。
 */

export const PERMISSION_MODES = ['plan', 'manual', 'acceptEdits', 'auto', 'bypass'] as const;
export type PermissionModeId = (typeof PERMISSION_MODES)[number];

export const PERMISSION_MODE_LABELS: Record<PermissionModeId, { label: string; hint: string }> = {
  plan: { label: '只读', hint: 'agent 只能查和建议,任何写入一律拒绝' },
  manual: { label: '逐条确认', hint: '每次写入都弹窗问你(推荐)' },
  acceptEdits: { label: '自动改已有', hint: '改既有条目直通;新建、完成、删除仍要问' },
  auto: { label: '自动', hint: '写入直通;删除、完成项目、级联完成仍要问' },
  bypass: { label: '全部放行', hint: '不再询问 —— 包括删除。只在你完全信任时用' },
};

export const DEFAULT_PERMISSION_MODE: PermissionModeId = 'manual';

/** 工具的权限类别。`read` 之外的三档决定它要不要弹窗。 */
export type ToolClass = 'read' | 'create' | 'edit' | 'destructive';

/** 静态分类;`complete_task` 的最终归属由 `classify()` 按快照决定。 */
const CLASS_BY_TOOL: Record<string, ToolClass> = {
  capture: 'create',
  create_task: 'create',
  add_subtask: 'create',
  create_project: 'create',
  create_waiting_for: 'create',
  create_follow_up: 'create',
  create_label: 'create',
  create_filter: 'create',
  update_task: 'edit',
  move_task: 'edit',
  set_task_labels: 'edit',
  update_project: 'edit',
  add_comment: 'edit',
  reopen_task: 'edit',
  restore_task: 'edit',
  resolve_waiting_for: 'edit',
  complete_task: 'edit', // 有活跃子任务时动态升级为 destructive
  complete_project: 'destructive',
  delete_task: 'destructive',
};

export type Decision = 'allow' | 'ask' | 'deny';

/** 模式 × 类别 → 决定。这张表就是权限模型的全部。 */
const MATRIX: Record<PermissionModeId, Record<ToolClass, Decision>> = {
  plan: { read: 'allow', create: 'deny', edit: 'deny', destructive: 'deny' },
  manual: { read: 'allow', create: 'ask', edit: 'ask', destructive: 'ask' },
  acceptEdits: { read: 'allow', create: 'ask', edit: 'allow', destructive: 'ask' },
  auto: { read: 'allow', create: 'allow', edit: 'allow', destructive: 'ask' },
  bypass: { read: 'allow', create: 'allow', edit: 'allow', destructive: 'allow' },
};

export interface Classification {
  /** 短名(mcp__gtd__ 已剥离);非 GTD 工具保持原名 */
  tool: string;
  toolClass: ToolClass;
  /** 因当前数据而升级为破坏性时,这里是给用户看的理由 */
  escalation?: string;
}

/**
 * 分类一次调用。`store` 用于动态升级 —— 拿不到目标任务时按静态分类走
 * (查不到 ≠ 安全,但那种情况 usecase 自己会报"行动不存在")。
 */
export function classify(
  toolName: string,
  input: Record<string, unknown>,
  store: GtdStore,
): Classification {
  const tool = shortToolName(toolName);
  const kind = toolKind(tool);
  // 非 GTD 工具(目前只有内置 Skill)= 只读:它只是把 skill 正文读进上下文
  if (kind === 'unknown') return { tool, toolClass: 'read' };
  const base = CLASS_BY_TOOL[tool] ?? (kind === 'write' ? 'edit' : 'read');
  if (tool !== 'complete_task') return { tool, toolClass: base };

  const taskId = typeof input['taskId'] === 'string' ? input['taskId'] : null;
  if (taskId === null) return { tool, toolClass: base };
  const snap = store.snapshot();
  const byId = new Map(snap.tasks.map((t) => [t.id, t]));
  const cascading = descendantTaskIds(snap, taskId).filter(
    (id) => byId.get(id)?.status === 'active',
  ).length;
  if (cascading === 0) return { tool, toolClass: base };
  return {
    tool,
    toolClass: 'destructive',
    escalation: `会连带完成 ${String(cascading)} 个子任务(向下级联,INV-26.1)`,
  };
}

export interface DecideInput {
  mode: PermissionModeId;
  classification: Classification;
  /** 用户按过 "始终允许" 的工具短名 */
  alwaysAllow: readonly string[];
}

export interface DecideOutput {
  decision: Decision;
  /** 审计与 UI 用的一句话理由 */
  reason: string;
}

export function decide(i: DecideInput): DecideOutput {
  const { toolClass, tool, escalation } = i.classification;
  const base = MATRIX[i.mode][toolClass];
  if (base === 'allow') return { decision: 'allow', reason: `${i.mode} 模式下 ${toolClass} 直通` };
  // plan 模式不认 "始终允许" —— 用户选只读就是选只读,别的开关不该把它捅穿
  if (i.mode !== 'plan' && i.alwaysAllow.includes(tool)) {
    return { decision: 'allow', reason: '用户此前选了「始终允许」' };
  }
  if (base === 'deny') return { decision: 'deny', reason: '只读模式:不执行任何写入' };
  return {
    decision: 'ask',
    reason: escalation ?? (toolClass === 'destructive' ? '破坏性操作' : `${toolClass} 需要确认`),
  };
}

/** 传给 SDK 的 permissionMode。除 plan 外一律 default —— 放行全在 canUseTool。 */
export function sdkPermissionMode(mode: PermissionModeId): SdkPermissionMode {
  return mode === 'plan' ? 'plan' : 'default';
}

/** 打包版禁用"全部放行"(见 ROADMAP M9);dev 下允许,便于跑冒烟。 */
export function isModeAvailable(mode: PermissionModeId, packaged: boolean): boolean {
  return !(mode === 'bypass' && packaged);
}
