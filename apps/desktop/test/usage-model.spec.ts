import { describe, expect, it } from 'vitest';
import {
  readAccount,
  readCachedUsage,
  readContribution,
  readSubscriptionUsage,
  readWindows,
} from '../src/main/agent/usageModel';

/**
 * 用量数据的翻译层。
 *
 * 这一层测的核心不是"字段能不能取出来",而是**畸形/缺失数据不会把面板打崩**:
 * 这些字段来自一个名字里就写着 `EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`
 * 的接口,而且运行时返回的键远多于类型声明的。任何一处 throw 都会让整页白掉。
 */

describe('账号信息', () => {
  it('已登录订阅账号:tokenSource 根本不存在,靠"有 email + firstParty"判定', () => {
    // 这就是实测到的形状 —— 只有 4 个键
    const a = readAccount(
      {
        email: 'someone@example.com',
        organization: "someone@example.com's Organization",
        subscriptionType: 'Claude Max',
        apiProvider: 'firstParty',
      },
      false,
    );
    expect(a.method).toBe('claude-ai');
    expect(a.planLabel).toBe('Claude Max'); // 已经是展示串,不要再拼 'Claude ' 前缀
  });

  it('未登录:tokenSource=none 且没有 email', () => {
    const a = readAccount({ tokenSource: 'none', apiProvider: 'firstParty' }, false);
    expect(a.method).toBe('logged-out');
    expect(a.email).toBeNull();
  });

  it('第三方 provider:不冒充 Claude 账号', () => {
    expect(readAccount({ apiProvider: 'bedrock' }, false).method).toBe('third-party');
  });

  it('拿不到任何数据也不抛', () => {
    expect(readAccount(null, true).method).toBe('unknown');
    expect(readAccount(undefined, true).apiKeyInEnv).toBe(true);
    expect(readAccount('不是对象', false).method).toBe('unknown');
  });
});

describe('额度窗口', () => {
  it('取 five_hour 与 seven_day', () => {
    const w = readWindows({
      five_hour: { utilization: 3, resets_at: '2026-08-12T18:09:59.643869+00:00' },
      seven_day: { utilization: 77, resets_at: '2026-08-13T11:59:59+00:00' },
    });
    expect(w.map((x) => x.id)).toEqual(['five_hour', 'seven_day']);
    expect(w[0]!.utilization).toBe(3);
    expect(w[1]!.resetsAt).toBe('2026-08-13T11:59:59+00:00');
  });

  it('"Weekly Fable" 来自 model_scoped,不是 seven_day_opus', () => {
    const w = readWindows({
      seven_day_opus: null,
      seven_day_sonnet: null,
      model_scoped: [{ display_name: 'Fable', utilization: 100, resets_at: null }],
    });
    expect(w).toHaveLength(1);
    expect(w[0]!.label).toBe('Weekly · Fable');
    expect(w[0]!.utilization).toBe(100);
  });

  it('model_scoped 缺席时回落到 limits[](离线缓存里只有它;字段叫 percent)', () => {
    const w = readWindows({
      limits: [
        { kind: 'session', percent: 3 },
        {
          kind: 'weekly_scoped',
          percent: 100,
          resets_at: 'x',
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    });
    expect(w.map((x) => x.label)).toEqual(['Weekly · Fable']);
  });

  it('utilization 越界一律夹到 0–100(服务端给过 >100)', () => {
    expect(readWindows({ five_hour: { utilization: 137 } })[0]!.utilization).toBe(100);
    expect(readWindows({ five_hour: { utilization: -5 } })[0]!.utilization).toBe(0);
  });

  it('代号桶(tangelo / nimbus_quill …)一律忽略 —— 拿不到显示名就别猜产品名', () => {
    const w = readWindows({
      tangelo: { utilization: 40 },
      nimbus_quill: { utilization: 0 },
      cinder_cove: null,
      seven_day_omelette: { utilization: 12 },
    });
    expect(w).toEqual([]);
  });

  it('畸形数据只是少一行,不抛', () => {
    expect(readWindows(null)).toEqual([]);
    expect(readWindows({ five_hour: 'nope', seven_day: { utilization: '77' } })).toEqual([]);
    expect(readWindows({ model_scoped: [{ display_name: 'X' }, null, 42] })).toEqual([]);
    expect(readWindows({ limits: 'not-an-array' })).toEqual([]);
  });
});

describe('订阅额度可用性', () => {
  it('rate_limits_available=false → 不适用,而不是显示 0%', () => {
    const u = readSubscriptionUsage({ rate_limits_available: false, rate_limits: null });
    expect(u.available).toBe(false);
    expect(u.windows).toEqual([]);
    expect(u.unavailableReason).toContain('API key');
  });

  it('整个接口不存在(SDK 升级后改名/移除)→ 降级而不是崩', () => {
    const u = readSubscriptionUsage(null);
    expect(u.available).toBe(false);
    expect(u.unavailableReason).toContain('用量接口');
  });

  it('extra_usage 未开通时不渲染', () => {
    expect(
      readSubscriptionUsage({
        rate_limits_available: true,
        rate_limits: { extra_usage: { is_enabled: false, utilization: null } },
      }).extraUsage,
    ).toBeNull();
  });

  it('本地缓存走同一套解析', () => {
    const u = readCachedUsage({ seven_day: { utilization: 76, resets_at: 'x' } });
    expect(u.available).toBe(true);
    expect(u.windows[0]!.utilization).toBe(76);
  });

  it('本地缓存为空 → 明说没有,而不是假装 available', () => {
    expect(readCachedUsage(null).available).toBe(false);
  });
});

describe('贡献分析', () => {
  const raw = {
    behaviors: {
      day: {
        request_count: 1025,
        session_count: 18,
        behaviors: [
          { key: 'long_context', pct: 89, count: 585 },
          { key: 'subagent_heavy', pct: 99, count: 1 },
          { key: 'cron', pct: 99, count: 1 },
        ],
        agents: [{ name: 'workflow-subagent', pct: 12 }],
        skills: [{ name: 'gtd-clarify', pct: 4 }],
        plugins: [],
        mcp_servers: [{ name: 'gtd', pct: 7 }],
      },
      week: { request_count: 6358, session_count: 22, behaviors: [], agents: [] },
    },
  };

  it('按 pct 降序,归因分组齐全', () => {
    const c = readContribution(raw)!;
    expect(c.day!.behaviors.map((b) => b.pct)).toEqual([99, 99, 89]);
    expect(c.day!.requestCount).toBe(1025);
    expect(c.day!.attributions.map((a) => `${a.kind}:${a.name}`)).toEqual([
      'agent:workflow-subagent',
      'mcp:gtd',
      'skill:gtd-clarify',
    ]);
  });

  it('cron 的文案是"活跃 8 小时以上",**不是**定时任务', () => {
    const c = readContribution(raw)!;
    const cron = c.day!.behaviors.find((b) => b.key === 'cron')!;
    expect(cron.headline).toContain('8 小时');
    expect(cron.headline).not.toContain('定时');
    expect(cron.detail).toContain('与定时任务无关');
  });

  it('未知的新 key 也能显示,不至于漏掉一整行', () => {
    const c = readContribution({
      behaviors: { day: { behaviors: [{ key: 'brand_new_thing', pct: 42, count: 3 }] } },
    })!;
    expect(c.day!.behaviors[0]!.headline).toContain('brand_new_thing');
  });

  it('behaviors 缺席 → null(UI 显示占位而不是空白)', () => {
    expect(readContribution({ behaviors: null })).toBeNull();
    expect(readContribution(null)).toBeNull();
    expect(readContribution({})).toBeNull();
  });
});
