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
