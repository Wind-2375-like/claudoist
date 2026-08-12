import { app } from 'electron';
import { deleteSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationRow } from '@gtd/storage-sqlite';
import { agentStore } from '../db';

/**
 * 会话索引(M10)。
 *
 * **正文不在我们手里**:transcript 由 SDK 写在
 * `~/.claude/projects/<encoded cwd>/<sdk_session_id>.jsonl`。我们只在 SQLite 里存一行
 * 索引(标题/模型/成本/时间),用来渲染列表、resume、算账。
 *
 * 因此"删除会话"必须删两处 —— 只删索引会留下孤儿 jsonl(占空间、且下次 resume 那个 id
 * 居然还能接上),只删 jsonl 会留下点开就空白的条目。
 */

/** SDK 的会话按 cwd 分目录;我们所有会话都跑在 userData 下。 */
const projectDir = (): string => app.getPath('userData');

export interface ConversationVM {
  id: string;
  sdkSessionId: string | null;
  title: string;
  model: string;
  createdAt: string;
  lastMessageAt: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  forkedFrom: string | null;
  /** 是不是当前活着的那条 */
  active: boolean;
}

const toVM = (r: ConversationRow, activeId: string | null): ConversationVM => ({
  id: r.id,
  sdkSessionId: r.sdkSessionId,
  title: r.title,
  model: r.model,
  createdAt: r.createdAt,
  lastMessageAt: r.lastMessageAt,
  costUsd: r.totalCostUsd,
  inputTokens: r.totalInputTokens,
  outputTokens: r.totalOutputTokens,
  forkedFrom: r.forkedFrom,
  active: r.id === activeId,
});

export function createConversation(model: string, forkedFrom?: string): string {
  const id = crypto.randomUUID();
  agentStore().createConversation({
    id,
    title: forkedFrom === undefined ? '新会话' : '分叉会话',
    model,
    now: new Date().toISOString(),
    ...(forkedFrom !== undefined ? { forkedFrom } : {}),
  });
  return id;
}

/** 第一条用户消息就是标题 —— 比"新会话 3"有用得多。 */
export function titleFromFirstMessage(id: string, text: string): void {
  const row = agentStore().getConversation(id);
  if (!row || (row.title !== '新会话' && row.title !== '分叉会话')) return;
  const t = text.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (t !== '') agentStore().renameConversation(id, t);
}

export function listConversations(activeId: string | null): ConversationVM[] {
  return agentStore()
    .listConversations(100)
    .map((r) => toVM(r, activeId));
}

/** 删索引 + 删 jsonl。jsonl 删失败不阻塞(可能本来就没落盘 —— 会话一条消息都没发过)。 */
export async function removeConversation(id: string): Promise<{ error?: string }> {
  const row = agentStore().getConversation(id);
  if (!row) return { error: '会话不存在' };
  agentStore().deleteConversation(id);
  if (row.sdkSessionId !== null) {
    try {
      await deleteSession(row.sdkSessionId, { dir: projectDir() });
    } catch (e) {
      process.stderr.write(`[conversations] 删除 transcript 失败(索引已删): ${String(e)}\n`);
    }
  }
  return {};
}

export interface TranscriptItem {
  role: 'user' | 'assistant';
  text: string;
  /** 该条里出现的工具名(用来在历史里也显示 chip) */
  tools: string[];
}

/**
 * 读历史会话正文,渲染成聊天气泡。
 *
 * 注意这里**只取文本与工具名**:完整的 tool_result 动辄几 KB,历史视图里没人会去读,
 * 拉过来只会把 IPC 撑爆。要细节可以看审计表。
 */
export async function transcript(sdkSessionId: string): Promise<TranscriptItem[]> {
  const msgs = await getSessionMessages(sdkSessionId, { dir: projectDir() });
  const out: TranscriptItem[] = [];
  for (const m of msgs as { type?: string; message?: { role?: string; content?: unknown } }[]) {
    const role = m.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = m.message?.content;
    let text = '';
    const tools: string[] = [];
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      for (const b of content as { type?: string; text?: string; name?: string }[]) {
        if (b.type === 'text' && typeof b.text === 'string') text += b.text;
        if (b.type === 'tool_use' && typeof b.name === 'string') tools.push(b.name);
      }
    }
    // 我们给每条用户消息前置的 [此刻 …] 时间戳块不该出现在历史气泡里
    text = text.replace(/^\[此刻[^\]]*\]\s*/, '').trim();
    if (text === '' && tools.length === 0) continue;
    out.push({ role, text, tools });
  }
  return out;
}
