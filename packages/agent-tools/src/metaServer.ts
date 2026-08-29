import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * 会话元数据工具(2026-08-27 用户反馈:「看我们其他的对话」—— agent 此前只能去猜
 * 文件路径,Read 一个不存在的 memory 文件然后失败)。
 *
 * 依赖注入而不是直接读库:会话索引在 main 的 SQLite、正文在 SDK 的 transcript 文件,
 * 都是 main 独有的东西 —— 本包保持纯逻辑,谁用谁喂。
 */

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  lastMessageAt: string;
  /** 是否就是当前正在进行的这个会话 */
  current: boolean;
}

export interface ConversationEntry {
  role: 'user' | 'assistant';
  text: string;
  tools: string[];
}

export interface MetaDeps {
  listConversations: () => ConversationSummary[];
  /** 返回 null = 会话不存在或还没有正文 */
  readConversation: (id: string, limit: number) => Promise<ConversationEntry[] | null>;
}

export const META_MCP_SERVER_NAME = 'claudoist';

export function createMetaServer(deps: MetaDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: META_MCP_SERVER_NAME,
    version: '1.0.0',
    instructions:
      '本应用的会话历史。用户说「之前聊过 / 看看其他对话 / 上次说到哪」时用这两个工具,' +
      '不要去猜文件路径。当前对话自己就在上下文里,不需要读。',
    tools: [
      tool(
        'list_conversations',
        '列出用户在本应用里的全部会话(标题/模型/时间)。current: true 的是当前这个',
        { limit: z.number().int().min(1).max(100).optional().describe('默认 30') },
        (a) =>
          Promise.resolve(
            json(deps.listConversations().slice(0, (a as { limit?: number }).limit ?? 30)),
          ),
      ),
      tool(
        'read_conversation',
        '读某个历史会话的正文(用户与 agent 的往来消息 + 工具名)。先 list_conversations 拿 id',
        {
          conversationId: z.string().describe('list_conversations 返回的 id'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe('最多返回几条,默认 40,取最近的'),
        },
        async (a) => {
          const p = a as { conversationId: string; limit?: number };
          const entries = await deps.readConversation(p.conversationId, p.limit ?? 40);
          if (entries === null) {
            return json({ error: '会话不存在或还没有正文(可能一条消息都没发过)' });
          }
          return json({ entries });
        },
      ),
    ],
  });
}

function json(v: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(v) }] };
}
