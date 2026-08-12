import type {
  AccountVM,
  AttributionRowVM,
  BehaviorRowVM,
  ContributionVM,
  ContributionWindowVM,
  LimitWindowVM,
  SubscriptionUsageVM,
} from '../../shared/viewModels';

/**
 * SDK 原始返回 → ViewModel 的**纯函数**翻译层(零 I/O、不 import electron,故可单测)。
 *
 * 为什么值得单独一层:这些数据有三个讨厌的性质,散在渲染层处理必然出错。
 *
 * 1. **运行时字段远多于 sdk.d.ts 声明的**。实测 `rate_limits` 里还有 `limits[]`、`spend`、
 *    以及 `tangelo` / `nimbus_quill` / `cinder_cove` 这类代号桶(多为 null)。它们**没有**
 *    类型声明,也**拿不到显示名** —— 一律忽略,别猜产品名。
 * 2. **同一个概念有两个来源、两种形态**。`account.subscriptionType` 已经是展示串
 *    ('Claude Max'),而 `usage.subscription_type` 是原始枚举('max')。混用必错。
 * 3. **声明了的字段也可能整个消失**。`model_scoped` 由远端开关控制,关掉就没有;
 *    离线缓存里则根本不存在这个字段,只有原始的 `limits[]`。
 *
 * 所以这里全程 `unknown` + 逐字段 typeof 校验,**任何形状不符一律降级,绝不 throw**。
 * 面板宁可少显示一行,也不能因为服务端改了个字段就整页崩掉。
 */

// ------------------------------------------------------------------ 取值小工具

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 服务端给过 utilization: 100,也可能给 >100 —— 一律夹到 0–100。 */
const pct = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.min(100, n));
};

// ------------------------------------------------------------------ 账号

/**
 * 认证方式。**判据是"字段的有无组合",不是某个单一字段** ——
 * 实测已登录订阅账号的 account 只有 4 个键:{email, organization, subscriptionType, apiProvider},
 * `tokenSource` / `apiKeySource` **根本不存在**(CLI 在 claude.ai OAuth 分支里故意不写)。
 * 未登录时反过来:{tokenSource: 'none', apiProvider: 'firstParty'},没有 email。
 */
export function readAccount(raw: unknown, apiKeyInEnv: boolean): AccountVM {
  const a = obj(raw);
  const provider = str(a?.['apiProvider']);
  const email = str(a?.['email']);
  const organization = str(a?.['organization']);
  const planLabel = str(a?.['subscriptionType']);
  const tokenSource = str(a?.['tokenSource']);
  const apiKeySource = str(a?.['apiKeySource']);

  let method: AccountVM['method'] = 'unknown';
  let methodLabel = '未知';
  if (provider !== null && provider !== 'firstParty') {
    method = 'third-party';
    methodLabel = `第三方(${provider})`;
  } else if (tokenSource === 'none' && email === null) {
    method = 'logged-out';
    methodLabel = '未登录';
  } else if (apiKeySource !== null && apiKeySource !== 'none') {
    method = 'api-key';
    methodLabel = `API key(${apiKeySource})`;
  } else if (tokenSource !== null && tokenSource !== 'claude.ai') {
    method = 'oauth-token';
    methodLabel = `OAuth token(${tokenSource})`;
  } else if (email !== null) {
    method = 'claude-ai';
    methodLabel = 'Claude 账号';
  }
  return { method, methodLabel, email, organization, planLabel, apiKeyInEnv };
}

// ------------------------------------------------------------------ 额度窗口

const WINDOW_LABEL: Record<string, string> = {
  five_hour: 'Session(5 小时)',
  seven_day: 'Weekly(7 天)',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_oauth_apps: 'Weekly · 第三方应用',
};

const window = (id: string, label: string, raw: unknown): LimitWindowVM | null => {
  const w = obj(raw);
  if (w === null) return null;
  const u = pct(w['utilization']);
  if (u === null) return null;
  return { id, label, utilization: u, resetsAt: str(w['resets_at']) };
};

/**
 * 模型级周窗口("Weekly Fable" 那一行)。
 *
 * 优先 `model_scoped`(SDK 从 limits[] 投影出来的,带 display_name);它**可能整个不存在**
 * ——那个投影受远端开关控制,而离线缓存里压根没有这个字段。所以退回原始 `limits[]`,
 * 筛 `kind === 'weekly_scoped'`(注意那边的百分比字段叫 `percent` 不是 `utilization`)。
 *
 * 只读 limits[] 的四个字段:kind / percent / resets_at / scope.model.display_name ——
 * 它们是 CLI 自己缓存 schema 里显式校验过的,属于稳定契约;其余溢出字段
 * (severity / is_active / spend)一概不碰,颜色我们自己按百分比算。
 */
export function readModelScoped(rateLimits: Record<string, unknown> | null): LimitWindowVM[] {
  if (rateLimits === null) return [];
  const out: LimitWindowVM[] = [];
  const scoped = rateLimits['model_scoped'];
  if (Array.isArray(scoped)) {
    for (const item of scoped) {
      const s = obj(item);
      const name = str(s?.['display_name']);
      const u = pct(s?.['utilization']);
      if (name === null || u === null) continue;
      out.push({
        id: `weekly-model-${name}`,
        label: `Weekly · ${name}`,
        utilization: u,
        resetsAt: str(s?.['resets_at']),
      });
    }
    if (out.length > 0) return out;
  }
  const limits = rateLimits['limits'];
  if (!Array.isArray(limits)) return [];
  for (const item of limits) {
    const l = obj(item);
    if (str(l?.['kind']) !== 'weekly_scoped') continue;
    const name = str(obj(obj(l?.['scope'])?.['model'])?.['display_name']);
    const u = pct(l?.['percent']);
    if (name === null || u === null) continue;
    out.push({
      id: `weekly-model-${name}`,
      label: `Weekly · ${name}`,
      utilization: u,
      resetsAt: str(l?.['resets_at']),
    });
  }
  return out;
}

/** rate_limits(SDK 响应或本地缓存的 utilization 块)→ 进度条列表。 */
export function readWindows(rateLimits: unknown): LimitWindowVM[] {
  const r = obj(rateLimits);
  if (r === null) return [];
  const out: LimitWindowVM[] = [];
  for (const key of ['five_hour', 'seven_day'] as const) {
    const w = window(key, WINDOW_LABEL[key]!, r[key]);
    if (w !== null) out.push(w);
  }
  out.push(...readModelScoped(r));
  // 老的按模型周窗口:本机实测为 null,但别的账号形态可能有
  for (const key of ['seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'] as const) {
    const w = window(key, WINDOW_LABEL[key]!, r[key]);
    if (w !== null) out.push(w);
  }
  return out;
}

export function readExtraUsage(rateLimits: unknown): SubscriptionUsageVM['extraUsage'] {
  const e = obj(obj(rateLimits)?.['extra_usage']);
  if (e === null || e['is_enabled'] !== true) return null;
  return {
    utilization: pct(e['utilization']),
    usedCredits: num(e['used_credits']),
    monthlyLimit: num(e['monthly_limit']),
    currency: str(e['currency']),
  };
}

// ------------------------------------------------------------------ 贡献分析

/**
 * ⚠ `cron` 与定时任务**毫无关系** —— CLI 里这条的原文是
 * "% of your usage came from sessions active for 8+ hours"。按 key 名直译成"定时任务"
 * 是这份数据最容易犯、也最难被发现的错。
 */
const BEHAVIOR_COPY: Record<string, { headline: (p: number) => string; detail: string }> = {
  subagent_heavy: {
    headline: (p) => `${String(p)}% 的用量来自 subagent 密集的会话`,
    detail:
      '这类会话里超过一半的花费(或至少 3 次调用)发生在子代理上,而子代理各自带一份完整上下文,成本按份数叠加。' +
      '本应用不提供 Task/Agent 工具,理应为 0 —— 显示非 0 说明这台机器上你自己用 Claude Code 的量也被算进来了。',
  },
  cron: {
    headline: (p) => `${String(p)}% 的用量来自持续活跃 8 小时以上的会话`,
    detail:
      '(这一项与定时任务无关,尽管它的内部代号叫 cron。)一条会话开一整天,上下文只增不减,' +
      '后面每一轮都在为前面所有内容重复付费。本应用是长驻会话,尤其容易踩到 —— 处理完一批事就新开一条。',
  },
  long_context: {
    headline: (p) => `${String(p)}% 的用量发生在 15 万 token 以上的上下文里`,
    detail:
      '上下文越长,每一轮的输入计费越高。本应用把 GTD 状态快照注进 system prompt、又允许读附件,' +
      '很容易堆上去 —— 收窄注入的快照、附件按需读而不是一次全塞,是最直接的降法。',
  },
  cache_miss: {
    headline: (p) => `${String(p)}% 的用量撞上了 10 万 token 以上的缓存未命中`,
    detail:
      'prompt 缓存约 5 分钟过期。会话前缀(system prompt、CLAUDE.md、工具清单)一旦变化或太久没说话,' +
      '整段就要按原价重算。别频繁重建会话,也别每轮都改注入的状态快照 —— 前缀稳住,缓存才吃得上。',
  },
  high_parallel: {
    headline: (p) => `${String(p)}% 的用量发生在 4 个以上会话同时跑的时候`,
    detail:
      '并行会话共享同一份周额度,互相挤占。本应用同一时刻只维持一条会话,' +
      '所以这一条通常来自你同时开着的 Claude Code 终端窗口。',
  },
};

const attributions = (w: Record<string, unknown>): AttributionRowVM[] => {
  const out: AttributionRowVM[] = [];
  const groups: [string, AttributionRowVM['kind']][] = [
    ['agents', 'agent'],
    ['skills', 'skill'],
    ['mcp_servers', 'mcp'],
    ['plugins', 'plugin'],
  ];
  for (const [key, kind] of groups) {
    const arr = w[key];
    if (!Array.isArray(arr)) continue;
    // CLI 自己也只展示前 8 条;这四个数组没有 10% 下限过滤
    for (const item of arr.slice(0, 8)) {
      const i = obj(item);
      const name = str(i?.['name']);
      const p = pct(i?.['pct']);
      if (name === null || p === null) continue;
      out.push({ kind, name, pct: p });
    }
  }
  return out;
};

function contributionWindow(raw: unknown): ContributionWindowVM | null {
  const w = obj(raw);
  if (w === null) return null;
  const rows: BehaviorRowVM[] = [];
  const arr = w['behaviors'];
  if (Array.isArray(arr)) {
    for (const item of arr) {
      const b = obj(item);
      const key = str(b?.['key']);
      const p = pct(b?.['pct']);
      if (key === null || p === null) continue;
      const copy = BEHAVIOR_COPY[key];
      rows.push({
        key,
        pct: p,
        count: num(b?.['count']) ?? 0,
        headline: copy ? copy.headline(p) : `${String(p)}% 的用量具有特征「${key}」`,
        detail: copy ? copy.detail : '',
      });
    }
  }
  return {
    requestCount: num(w['request_count']) ?? 0,
    sessionCount: num(w['session_count']) ?? 0,
    behaviors: rows.sort((a, b) => b.pct - a.pct),
    attributions: attributions(w).sort((a, b) => b.pct - a.pct),
  };
}

export function readContribution(usage: unknown): ContributionVM | null {
  const b = obj(obj(usage)?.['behaviors']);
  if (b === null) return null;
  const day = contributionWindow(b['day']);
  const week = contributionWindow(b['week']);
  if (day === null && week === null) return null;
  return { day, week };
}

// ------------------------------------------------------------------ 组装

export function readSubscriptionUsage(usage: unknown): SubscriptionUsageVM {
  const u = obj(usage);
  if (u === null) {
    return {
      available: false,
      unavailableReason: '当前 SDK 版本没有提供用量接口',
      windows: [],
      extraUsage: null,
    };
  }
  if (u['rate_limits_available'] !== true) {
    return {
      available: false,
      unavailableReason: '当前认证方式(API key / 第三方 provider)不适用 Claude 订阅额度',
      windows: [],
      extraUsage: null,
    };
  }
  const windows = readWindows(u['rate_limits']);
  return {
    available: true,
    unavailableReason: null,
    windows,
    extraUsage: readExtraUsage(u['rate_limits']),
  };
}

/** 本地缓存(~/.claude.json 的 cachedUsageUtilization.utilization)→ 同一套 VM。 */
export function readCachedUsage(utilization: unknown): SubscriptionUsageVM {
  const windows = readWindows(utilization);
  if (windows.length === 0) {
    return {
      available: false,
      unavailableReason: '本机缓存里没有可用的额度数据',
      windows: [],
      extraUsage: null,
    };
  }
  return {
    available: true,
    unavailableReason: null,
    windows,
    extraUsage: readExtraUsage(utilization),
  };
}
