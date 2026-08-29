import type { MetaDeps } from '@gtd/agent-tools';
import { agentStore } from '../db';
import { transcript } from './conversations';

/**
 * 会话元数据工具的数据源(metaServer 的注入实现)。
 * 索引在 SQLite(conversations 表),正文在 SDK 的 transcript 文件 —— 复用
 * conversations.ts 的同一条读取路径,历史面板显示什么,agent 就能读到什么。
 */
export function buildMetaDeps(currentConversationId: string): MetaDeps {
  return {
    listConversations: () =>
      agentStore()
        .listConversations(100)
        .map((r) => ({
          id: r.id,
          title: r.title,
          model: r.model,
          createdAt: r.createdAt,
          lastMessageAt: r.lastMessageAt,
          current: r.id === currentConversationId,
        })),
    readConversation: async (id, limit) => {
      const row = agentStore().getConversation(id);
      if (!row || row.sdkSessionId === null) return null;
      try {
        const items = await transcript(row.sdkSessionId);
        // 取最近的 limit 条;单条文本截断,免得一整个长会话灌爆上下文
        return items.slice(-limit).map((it) => ({
          role: it.role,
          text: it.text.length > 1500 ? `${it.text.slice(0, 1500)}…(截断)` : it.text,
          tools: it.tools,
        }));
      } catch {
        return null;
      }
    },
  };
}
