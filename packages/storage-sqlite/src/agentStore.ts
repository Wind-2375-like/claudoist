import type { DatabaseSync } from 'node:sqlite';

/**
 * 会话索引 + 工具审计(M9/M10)。
 *
 * 这两张表是**非领域**数据:agent 的会话与它做过什么,与 GTD 规则无关,所以不进
 * `GtdSnapshot`、不走 `Command`。放在 storage 包而不是 main 里,是为了让 SQL 只存在
 * 于一层 —— main 里出现手写 SQL 就等于开了第二个持久化口径。
 *
 * `conversations` 是 **jsonl transcript 的索引**,不是 transcript 本身:正文由 SDK 写在
 * `~/.claude/projects/<encoded-cwd>/<session>.jsonl`,这里只存标题/模型/成本/时间,
 * 用来渲染会话列表和 resume。删会话时两边都要清(见 desktop/agent/conversations.ts)。
 */

export interface ConversationRow {
  id: string;
  sdkSessionId: string | null;
  title: string;
  model: string;
  createdAt: string;
  lastMessageAt: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  forkedFrom: string | null;
  archived: boolean;
}

export type AuditDecision = 'allowed-auto' | 'allowed-user' | 'denied';

export interface AuditRow {
  id: string;
  conversationId: string;
  toolName: string;
  inputJson: string;
  decision: AuditDecision;
  resultSummary: string | null;
  createdAt: string;
}

export interface AgentStore {
  createConversation(row: {
    id: string;
    title: string;
    model: string;
    now: string;
    forkedFrom?: string | null;
  }): void;
  setSdkSessionId(id: string, sdkSessionId: string): void;
  renameConversation(id: string, title: string): void;
  /** 累加一轮的用量(ResultMessage 到达时调用) */
  addUsage(
    id: string,
    u: { now: string; costUsd: number; inputTokens: number; outputTokens: number },
  ): void;
  listConversations(limit?: number): ConversationRow[];
  getConversation(id: string): ConversationRow | null;
  /** 连同该会话的审计行一起删(外键) */
  deleteConversation(id: string): void;
  recordAudit(row: AuditRow): void;
  /** 结果摘要要等工具跑完才有(审批发生在执行**之前**),故分两步写 */
  setAuditResult(id: string, summary: string): void;
  listAudit(conversationId: string | null, limit?: number): AuditRow[];
  /** 总账:全部会话累计 */
  totals(): { conversations: number; costUsd: number; inputTokens: number; outputTokens: number };
}

const toConversation = (r: Record<string, unknown>): ConversationRow => ({
  id: r['id'] as string,
  sdkSessionId: (r['sdk_session_id'] as string | null) ?? null,
  title: r['title'] as string,
  model: r['model'] as string,
  createdAt: r['created_at'] as string,
  lastMessageAt: r['last_message_at'] as string,
  totalCostUsd: r['total_cost_usd'] as number,
  totalInputTokens: r['total_input_tokens'] as number,
  totalOutputTokens: r['total_output_tokens'] as number,
  forkedFrom: (r['forked_from'] as string | null) ?? null,
  archived: r['archived'] === 1,
});

const toAudit = (r: Record<string, unknown>): AuditRow => ({
  id: r['id'] as string,
  conversationId: r['conversation_id'] as string,
  toolName: r['tool_name'] as string,
  inputJson: r['input_json'] as string,
  decision: r['decision'] as AuditDecision,
  resultSummary: (r['result_summary'] as string | null) ?? null,
  createdAt: r['created_at'] as string,
});

export function createAgentStore(db: DatabaseSync): AgentStore {
  return {
    createConversation(row) {
      db.prepare(
        `INSERT INTO conversations
           (id, sdk_session_id, title, model, created_at, last_message_at, forked_from)
         VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      ).run(row.id, row.title, row.model, row.now, row.now, row.forkedFrom ?? null);
    },
    setSdkSessionId(id, sdkSessionId) {
      db.prepare('UPDATE conversations SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id);
    },
    renameConversation(id, title) {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
    },
    addUsage(id, u) {
      db.prepare(
        `UPDATE conversations SET
           last_message_at = ?,
           total_cost_usd = total_cost_usd + ?,
           total_input_tokens = total_input_tokens + ?,
           total_output_tokens = total_output_tokens + ?
         WHERE id = ?`,
      ).run(u.now, u.costUsd, u.inputTokens, u.outputTokens, id);
    },
    listConversations(limit = 50) {
      return (
        db
          .prepare('SELECT * FROM conversations ORDER BY last_message_at DESC LIMIT ?')
          .all(limit) as Record<string, unknown>[]
      ).map(toConversation);
    },
    getConversation(id) {
      const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
        Record<string, unknown> | undefined;
      return r === undefined ? null : toConversation(r);
    },
    deleteConversation(id) {
      // 审计行有 FK 指向会话,必须先删(一个事务:半删会留下引用不存在会话的审计行)
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM agent_audit WHERE conversation_id = ?').run(id);
        db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    recordAudit(row) {
      db.prepare(
        `INSERT INTO agent_audit
           (id, conversation_id, tool_name, input_json, decision, result_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.conversationId,
        row.toolName,
        row.inputJson,
        row.decision,
        row.resultSummary,
        row.createdAt,
      );
    },
    setAuditResult(id, summary) {
      db.prepare('UPDATE agent_audit SET result_summary = ? WHERE id = ?').run(summary, id);
    },
    listAudit(conversationId, limit = 200) {
      const rows =
        conversationId === null
          ? (db
              .prepare('SELECT * FROM agent_audit ORDER BY created_at DESC LIMIT ?')
              .all(limit) as Record<string, unknown>[])
          : (db
              .prepare(
                'SELECT * FROM agent_audit WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
              )
              .all(conversationId, limit) as Record<string, unknown>[]);
      return rows.map(toAudit);
    },
    totals() {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(total_cost_usd), 0) AS cost,
                  COALESCE(SUM(total_input_tokens), 0) AS ti,
                  COALESCE(SUM(total_output_tokens), 0) AS to_
             FROM conversations`,
        )
        .get() as Record<string, unknown>;
      return {
        conversations: r['n'] as number,
        costUsd: r['cost'] as number,
        inputTokens: r['ti'] as number,
        outputTokens: r['to_'] as number,
      };
    },
  };
}
