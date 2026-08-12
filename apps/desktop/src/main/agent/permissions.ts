import { app, BrowserWindow } from 'electron';
import { resolve, sep } from 'node:path';
import type { GtdStore } from '@gtd/domain';
import type { AgentStore, SettingsStore } from '@gtd/storage-sqlite';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { attachmentsDir } from './sessionManager';
import {
  classify,
  decide,
  shortToolName,
  DEFAULT_PERMISSION_MODE,
  isModeAvailable,
  PERMISSION_MODES,
  type PermissionModeId,
} from '@gtd/agent-tools';

/**
 * `canUseTool` 桥(M9):主进程判定 → 需要时问渲染层 → 结果落审计。
 *
 * **失败一律关闭(fail-closed)**。三种"问不到人"的情况都判 deny:没有窗口、
 * 会话被中断(abort signal)、渲染层超时不答。理由很直接:一个悬而未决的审批会让
 * agent 永久挂起(SDK 明说 permission prompt 没有超时),而"默认放行"会让一次
 * 窗口崩溃变成一次静默的数据修改。宁可让 agent 收到"被拒绝"重来。
 */

export const PERMISSION_MODE_KEY = 'agent.permissionMode';
export const ALWAYS_ALLOW_KEY = 'agent.alwaysAllow';
/** 渲染层不答的兜底时限。比人的思考时间宽裕,但不至于让会话吊死一整天。 */
const ASK_TIMEOUT_MS = 10 * 60 * 1000;

export interface PermissionRequestVM {
  id: string;
  toolUseId: string;
  tool: string;
  qualifiedTool: string;
  input: Record<string, unknown>;
  toolClass: string;
  /** 升级为破坏性的原因,如"会连带完成 3 个子任务" */
  escalation?: string;
  reason: string;
  mode: PermissionModeId;
}

export type PermissionResponse =
  { behavior: 'allow'; always?: boolean } | { behavior: 'deny'; message?: string };

interface Pending {
  resolve: (r: PermissionResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

/** 渲染层回话。未知 id(窗口重载后的迟到回复)静默丢弃。 */
export function respondPermission(id: string, r: PermissionResponse): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(r);
}

/** 会话销毁时把所有挂起的审批打回,免得 agent 侧永远等下去。 */
export function rejectAllPending(reason = '会话已结束'): void {
  for (const [id, p] of pending) {
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve({ behavior: 'deny', message: reason });
  }
}

export function readMode(settings: SettingsStore): PermissionModeId {
  const raw = settings.get<string>(PERMISSION_MODE_KEY);
  const mode = PERMISSION_MODES.find((m) => m === raw) ?? DEFAULT_PERMISSION_MODE;
  // 打包版禁用 bypass:即使设置里残留旧值也要降级,而不是照单执行
  return isModeAvailable(mode, app.isPackaged) ? mode : DEFAULT_PERMISSION_MODE;
}

export function readAlwaysAllow(settings: SettingsStore): string[] {
  return settings.get<string[]>(ALWAYS_ALLOW_KEY) ?? [];
}

function addAlwaysAllow(settings: SettingsStore, tool: string): void {
  const cur = readAlwaysAllow(settings);
  if (!cur.includes(tool)) settings.set(ALWAYS_ALLOW_KEY, [...cur, tool]);
}

export interface BridgeDeps {
  store: GtdStore;
  settings: SettingsStore;
  agentStore: AgentStore;
  /** 当前会话行 id(审计外键) */
  conversationId: () => string;
  now: () => string;
  newId: () => string;
  /** toolUseID → 审计行 id;工具结果到达后回填 result_summary */
  onAudited: (toolUseId: string, auditId: string) => void;
}

const summarize = (v: unknown, max = 2000): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/**
 * 内置 `Read` 的围栏(M10)。
 *
 * `Read` 是附件功能的必要条件,但 SDK 默认把 **cwd** 也算作可读范围,而我们的 cwd 是
 * `userData` —— 里面有 `secrets/`(Google OAuth 的 safeStorage 密文)和 `data/gtd.sqlite3`
 * (原始库,含被软删、搜索故意不返回的行)。给 agent 读它们没有任何正当用途。
 *
 * 不用 SDK 的 `permissions.deny` 规则来挡:那套路径匹配语法写错了会**静默失效**,
 * 而"静默失效的安全规则"比没有规则更糟。在自己的桥上按绝对路径判断,行为可验证。
 */
function readOutsideAttachments(toolName: string, input: Record<string, unknown>): string | null {
  if (shortToolName(toolName) !== 'Read') return null;
  const raw = input['file_path'];
  if (typeof raw !== 'string' || raw === '') return '没给文件路径';
  const target = resolve(raw);
  const allowed = resolve(attachmentsDir());
  if (target === allowed || target.startsWith(`${allowed}${sep}`)) return null;
  return '只能读应用附件目录里的文件(拖进聊天框的那些)';
}

export function createCanUseTool(d: BridgeDeps): CanUseTool {
  return async (toolName, input, options) => {
    const mode = readMode(d.settings);
    const classification = classify(toolName, input, d.store);
    const fenced = readOutsideAttachments(toolName, input);
    const { decision, reason } =
      fenced !== null
        ? ({ decision: 'deny', reason: fenced } as const)
        : decide({
            mode,
            classification,
            alwaysAllow: readAlwaysAllow(d.settings),
          });

    const audit = (dec: 'allowed-auto' | 'allowed-user' | 'denied'): string => {
      const id = d.newId();
      try {
        d.agentStore.recordAudit({
          id,
          conversationId: d.conversationId(),
          toolName: classification.tool,
          inputJson: summarize(input),
          decision: dec,
          resultSummary: null,
          createdAt: d.now(),
        });
        d.onAudited(options.toolUseID, id);
      } catch (e) {
        // 审计写失败不能连带把工具调用也弄挂 —— 但要留痕
        process.stderr.write(`[agent-audit] 落库失败: ${String(e)}\n`);
      }
      return id;
    };

    // 只读工具不弹窗,但**照样落审计** —— 审计要完整才有用
    if (decision === 'allow') {
      audit('allowed-auto');
      return { behavior: 'allow', updatedInput: input } satisfies PermissionResult;
    }
    if (decision === 'deny') {
      audit('denied');
      // 围栏是无条件的,切权限模式也解不开 —— 别给出一个做不到的建议
      return {
        behavior: 'deny',
        message:
          fenced !== null
            ? `${reason}。这条限制与权限模式无关,切模式也解不开。`
            : `${reason}。若确实需要,请让用户在 Agent 面板切换权限模式。`,
      } satisfies PermissionResult;
    }

    const win = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    if (!win) {
      audit('denied');
      return { behavior: 'deny', message: '没有可用窗口来征求用户同意,已拒绝。' };
    }

    const id = d.newId();
    const vm: PermissionRequestVM = {
      id,
      toolUseId: options.toolUseID,
      tool: classification.tool,
      qualifiedTool: toolName,
      input,
      toolClass: classification.toolClass,
      ...(classification.escalation !== undefined ? { escalation: classification.escalation } : {}),
      reason,
      mode,
    };

    const answer = await new Promise<PermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ behavior: 'deny', message: '等待用户确认超时,已拒绝。' });
      }, ASK_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      // 用户按了中断 / 会话被销毁 → 立刻打回,不要吊着
      options.signal.addEventListener('abort', () => {
        respondPermission(id, { behavior: 'deny', message: '本轮已中断。' });
      });
      win.webContents.send('agent:permission.request', vm);
    });

    if (answer.behavior === 'allow') {
      if (answer.always === true) addAlwaysAllow(d.settings, classification.tool);
      audit('allowed-user');
      return { behavior: 'allow', updatedInput: input };
    }
    audit('denied');
    return { behavior: 'deny', message: answer.message ?? '用户拒绝了这次操作。' };
  };
}
