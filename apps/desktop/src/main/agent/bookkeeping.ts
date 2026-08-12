import type { GtdStore } from '@gtd/domain';
import type { SettingsStore } from '@gtd/storage-sqlite';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { agentStore } from '../db';
import { createCanUseTool } from './permissions';

/**
 * 会话账房(M9/M10):审批桥的接线 + 每条 SDK 消息的记账。
 *
 * 单独成模块的理由:IPC handler 与无头冒烟必须走**同一段代码**。M8 的冒烟自己搭了一套
 * 简化版 canUseTool,结果它验的是"我写的假桥能跑",而不是"真桥能跑" —— 权限这种
 * 一处漏就全盘失效的东西,冒烟必须打在生产路径上。
 */

/** toolUseID → 审计行 id。审批发生在执行**之前**,结果摘要只能等工具回来再回填。 */
const auditByToolUse = new Map<string, string>();

export function buildCanUseTool(input: {
  store: GtdStore;
  settings: SettingsStore;
  conversationId: () => string;
}): CanUseTool {
  return createCanUseTool({
    store: input.store,
    settings: input.settings,
    agentStore: agentStore(),
    conversationId: input.conversationId,
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
    onAudited: (toolUseId, auditId) => auditByToolUse.set(toolUseId, auditId),
  });
}

/**
 * 每条 SDK 消息的记账:
 * - system/init → 把 SDK session id 回写进会话行(resume 与删 jsonl 都靠它)
 * - user(工具结果回灌)→ 回填审计行的 result_summary
 * - result → 累加用量
 */
export function recordSdkMessage(conversationId: string, payload: unknown): void {
  const m = payload as {
    type?: string;
    subtype?: string;
    session_id?: string;
    message?: { content?: unknown[] };
    usage?: Record<string, number>;
    total_cost_usd?: number;
  };
  const st = agentStore();

  if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
    const row = st.getConversation(conversationId);
    if (row && row.sdkSessionId !== m.session_id) st.setSdkSessionId(conversationId, m.session_id);
    return;
  }

  if (m.type === 'user') {
    for (const block of m.message?.content ?? []) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown };
      if (b.type !== 'tool_result' || b.tool_use_id === undefined) continue;
      const auditId = auditByToolUse.get(b.tool_use_id);
      if (auditId === undefined) continue;
      auditByToolUse.delete(b.tool_use_id);
      const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      try {
        st.setAuditResult(auditId, text.slice(0, 2000));
      } catch {
        // 审计回填失败不影响会话
      }
    }
    return;
  }

  if (m.type === 'result') {
    const u = m.usage ?? {};
    st.addUsage(conversationId, {
      now: new Date().toISOString(),
      costUsd: m.total_cost_usd ?? 0,
      // 缓存读写也是真金白银(M8 用户问过 $0.20 从哪来),一并计入输入侧
      inputTokens:
        (u['input_tokens'] ?? 0) +
        (u['cache_creation_input_tokens'] ?? 0) +
        (u['cache_read_input_tokens'] ?? 0),
      outputTokens: u['output_tokens'] ?? 0,
    });
  }
}
