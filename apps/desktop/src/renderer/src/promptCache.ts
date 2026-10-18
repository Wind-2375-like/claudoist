/**
 * Prompt 缓存还热不热(composer 底栏的「⏱ 57m」,2026-10-18 用户要求「跟 vscode 差不多的 ui」)。
 *
 * 每次请求都会把对话前缀写进 / 读出服务端缓存,缓存从**最后一次命中**起计时,过了 TTL
 * 就失效 —— 下一条消息得把整段对话重新缓存一遍:更慢,也更费额度。所以「还剩几分钟」
 * 对用户是有用的决策信息:快过期了,要接着聊就趁现在。
 *
 * TTL 从响应的 usage 里读:`cache_creation.ephemeral_1h_input_tokens > 0` 是 1 小时,
 * `ephemeral_5m_input_tokens > 0` 是 5 分钟(订阅登录实测是 1h)。只有读没有写的那一轮
 * 沿用上一次的 TTL;一次都没写过就说不准 —— 宁可不显示,也不猜。
 */

export type CacheRecord = { anchorAt: number; ttlMs: number } | { compactedAt: number };

export type CacheWindow =
  | { kind: 'unknown' }
  | { kind: 'warm'; minutesLeft: number }
  | { kind: 'cold'; reason: 'expired'; idleMs: number }
  | { kind: 'cold'; reason: 'compacted' };

const HOUR = 60 * 60_000;
const FIVE_MIN = 5 * 60_000;

interface UsageLike {
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

/** 一条 assistant 消息落定:按它的 usage 更新缓存记录 */
export function recordFromUsage(
  prev: CacheRecord | null,
  usage: unknown,
  now: number,
): CacheRecord | null {
  const u = (usage ?? {}) as UsageLike;
  const c = u.cache_creation;
  if ((c?.ephemeral_1h_input_tokens ?? 0) > 0) return { anchorAt: now, ttlMs: HOUR };
  if ((c?.ephemeral_5m_input_tokens ?? 0) > 0) return { anchorAt: now, ttlMs: FIVE_MIN };
  if ((u.cache_read_input_tokens ?? 0) > 0 && prev !== null && 'ttlMs' in prev) {
    return { anchorAt: now, ttlMs: prev.ttlMs };
  }
  return prev;
}

export function cacheWindow(rec: CacheRecord | null, now: number): CacheWindow {
  if (rec === null) return { kind: 'unknown' };
  if ('compactedAt' in rec) return { kind: 'cold', reason: 'compacted' };
  const left = rec.anchorAt + rec.ttlMs - now;
  if (left > 0) return { kind: 'warm', minutesLeft: Math.ceil(left / 60_000) };
  return { kind: 'cold', reason: 'expired', idleMs: now - rec.anchorAt };
}

export function idleLabel(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${String(min)} 分钟`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${String(h)} 小时` : `${String(h)} 小时 ${String(min % 60)} 分`;
}

export function cacheTooltip(w: CacheWindow): string {
  switch (w.kind) {
    case 'unknown':
      return '';
    case 'warm':
      return `Prompt 缓存还热着,约 ${String(w.minutesLeft)} 分钟后过期。过期后下一条消息要把整段对话重新缓存,更慢也更费额度。`;
    case 'cold':
      return w.reason === 'compacted'
        ? '对话刚被压缩,缓存不覆盖压缩后的内容 —— 下一条消息会重新缓存。'
        : `Prompt 缓存大概率已过期(闲置 ${idleLabel(w.idleMs)})。下一条消息会把整段对话重新缓存。`;
  }
}
