import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db';
import { createSettingsStore } from '../src/settings';

/** 应用设置 KV(M6c-2):非领域配置,走 schema 既有的 settings 表。 */
describe('settings KV 存储', () => {
  it('get 缺失键返回 null;set 后可读回;同键 set 覆盖', () => {
    const s = createSettingsStore(openDb(':memory:'));
    expect(s.get('nope')).toBeNull();
    s.set('google.shownCalendarIds', ['a@x', 'b@y']);
    expect(s.get<string[]>('google.shownCalendarIds')).toEqual(['a@x', 'b@y']);
    s.set('google.shownCalendarIds', []);
    expect(s.get<string[]>('google.shownCalendarIds')).toEqual([]);
  });

  it('支持任意 JSON 值;delete 后回到 null', () => {
    const s = createSettingsStore(openDb(':memory:'));
    s.set('obj', { a: 1, b: { c: true } });
    expect(s.get<{ a: number; b: { c: boolean } }>('obj')).toEqual({ a: 1, b: { c: true } });
    s.set('flag', false);
    // 注意 false 是合法值,不能被 ?? 误当成"未设置"
    expect(s.get<boolean>('flag')).toBe(false);
    s.delete('obj');
    expect(s.get('obj')).toBeNull();
  });

  it('值被手工改坏 → 返回 null 而不是抛(不让应用起不来)', () => {
    const db = openDb(':memory:');
    const s = createSettingsStore(db);
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('broken', '{not json')").run();
    expect(s.get('broken')).toBeNull();
  });
});

describe('has():区分「没设过」与「显式设成 null」', () => {
  /**
   * 2026-08-13 用户实测踩到的 bug:护栏怎么调、关掉窗口都变回默认值。
   * 根因是 `get(k) ?? 默认值` —— `get` 缺键返回 `null`,而 `null` 本身也是一个**有意义的值**
   * (护栏的"不限"就是 null),两者被 `??` 混为一谈。只有 `has()` 能把它们分开。
   */
  it('缺键 has=false;存了 null 之后 has=true 而 get 仍是 null', () => {
    const db = openDb(':memory:');
    const s = createSettingsStore(db);
    expect(s.has('k')).toBe(false);
    expect(s.get('k')).toBeNull();

    s.set('k', null);
    expect(s.has('k')).toBe(true);
    expect(s.get('k')).toBeNull();

    // 这正是修复前会出错的地方:两种情况 get 都给 null
    const readWithFallback = (key: string, fallback: number): number | null =>
      s.has(key) ? s.get<number | null>(key) : fallback;
    expect(readWithFallback('k', 40)).toBeNull(); // 用户选的"不限"被保住
    expect(readWithFallback('never-set', 40)).toBe(40); // 没设过才用默认
  });

  it('delete 之后 has 回到 false', () => {
    const db = openDb(':memory:');
    const s = createSettingsStore(db);
    s.set('k', 1);
    expect(s.has('k')).toBe(true);
    s.delete('k');
    expect(s.has('k')).toBe(false);
  });
});
