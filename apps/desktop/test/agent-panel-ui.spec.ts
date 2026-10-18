import { describe, expect, it } from 'vitest';
import {
  cacheTooltip,
  cacheWindow,
  idleLabel,
  recordFromUsage,
  type CacheRecord,
} from '../src/renderer/src/promptCache';
import { relTime } from '../src/renderer/src/relTime';

/**
 * 2026-10-18 用户:「我想要跟 vscode 差不多的 ui」—— 底栏的 Prompt 缓存计时(⏱ 57m)
 * 与历史列表的相对时间。
 */

const T0 = Date.parse('2026-10-18T12:00:00Z');
const MIN = 60_000;

describe('recordFromUsage', () => {
  it('写了 1h 缓存 → 1 小时;写了 5m 缓存 → 5 分钟', () => {
    expect(
      recordFromUsage(null, { cache_creation: { ephemeral_1h_input_tokens: 917 } }, T0),
    ).toEqual({ anchorAt: T0, ttlMs: 60 * MIN });
    expect(
      recordFromUsage(null, { cache_creation: { ephemeral_5m_input_tokens: 10 } }, T0),
    ).toEqual({ anchorAt: T0, ttlMs: 5 * MIN });
  });

  it('只读没写:沿用上一次的 TTL、从现在重新计时(命中会续期)', () => {
    const prev: CacheRecord = { anchorAt: T0, ttlMs: 60 * MIN };
    expect(recordFromUsage(prev, { cache_read_input_tokens: 5000 }, T0 + 10 * MIN)).toEqual({
      anchorAt: T0 + 10 * MIN,
      ttlMs: 60 * MIN,
    });
  });

  it('从没写过、又只读 → 说不准,不猜', () => {
    expect(recordFromUsage(null, { cache_read_input_tokens: 5000 }, T0)).toBeNull();
    expect(recordFromUsage(null, undefined, T0)).toBeNull();
  });
});

describe('cacheWindow', () => {
  const rec: CacheRecord = { anchorAt: T0, ttlMs: 60 * MIN };

  it('还热:剩余分钟向上取整(VSCode 的 57m)', () => {
    expect(cacheWindow(rec, T0 + 3 * MIN + 1)).toEqual({ kind: 'warm', minutesLeft: 57 });
  });

  it('过期 → cold,带闲置时长', () => {
    const w = cacheWindow(rec, T0 + 75 * MIN);
    expect(w).toEqual({ kind: 'cold', reason: 'expired', idleMs: 75 * MIN });
    expect(cacheTooltip(w)).toContain('1 小时 15 分');
  });

  it('压缩过 → cold;没有记录 → unknown(不显示)', () => {
    expect(cacheWindow({ compactedAt: T0 }, T0)).toEqual({ kind: 'cold', reason: 'compacted' });
    expect(cacheWindow(null, T0)).toEqual({ kind: 'unknown' });
  });

  it('idleLabel', () => {
    expect(idleLabel(12 * MIN)).toBe('12 分钟');
    expect(idleLabel(120 * MIN)).toBe('2 小时');
  });
});

describe('relTime', () => {
  const iso = new Date(T0).toISOString();
  it('刚刚 / 12m / 3h / 2d / 超过一周给日期', () => {
    expect(relTime(iso, T0 + 30_000)).toBe('刚刚');
    expect(relTime(iso, T0 + 12 * MIN)).toBe('12m');
    expect(relTime(iso, T0 + 3 * 60 * MIN)).toBe('3h');
    expect(relTime(iso, T0 + 2 * 24 * 60 * MIN)).toBe('2d');
    expect(relTime(iso, T0 + 10 * 24 * 60 * MIN)).toBe('10-18');
  });
});
