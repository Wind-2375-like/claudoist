import { describe, expect, it } from 'vitest';
import type { RepeatRule } from '../src/entities/task';
import {
  formatRepeat,
  nextOccurrence,
  nextOccurrences,
  normalizeRepeat,
  parseRepeatShorthand,
  repeatPresets,
  weekdayMaskOf,
} from '../src/rules/repeat';

/**
 * INV-36 循环推进引擎(D-37)。
 *
 * 用例表来自 M12 规格 §3.1(51 条,调研阶段已在独立脚本上实跑通过;这里钉进测试)。
 * 三条分水岭:
 * - M2:第 2 次推进从**原始锚点 31** 算(→ 03-31),不是从上次结果 28 算(→ 永久卡 28)
 * - C4:同样"2/28 完成、每月",completed 模式**有意漂移**到 03-28 —— 那是它的定义
 * - D4:每 3 天逾期补齐后**相位不丢**(锚 8/1 网格上的 8/13,不是"今天+3"的 8/15)
 */

const R = (over: Partial<RepeatRule> & { anchor: string }): RepeatRule => ({
  every: 1,
  unit: 'day',
  from: 'scheduled',
  weekdays: null,
  until: null,
  ...over,
});

// [规则, from, today, 期望] —— 名称前缀对应规格用例编号
const CASES: [string, RepeatRule, string, string, string | null][] = [
  // ---- 月(锚点夹取月末,不滚月不漂移)
  [
    'M1 锚1/31 第1次夹到2月末',
    R({ unit: 'month', anchor: '2026-01-31' }),
    '2026-01-31',
    '2026-01-31',
    '2026-02-28',
  ],
  [
    'M2 第2次从锚算回到31',
    R({ unit: 'month', anchor: '2026-01-31' }),
    '2026-02-28',
    '2026-02-28',
    '2026-03-31',
  ],
  [
    'M3 第3次',
    R({ unit: 'month', anchor: '2026-01-31' }),
    '2026-03-31',
    '2026-03-31',
    '2026-04-30',
  ],
  [
    'M4 第4次',
    R({ unit: 'month', anchor: '2026-01-31' }),
    '2026-04-30',
    '2026-04-30',
    '2026-05-31',
  ],
  [
    'M5 锚1/30 2月夹28',
    R({ unit: 'month', anchor: '2026-01-30' }),
    '2026-01-30',
    '2026-01-30',
    '2026-02-28',
  ],
  [
    'M6 锚1/30 3月回30',
    R({ unit: 'month', anchor: '2026-01-30' }),
    '2026-02-28',
    '2026-02-28',
    '2026-03-30',
  ],
  [
    'M7 每2月锚1/31',
    R({ unit: 'month', every: 2, anchor: '2026-01-31' }),
    '2026-01-31',
    '2026-01-31',
    '2026-03-31',
  ],
  [
    'M8 每月12日',
    R({ unit: 'month', anchor: '2026-08-12' }),
    '2026-08-12',
    '2026-08-12',
    '2026-09-12',
  ],
  ['M9 跨年', R({ unit: 'month', anchor: '2026-01-31' }), '2026-12-31', '2026-12-31', '2027-01-31'],
  [
    'M10 落后3期一次补齐',
    R({ unit: 'month', anchor: '2026-01-31' }),
    '2026-01-31',
    '2026-04-15',
    '2026-04-30',
  ],
  // ---- 年(闰日:平年夹 28,闰年回归 29)
  [
    'Y1 锚2/29 平年夹28',
    R({ unit: 'year', anchor: '2024-02-29' }),
    '2024-02-29',
    '2024-02-29',
    '2025-02-28',
  ],
  [
    'Y2 仍按29算',
    R({ unit: 'year', anchor: '2024-02-29' }),
    '2025-02-28',
    '2025-02-28',
    '2026-02-28',
  ],
  [
    'Y3 第4次回到2/29',
    R({ unit: 'year', anchor: '2024-02-29' }),
    '2027-02-28',
    '2027-02-28',
    '2028-02-29',
  ],
  [
    'Y4 每4年',
    R({ unit: 'year', every: 4, anchor: '2024-02-29' }),
    '2024-02-29',
    '2024-02-29',
    '2028-02-29',
  ],
  [
    'Y5 每年8月12日',
    R({ unit: 'year', anchor: '2026-08-12' }),
    '2026-08-12',
    '2026-08-12',
    '2027-08-12',
  ],
  [
    'Y6 落后到2027一次补齐',
    R({ unit: 'year', anchor: '2024-02-29' }),
    '2024-02-29',
    '2027-06-01',
    '2028-02-29',
  ],
  [
    'Y7 月步也按29夹',
    R({ unit: 'month', anchor: '2024-02-29' }),
    '2024-02-29',
    '2024-02-29',
    '2024-03-29',
  ],
  // ---- 天
  ['D1 每天', R({ anchor: '2026-08-12' }), '2026-08-12', '2026-08-12', '2026-08-13'],
  ['D2 每3天', R({ every: 3, anchor: '2026-08-12' }), '2026-08-12', '2026-08-12', '2026-08-15'],
  ['D3 过期11天补齐到明天', R({ anchor: '2026-08-01' }), '2026-08-01', '2026-08-12', '2026-08-13'],
  [
    'D4 每3天补齐保持相位',
    R({ every: 3, anchor: '2026-08-01' }),
    '2026-08-01',
    '2026-08-12',
    '2026-08-13',
  ],
  [
    'D5 提前完成(from在未来)',
    R({ anchor: '2026-08-12' }),
    '2026-09-01',
    '2026-08-12',
    '2026-09-02',
  ],
  ['D6 跨闰年2/28→2/29', R({ anchor: '2024-02-28' }), '2024-02-28', '2024-02-28', '2024-02-29'],
  ['D7 跨平年2/28→3/1', R({ anchor: '2026-02-28' }), '2026-02-28', '2026-02-28', '2026-03-01'],
  // ---- 周(掩码;2026-08-12 是周三)
  [
    'W1 每周三',
    R({ unit: 'week', weekdays: 8, anchor: '2026-08-12' }),
    '2026-08-12',
    '2026-08-12',
    '2026-08-19',
  ],
  [
    'W2 工作日周五→下周一',
    R({ unit: 'week', weekdays: 62, anchor: '2026-08-14' }),
    '2026-08-14',
    '2026-08-14',
    '2026-08-17',
  ],
  [
    'W3 工作日周一→周二',
    R({ unit: 'week', weekdays: 62, anchor: '2026-08-10' }),
    '2026-08-10',
    '2026-08-10',
    '2026-08-11',
  ],
  [
    'W4 工作日周日完成→周一',
    R({ unit: 'week', weekdays: 62, anchor: '2026-08-16' }),
    '2026-08-16',
    '2026-08-16',
    '2026-08-17',
  ],
  // W5–W7/W9:every≥2 + 多位掩码在 v1 写入侧被拒,算法层保留(WKST=Mon 块对齐)——
  // 将来放开"每 2 周的周一+周四"时这几条直接生效
  [
    'W5† 每2周Mon+Thu同块内',
    R({ unit: 'week', every: 2, weekdays: 18, anchor: '2026-08-10' }),
    '2026-08-10',
    '2026-08-10',
    '2026-08-13',
  ],
  [
    'W6† 每2周Mon+Thu跳过一周',
    R({ unit: 'week', every: 2, weekdays: 18, anchor: '2026-08-10' }),
    '2026-08-13',
    '2026-08-13',
    '2026-08-24',
  ],
  [
    'W7† 每2周过期补齐落对齐块',
    R({ unit: 'week', every: 2, weekdays: 18, anchor: '2026-08-10' }),
    '2026-08-10',
    '2026-09-02',
    '2026-09-07',
  ],
  [
    'W8 每周三跨年',
    R({ unit: 'week', weekdays: 8, anchor: '2026-12-30' }),
    '2026-12-30',
    '2026-12-30',
    '2027-01-06',
  ],
  [
    'W9† 每3周只选周日(WKST口径)',
    R({ unit: 'week', every: 3, weekdays: 1, anchor: '2026-08-12' }),
    '2026-08-12',
    '2026-08-12',
    '2026-08-16',
  ],
  [
    'W10 每2周掩码=anchor位',
    R({ unit: 'week', every: 2, weekdays: 8, anchor: '2026-08-12' }),
    '2026-08-12',
    '2026-08-12',
    '2026-08-26',
  ],
  // ---- Ends(inclusive)
  [
    'E1 until恰为下一期→放行',
    R({ anchor: '2026-08-12', until: '2026-08-13' }),
    '2026-08-12',
    '2026-08-12',
    '2026-08-13',
  ],
  [
    'E2 再推一期越过until',
    R({ anchor: '2026-08-12', until: '2026-08-13' }),
    '2026-08-13',
    '2026-08-13',
    null,
  ],
  [
    'E3 until落在格点之间',
    R({ every: 3, anchor: '2026-08-12', until: '2026-08-17' }),
    '2026-08-15',
    '2026-08-15',
    null,
  ],
  [
    'E4 until早于anchor→立即结束',
    R({ anchor: '2026-08-12', until: '2026-08-01' }),
    '2026-08-12',
    '2026-08-12',
    null,
  ],
  [
    'E5 until恰为anchor(仅此一次)',
    R({ unit: 'month', anchor: '2026-08-12', until: '2026-08-12' }),
    '2026-08-12',
    '2026-08-12',
    null,
  ],
  [
    'E6 补齐直接跨过until',
    R({ anchor: '2026-08-01', until: '2026-08-05' }),
    '2026-08-01',
    '2026-08-12',
    null,
  ],
  [
    'E7 until=闰日',
    R({ unit: 'year', anchor: '2024-02-29', until: '2028-02-29' }),
    '2027-02-28',
    '2027-02-28',
    '2028-02-29',
  ],
  // ---- 完成日推进(from = 完成当天;永不追赶、有意漂移)
  [
    'C1 完成日每天',
    R({ from: 'completed', anchor: '2026-08-01' }),
    '2026-08-20',
    '2026-08-20',
    '2026-08-21',
  ],
  [
    'C2 完成日每3天忽略锚网格',
    R({ from: 'completed', every: 3, anchor: '2026-08-01' }),
    '2026-08-20',
    '2026-08-20',
    '2026-08-23',
  ],
  [
    'C3 完成日每月1/31完成',
    R({ from: 'completed', unit: 'month', anchor: '2026-01-05' }),
    '2026-01-31',
    '2026-01-31',
    '2026-02-28',
  ],
  [
    'C4 完成日2/28完成→有意漂移28',
    R({ from: 'completed', unit: 'month', anchor: '2026-01-05' }),
    '2026-02-28',
    '2026-02-28',
    '2026-03-28',
  ],
  [
    'C5 完成日每年2/29完成',
    R({ from: 'completed', unit: 'year', anchor: '2024-01-05' }),
    '2024-02-29',
    '2024-02-29',
    '2025-02-28',
  ],
  [
    'C6 完成日工作日周五→周一',
    R({ from: 'completed', unit: 'week', weekdays: 62, anchor: '2026-08-10' }),
    '2026-08-14',
    '2026-08-14',
    '2026-08-17',
  ],
  [
    'C7 完成日每2周周三空出整周',
    R({ from: 'completed', unit: 'week', every: 2, weekdays: 8, anchor: '2026-08-12' }),
    '2026-08-12',
    '2026-08-12',
    '2026-08-26',
  ],
  [
    'C8 完成日迟完成不补齐',
    R({ from: 'completed', every: 3, anchor: '2026-08-01' }),
    '2026-09-30',
    '2026-09-30',
    '2026-10-03',
  ],
  [
    'C9 完成日until生效',
    R({ from: 'completed', anchor: '2026-08-01', until: '2026-08-20' }),
    '2026-08-20',
    '2026-08-20',
    null,
  ],
  // ---- 锚未在网格上
  [
    'X1 from不在网格(拖过期未重置锚)',
    R({ unit: 'month', anchor: '2026-08-12' }),
    '2026-08-20',
    '2026-08-20',
    '2026-09-12',
  ],
  [
    'X2 重置锚后同场景',
    R({ unit: 'month', anchor: '2026-08-20' }),
    '2026-08-20',
    '2026-08-20',
    '2026-09-20',
  ],
];

describe('INV-36.4 nextOccurrence:51 条推进用例', () => {
  for (const [name, rule, from, today, want] of CASES) {
    it(name, () => {
      expect(nextOccurrence(rule, from, today)).toBe(want);
    });
  }

  it('锚 1/31 连推 26 期:不漂移、认闰年(2028-02-29)', () => {
    const rule = R({ unit: 'month', anchor: '2026-01-31' });
    let cur = '2026-01-31';
    const seen: string[] = [];
    for (let i = 0; i < 26; i += 1) {
      const d = nextOccurrence(rule, cur, cur);
      if (d === null) throw new Error('不该结束');
      seen.push(d);
      cur = d;
    }
    expect(seen.slice(0, 4)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    expect(seen).toContain('2028-02-29'); // 闰年回归
    expect(
      seen.filter(
        (d) =>
          d.endsWith('-28') &&
          !d.startsWith('2026-02') &&
          !d.startsWith('2027-02') &&
          !d.startsWith('2028-02'),
      ),
    ).toEqual([]);
  });
});

describe('INV-36.4 守卫:算不出来抛 RangeError,绝不返回 null', () => {
  const ok = R({ anchor: '2026-08-12' });
  it('from 格式非法', () => {
    expect(() => nextOccurrence(ok, '2026-1-5', '2026-08-12')).toThrow(RangeError);
  });
  it('from 日期不存在', () => {
    expect(() => nextOccurrence(ok, '2026-02-30', '2026-08-12')).toThrow(RangeError);
  });
  it('every=0', () => {
    expect(() =>
      nextOccurrence(R({ every: 0, anchor: '2026-08-12' }), '2026-08-12', '2026-08-12'),
    ).toThrow(RangeError);
  });
  it('weekdays=0', () => {
    expect(() =>
      nextOccurrence(
        R({ unit: 'week', weekdays: 0, anchor: '2026-08-12' }),
        '2026-08-12',
        '2026-08-12',
      ),
    ).toThrow(RangeError);
  });
  it('unit=week 而 weekdays=null(规则损坏)', () => {
    expect(() =>
      nextOccurrence(
        R({ unit: 'week', weekdays: null, anchor: '2026-08-12' }),
        '2026-08-12',
        '2026-08-12',
      ),
    ).toThrow(RangeError);
  });
});

describe('INV-36.2 normalizeRepeat:唯一表示', () => {
  it('week 缺省 weekdays = 取 anchor 那天(2026-08-12 = 周三 = 位 8)', () => {
    const r = normalizeRepeat({ unit: 'week' }, '2026-08-12');
    expect(r).toMatchObject({
      unit: 'week',
      weekdays: 8,
      every: 1,
      from: 'scheduled',
      until: null,
      anchor: '2026-08-12',
    });
  });
  it('every≥2 且 week:掩码必须恰为 anchor 那一位 —— 多位被拒(v1 写入侧收紧,裁决 D)', () => {
    const r = normalizeRepeat({ unit: 'week', every: 2, weekdays: ['mo', 'th'] }, '2026-08-10');
    expect(r).toHaveProperty('error');
  });
  it('every≥2 且 week:恰为 anchor 位则放行(W10 形态)', () => {
    const r = normalizeRepeat({ unit: 'week', every: 2, weekdays: ['we'] }, '2026-08-12');
    expect(r).toMatchObject({ weekdays: 8, every: 2 });
  });
  it('非 week 给星期列表被拒', () => {
    expect(normalizeRepeat({ unit: 'day', weekdays: ['we'] }, '2026-08-12')).toHaveProperty(
      'error',
    );
  });
  it('every 越界被拒(0 / 1000 / 小数)', () => {
    expect(normalizeRepeat({ unit: 'day', every: 0 }, '2026-08-12')).toHaveProperty('error');
    expect(normalizeRepeat({ unit: 'day', every: 1000 }, '2026-08-12')).toHaveProperty('error');
    expect(normalizeRepeat({ unit: 'day', every: 1.5 }, '2026-08-12')).toHaveProperty('error');
  });
  it('until 早于 anchor 被拒(一次都不会发生)', () => {
    expect(normalizeRepeat({ unit: 'day', until: '2026-08-01' }, '2026-08-12')).toHaveProperty(
      'error',
    );
  });
  it('from=completed 保留星期集合(basis 决定起点,weekdays 决定落点,两者正交 —— 裁决 E)', () => {
    const r = normalizeRepeat(
      { unit: 'week', weekdays: ['mo', 'tu', 'we', 'th', 'fr'], from: 'completed' },
      '2026-08-10',
    );
    expect(r).toMatchObject({ weekdays: 62, from: 'completed' });
  });
});

describe('formatRepeat / repeatPresets / parseRepeatShorthand / weekdayMaskOf', () => {
  it('文案', () => {
    expect(formatRepeat(R({ anchor: '2026-08-12' })).short).toBe('每天');
    expect(formatRepeat(R({ every: 3, anchor: '2026-08-12' })).short).toBe('每 3 天');
    expect(formatRepeat(R({ unit: 'week', weekdays: 8, anchor: '2026-08-12' })).short).toBe(
      '每周三',
    );
    expect(formatRepeat(R({ unit: 'week', weekdays: 62, anchor: '2026-08-10' })).short).toBe(
      '每个工作日',
    );
    expect(formatRepeat(R({ unit: 'month', anchor: '2026-08-12' })).short).toBe('每月 12 日');
    expect(formatRepeat(R({ unit: 'year', anchor: '2026-08-12' })).short).toBe('每年 8 月 12 日');
    expect(
      formatRepeat(
        R({
          unit: 'week',
          weekdays: 8,
          anchor: '2026-08-12',
          from: 'completed',
          until: '2026-12-31',
        }),
      ).long,
    ).toBe('每周三 · 按完成日推进 · 到 2026-12-31 为止');
  });
  it('预设从 anchor 现算(2026-08-12 周三)', () => {
    const labels = repeatPresets('2026-08-12').map((p) => p.label);
    expect(labels).toEqual(['每天', '每周三', '每个工作日', '每月 12 日', '每年 8 月 12 日']);
  });
  it('CLI 速写文法(三载体共用,INV-36.13)', () => {
    expect(parseRepeatShorthand('daily')).toEqual({ unit: 'day' });
    expect(parseRepeatShorthand('weekday')).toEqual({
      unit: 'week',
      weekdays: ['mo', 'tu', 'we', 'th', 'fr'],
    });
    expect(parseRepeatShorthand('weekly:wed')).toEqual({ unit: 'week', weekdays: ['we'] });
    expect(parseRepeatShorthand('weekly:mon,wed,fri')).toEqual({
      unit: 'week',
      weekdays: ['mo', 'we', 'fr'],
    });
    expect(parseRepeatShorthand('every 2 weeks')).toEqual({ unit: 'week', every: 2 });
    expect(parseRepeatShorthand('EVERY 10 Days')).toEqual({ unit: 'day', every: 10 });
    expect(parseRepeatShorthand('fortnightly')).toHaveProperty('error');
    expect(parseRepeatShorthand('weekly:xx')).toHaveProperty('error');
    expect(parseRepeatShorthand('every 2 fortnights')).toHaveProperty('error');
  });
  it('weekdayMaskOf', () => {
    expect(weekdayMaskOf('2026-08-12')).toBe(8); // 周三
    expect(weekdayMaskOf('2026-08-16')).toBe(1); // 周日
    expect(weekdayMaskOf('2026-08-15')).toBe(64); // 周六
  });
  it('nextOccurrences 连推 3 次(预览)', () => {
    expect(
      nextOccurrences(
        R({ unit: 'week', weekdays: 8, anchor: '2026-08-12' }),
        '2026-08-12',
        '2026-08-12',
        3,
      ),
    ).toEqual(['2026-08-19', '2026-08-26', '2026-09-02']);
    // until 截断
    expect(
      nextOccurrences(
        R({ anchor: '2026-08-12', until: '2026-08-14' }),
        '2026-08-12',
        '2026-08-12',
        5,
      ),
    ).toEqual(['2026-08-13', '2026-08-14']);
  });
});
