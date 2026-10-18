import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db';
import { createAgentStore } from '../src/agentStore';

/** 2026-10-18 用户:历史会话要能 rename / archive。归档只是收起,正文与索引都在。 */
describe('agentStore 改名 / 归档', () => {
  it('归档可取消;改名后标题跟着变;两者互不影响', () => {
    const store = createAgentStore(openDb(':memory:'));
    store.createConversation({
      id: 'c1',
      title: '新会话',
      model: 'opus',
      now: '2026-10-18T12:00:00Z',
    });
    expect(store.getConversation('c1')?.archived).toBe(false);

    store.setConversationArchived('c1', true);
    store.renameConversation('c1', '日期选择器');
    expect(store.getConversation('c1')).toMatchObject({ archived: true, title: '日期选择器' });
    expect(store.listConversations().map((c) => c.id)).toEqual(['c1']); // 列表照给,过滤在界面层

    store.setConversationArchived('c1', false);
    expect(store.getConversation('c1')?.archived).toBe(false);
  });
});
