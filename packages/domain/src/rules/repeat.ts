import type { IsoDate } from '../entities/common';
import type { RepeatFrom, RepeatRule, RepeatUnit } from '../entities/task';
import { isValidIsoDate } from './dates';

/**
 * 循环推进引擎(D-37/INV-36)。三个入口(UI / CLI / agent)共用的单一口径(INV-36.13):
 * 解析(normalizeRepeat / parseRepeatShorthand)、推进(nextOccurrence)、格式化
 * (formatRepeat)、预设(repeatPresets)全部只在这里实现一份,渲染层经 IPC 拿结果。
 *
 * ## 为什么零 `Date` 对象(INV-36.4)
 *
 * 全部用 epoch-day 纯整数换算 + `(y,m,d)` 三元组算术。`new Date()` / `toISOString()`
 * 一次都不出现 → M4 那类 UTC 位移在这里**结构上不可能发生**。月推进尤其不能借道
 * `setUTCMonth`:JS 会把 2 月 31 日溢出成 3 月 3 日 —— "每月最后一天交房租"就变成
 * 3 月 3 日交。正确做法是月数从锚点加、日从锚点日**夹取到月末**(clamp,不滚月)。
 *
 * ## 为什么必须从 anchor 数格子,而不是从上次结果推
 *
 * 锚 1/31 的月循环:从锚点算 → 02-28 → **03-31** → 04-30 → 05-31(2 月夹取,3 月回归);
 * 从上次结果算 → 02-28 → 03-28 → **永久卡在 28 号**,而且用户完全看不出是什么时候丢的。
 * 闰日同理:锚 2024-02-29 的年循环在 2028 年正确回到 2/29。
 */

// ------------------------------------------------------------- epoch-day 算术

/** Howard Hinnant 的 civil 日历算法:(y,m,d) → 1970-01-01 起的天数。纯整数,无 Date。 */
function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(e: number): { y: number; m: number; d: number } {
  e += 719468;
  const era = Math.floor(e / 146097);
  const doe = e - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

function parseIso(s: IsoDate, what: string): { y: number; m: number; d: number; e: number } {
  // 算不出来**绝不返回 null**(null 只有一个含义:系列已结束)—— 非法入参必须炸
  if (!isValidIsoDate(s)) throw new RangeError(`循环推进遇到非法日期(${what}): ${s}`);
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return { y, m, d, e: daysFromCivil(y, m, d) };
}

const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const isoOf = (y: number, m: number, d: number): IsoDate =>
  `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
const isoOfEpoch = (e: number): IsoDate => {
  const { y, m, d } = civilFromDays(e);
  return isoOf(y, m, d);
};

/** epoch-day → 星期(0=周日 … 6=周六)。epoch 0 = 1970-01-01 = 周四(=4)。 */
const weekdayOf = (e: number): number => ((e % 7) + 11) % 7;

const daysInMonth = (y: number, m: number): number =>
  daysFromCivil(y, m + 1, 1) - daysFromCivil(y, m, 1);

/** 该日期所在周的周一(WKST=Mon,RFC 5545 默认;"Mon–Fri" 的直觉也是周一开头)。 */
const mondayOf = (e: number): number => e - ((weekdayOf(e) + 6) % 7);

/** 某 ISO 日期的星期位(1<<weekday)。写入侧"掩码必须=计划日那一位"的校验用。 */
export function weekdayMaskOf(iso: IsoDate): number {
  return 1 << weekdayOf(parseIso(iso, 'date').e);
}

/** b - a 的天数(完成生成下一次时,提醒/子任务日期的整体平移量)。 */
export function daysBetweenIso(a: IsoDate, b: IsoDate): number {
  return parseIso(b, 'to').e - parseIso(a, 'from').e;
}

// ------------------------------------------------------------------- 推进

/**
 * 下一次发生日。**返回 null 当且仅当越过 `until`(inclusive)= 系列结束,仅此一个含义**;
 * 任何算不出来的情形(非法日期 / every 越界 / weekdays 越界)抛 `RangeError`。
 *
 * @param from  'scheduled' 模式 = 被完成那一期的 scheduledDate;'completed' 模式 = 完成当天
 * @param today 今天(**必须显式传入** —— 纯函数不许问时钟)
 */
export function nextOccurrence(rule: RepeatRule, from: IsoDate, today: IsoDate): IsoDate | null {
  // 四个日期入参全部先 parse —— 只 parse 枢轴的话,`from='2026-02-30'` 在 today > from
  // 时会一路静默通过(调研实跑抓到的真 bug)
  const f = parseIso(from, 'from');
  const t = parseIso(today, 'today');
  const a = parseIso(rule.anchor, 'anchor');
  if (rule.until !== null) parseIso(rule.until, 'until');
  if (!Number.isInteger(rule.every) || rule.every < 1 || rule.every > 999) {
    throw new RangeError(`循环间隔越界: ${rule.every}(须为 1..999)`);
  }
  const wantWeek = rule.unit === 'week';
  if (wantWeek !== (rule.weekdays !== null)) {
    throw new RangeError(
      `循环规则损坏:unit=${rule.unit} 与 weekdays=${String(rule.weekdays)} 不匹配`,
    );
  }
  if (rule.weekdays !== null && (rule.weekdays < 1 || rule.weekdays > 127)) {
    throw new RangeError(`星期掩码越界: ${rule.weekdays}(须为 1..127)`);
  }

  // 枢轴:scheduled 模式逾期一次补齐到未来第一个格点(否则 D-19 的"过期滚入今天"会让
  // 新生成的一次当场落回 Today,叠加 G1"一次完成只生成一次" = 用户要点几十次才爬出逾期);
  // completed 模式定义上就从完成日推,永不追赶
  const pivot = rule.from === 'completed' ? f.e : Math.max(f.e, t.e);

  let out: IsoDate;
  if (rule.weekdays !== null) {
    out = nextWeekly(rule, a.e, pivot);
  } else if (rule.unit === 'day' || rule.unit === 'week') {
    // week 无掩码在规范化后不出现,退化为 7 天步长仅作兜底
    const step = rule.every * (rule.unit === 'week' ? 7 : 1);
    if (rule.from === 'completed') out = isoOfEpoch(pivot + step);
    else {
      // 从 anchor 数格子:补齐之后相位不丢(每 3 天、锚 8/1、今天 8/12 → 8/13 而不是 8/15)
      let k = Math.max(0, Math.floor((pivot - a.e) / step) + 1);
      while (a.e + k * step <= pivot) k += 1;
      out = isoOfEpoch(a.e + k * step);
    }
  } else {
    out = nextMonthly(rule, a, f, pivot);
  }

  // Ends(inclusive):恰落在 until 当天的那一次照常生成(字典序 = 时间序,INV-03)
  return rule.until !== null && out > rule.until ? null : out;
}

function nextWeekly(rule: RepeatRule, anchorE: number, pivot: number): IsoDate {
  const mask = rule.weekdays!;
  const hit = (e: number): boolean => (mask & (1 << weekdayOf(e))) !== 0;
  if (rule.from === 'completed') {
    // 先空出 every-1 整周,再找下一个命中的星期(每 2 周周三、8/12 完成 → 8/26)
    const base = pivot + (rule.every - 1) * 7;
    for (let e = base + 1; e <= base + 7; e += 1) if (hit(e)) return isoOfEpoch(e);
    throw new RangeError('星期掩码非空却 7 天内无命中(不可能)');
  }
  // scheduled:周块对齐(WKST=Mon)。块序号从 anchor 所在周数起,every 周为一块;
  // 掩码非空 ⇒ 每个对齐块内必有命中,上界 7*every+14 天必达
  const anchorMon = mondayOf(anchorE);
  const blockOk = (e: number): boolean =>
    ((((mondayOf(e) - anchorMon) / 7) % rule.every) + rule.every) % rule.every === 0;
  for (let e = pivot + 1; e <= pivot + 7 * rule.every + 14; e += 1) {
    if (hit(e) && blockOk(e)) return isoOfEpoch(e);
  }
  throw new RangeError('周循环推进越界(不可能)');
}

function nextMonthly(
  rule: RepeatRule,
  a: { y: number; m: number; d: number },
  f: { y: number; m: number; d: number },
  pivot: number,
): IsoDate {
  const monthStep = rule.every * (rule.unit === 'year' ? 12 : 1);
  if (rule.from === 'completed') {
    // 以完成日为基推一步。**有意漂移**(2/28 完成的月循环 → 3/28)—— 那正是
    // based-on-completed 的定义:周期相对上一次实际动作,不相对日历格子
    const m0 = f.y * 12 + (f.m - 1) + monthStep;
    const y = Math.floor(m0 / 12);
    const m = (m0 % 12) + 1;
    return isoOf(y, m, Math.min(f.d, daysInMonth(y, m)));
  }
  // scheduled:月数永远从 anchor 加,日永远从 anchorD 夹取到月末(不滚月、不漂移)
  const grid = (k: number): { e: number; y: number; m: number; d: number } => {
    const m0 = a.y * 12 + (a.m - 1) + k * monthStep;
    const y = Math.floor(m0 / 12);
    const m = (m0 % 12) + 1;
    const d = Math.min(a.d, daysInMonth(y, m));
    return { e: daysFromCivil(y, m, d), y, m, d };
  };
  const pc = civilFromDays(pivot);
  const mDiff = (pc.y - a.y) * 12 + (pc.m - a.m);
  let k = Math.max(0, Math.floor(mDiff / monthStep) - 1);
  let g = grid(k);
  let guard = 0;
  while (g.e <= pivot) {
    k += 1;
    g = grid(k);
    if ((guard += 1) > 5) throw new RangeError('月循环推进越界(不可能)');
  }
  return isoOf(g.y, g.m, g.d);
}

/** 预览:连推 n 次(UI 的「接下来:08-19、08-26、09-02」、CLI show 的下三次)。 */
export function nextOccurrences(
  rule: RepeatRule,
  from: IsoDate,
  today: IsoDate,
  n: number,
): IsoDate[] {
  const out: IsoDate[] = [];
  let cur = from;
  for (let i = 0; i < n; i += 1) {
    const d = nextOccurrence(rule, cur, today);
    if (d === null) break;
    out.push(d);
    cur = d;
  }
  return out;
}

// ------------------------------------------------------------- 输入与规范化

export type WeekdayName = 'su' | 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa';
const WEEKDAY_BIT: Record<WeekdayName, number> = {
  su: 1,
  mo: 2,
  tu: 4,
  we: 8,
  th: 16,
  fr: 32,
  sa: 64,
};
const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 三个载体共用的输入型;写入侧经 normalizeRepeat 规范化成 RepeatRule。 */
export interface RepeatInput {
  unit: RepeatUnit;
  /** 默认 1 */
  every?: number;
  /** 仅 unit='week';不给 = 取 anchor 当天那一位 */
  weekdays?: WeekdayName[];
  /** 默认 'scheduled' */
  from?: RepeatFrom;
  /** 默认 null = 永不结束;含当日 */
  until?: IsoDate | null;
}

/**
 * 规范化(INV-36.2 唯一表示)。anchor = 该任务的 scheduledDate(锚点只由人写,INV-36.3)。
 * 收紧(裁决 D):`every≥2 且 unit=week` 时 weekdays 必须恰为 anchor 当天那一位 ——
 * 于是 WKST 块对齐语义在 v1 不可观测,不会成为暗坑;算法层保留实现,将来放开只需删这条校验。
 */
export function normalizeRepeat(
  input: RepeatInput,
  anchor: IsoDate,
): RepeatRule | { error: string } {
  if (!isValidIsoDate(anchor)) return { error: `无效计划日期 ${anchor},格式须为 YYYY-MM-DD` };
  const every = input.every ?? 1;
  if (!Number.isInteger(every) || every < 1 || every > 999) {
    return { error: `循环间隔须为 1..999 的整数,收到 ${String(input.every)}` };
  }
  const from = input.from ?? 'scheduled';
  const until = input.until ?? null;
  if (until !== null) {
    if (!isValidIsoDate(until)) return { error: `无效结束日 ${until},格式须为 YYYY-MM-DD` };
    if (until < anchor)
      return { error: `结束日 ${until} 早于起始计划日 ${anchor},循环一次都不会发生` };
  }
  let weekdays: number | null = null;
  if (input.unit === 'week') {
    if (input.weekdays !== undefined && input.weekdays.length > 0) {
      weekdays = 0;
      for (const w of input.weekdays) {
        const bit = WEEKDAY_BIT[w] as number | undefined;
        if (bit === undefined) return { error: `无效星期 ${String(w)}(须为 mo/tu/we/th/fr/sa/su)` };
        weekdays |= bit;
      }
    } else {
      weekdays = weekdayMaskOf(anchor);
    }
    if (every >= 2 && weekdays !== weekdayMaskOf(anchor)) {
      return { error: `每 ${every} 周的循环只能落在计划日那天的星期(暂不支持"每 N 周的多个星期")` };
    }
  } else if (input.weekdays !== undefined && input.weekdays.length > 0) {
    return { error: `星期列表仅对每周循环有意义(unit=week),收到 unit=${input.unit}` };
  }
  return { every, unit: input.unit, from, weekdays, until, anchor };
}

// ------------------------------------------------------------------ 格式化

function maskLabel(mask: number): string {
  if (mask === 62) return '每个工作日';
  const names: string[] = [];
  // 展示顺序按周一开头(与 WKST、日历直觉一致);周日排最后
  for (const wd of [1, 2, 3, 4, 5, 6, 0]) if (mask & (1 << wd)) names.push(WEEKDAY_ZH[wd]!);
  return names.join('、');
}

/**
 * 用户可读文案。short 进任务行 chip(「每周三」),long 进 tooltip / show
 * (「每周三 · 按完成日推进 · 到 2026-12-31 为止」)。
 */
export function formatRepeat(r: RepeatRule): { short: string; long: string } {
  const n = r.every;
  let short: string;
  if (r.weekdays !== null) {
    const days = maskLabel(r.weekdays);
    short =
      n === 1
        ? days === '每个工作日'
          ? days
          : `每周${days.replace(/周/g, '').replace(/、/g, '/')}`
        : `每 ${n} 周的${days}`;
    if (r.weekdays === 62 && n === 1) short = '每个工作日';
  } else if (r.unit === 'day') {
    short = n === 1 ? '每天' : `每 ${n} 天`;
  } else if (r.unit === 'month') {
    const d = Number(r.anchor.slice(8, 10));
    short = n === 1 ? `每月 ${d} 日` : `每 ${n} 个月的 ${d} 日`;
  } else if (r.unit === 'year') {
    const m = Number(r.anchor.slice(5, 7));
    const d = Number(r.anchor.slice(8, 10));
    short = n === 1 ? `每年 ${m} 月 ${d} 日` : `每 ${n} 年的 ${m} 月 ${d} 日`;
  } else {
    short = n === 1 ? '每周' : `每 ${n} 周`;
  }
  const parts = [short];
  if (r.from === 'completed') parts.push('按完成日推进');
  if (r.until !== null) parts.push(`到 ${r.until} 为止`);
  return { short, long: parts.join(' · ') };
}

// ------------------------------------------------------------------- 预设

/** Todoist 式预设菜单项,文案从 anchor 现算(「每月 12 日」的 12 来自计划日)。 */
export function repeatPresets(
  anchor: IsoDate,
): { key: string; label: string; input: RepeatInput }[] {
  const a = parseIso(anchor, 'anchor');
  const wd = weekdayOf(a.e);
  return [
    { key: 'daily', label: '每天', input: { unit: 'day' } },
    { key: 'weekly', label: `每${WEEKDAY_ZH[wd]!}`, input: { unit: 'week' } },
    {
      key: 'weekday',
      label: '每个工作日',
      input: { unit: 'week', weekdays: ['mo', 'tu', 'we', 'th', 'fr'] },
    },
    { key: 'monthly', label: `每月 ${a.d} 日`, input: { unit: 'month' } },
    { key: 'yearly', label: `每年 ${a.m} 月 ${a.d} 日`, input: { unit: 'year' } },
  ];
}

// ------------------------------------------------------------- CLI 速写文法

const UNIT_WORD: Record<string, RepeatUnit> = {
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
};

/**
 * CLI `--repeat=` 速写 → RepeatInput(三载体共用一份文法,INV-36.13):
 *   daily | weekly | monthly | yearly     每 1 个单位;星期/几号由计划日决定
 *   weekday                               每个工作日(周一–周五)
 *   weekly:wed  weekly:mon,wed,fri        指定星期(仅每 1 周)
 *   "every N days|weeks|months|years"     自定义间隔(⚠ 有空格,必须整体加引号)
 * `none` 由调用方处理(关闭循环),不进这里。
 */
export function parseRepeatShorthand(s: string): RepeatInput | { error: string } {
  const raw = s.trim().toLowerCase();
  if (raw === 'daily') return { unit: 'day' };
  if (raw === 'weekly') return { unit: 'week' };
  if (raw === 'monthly') return { unit: 'month' };
  if (raw === 'yearly') return { unit: 'year' };
  if (raw === 'weekday' || raw === 'weekdays') {
    return { unit: 'week', weekdays: ['mo', 'tu', 'we', 'th', 'fr'] };
  }
  const wk = /^weekly:([a-z,]+)$/.exec(raw);
  if (wk !== null) {
    const names: WeekdayName[] = [];
    for (const part of wk[1]!.split(',')) {
      const n = part.trim().slice(0, 2) as WeekdayName;
      if (!(n in WEEKDAY_BIT))
        return { error: `无效星期 ${part}(可用 mon,tue,wed,thu,fri,sat,sun)` };
      names.push(n);
    }
    if (names.length === 0) return { error: 'weekly: 后须至少给一个星期' };
    return { unit: 'week', weekdays: names };
  }
  const ev = /^every\s+(\d+)\s+([a-z]+)$/.exec(raw);
  if (ev !== null) {
    const unit = UNIT_WORD[ev[2]!];
    if (unit === undefined) return { error: `无效单位 ${ev[2]!}(可用 days/weeks/months/years)` };
    return { unit, every: Number(ev[1]!) };
  }
  return {
    error:
      `无法解析循环表达式「${s}」。可用:daily / weekly / monthly / yearly / weekday / ` +
      `weekly:wed / weekly:mon,wed,fri / "every 2 weeks"(有空格须加引号)`,
  };
}
