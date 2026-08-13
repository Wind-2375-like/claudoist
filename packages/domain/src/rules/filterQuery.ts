import type { Task } from '../entities/task';
import type { GtdSnapshot } from '../ports/gtdStore';
import { addDaysIso, isValidIsoDate } from './dates';
import { energyRank } from './energy';

/**
 * 过滤器查询语言(INV-33)。Todoist 风格的文本语法,是 Filters 视图、CLI 与 agent 的
 * **唯一**过滤口径。
 *
 * 与 Todoist 的两处**有意偏离**,都是本仓数据模型决定的:
 * 1. **`pN` 方向相反**:这里 `p5` = 最高(INV-01 ⚠SP)。Todoist 是 p1 最高。代价是粘贴
 *    Todoist 过滤器时优先级会反,收益是 `p>=4`(高及以上)读法唯一 —— 1=最高 时
 *    "大于"到底指更重要还是数值更大,两种读法结论相反(D-29 翻转当日即因此被 D-31 撤回)。
 * 2. **两个日期字段**:`scheduledDate`(计划哪天做)与 `deadline`(最迟完成日)。按 Todoist
 *    的实际语义,裸关键字(today/tomorrow/overdue/no date/next N days)与 `due:`/`date:`
 *    族**全部指计划日**;截止日只能经 `deadline:` 族访问,没有任何裸关键字会落到它上面。
 *
 * 解析与求值分离:parse 只看文本(不碰快照),名字到 id 的解析放在求值期 —— 保存时标签
 * 存在、之后被删掉,不应该让一个存好的过滤器变成红色错误页,而应是空结果 + 提示。
 */

// ------------------------------------------------------------------ AST

export interface Span {
  start: number;
  end: number;
}

export type CmpOp = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';

export type DateField = 'scheduledDate' | 'deadline' | 'createdAt' | 'completedAt';

export type DateExpr = { kind: 'iso'; value: string } | { kind: 'relative'; offsetDays: number };

export type DateTest =
  | { op: 'isNull' }
  | { op: 'on'; date: DateExpr }
  | { op: 'before'; date: DateExpr }
  | { op: 'after'; date: DateExpr }
  | { op: 'between'; from: DateExpr; to: DateExpr };

/** 与 entities/task 的同名类型一致;此处内部使用,不再导出以免 barrel 冲突 */
type TaskStatus = 'active' | 'done' | 'deleted';
type Bucket = 'inbox' | 'project' | 'someday' | 'reference';

export type FilterFlag =
  'hasLabels' | 'hasProject' | 'hasTime' | 'hasDescription' | 'subtask' | 'mirrored' | 'recurring';

export type AtomNode =
  | { kind: 'label'; name: string; span: Span }
  | { kind: 'project'; name: string; span: Span }
  | { kind: 'priority'; op: CmpOp; value: number; span: Span }
  | { kind: 'date'; field: DateField; test: DateTest; span: Span }
  | { kind: 'energy'; op: CmpOp; rank: number; span: Span }
  | { kind: 'estimate'; op: CmpOp; minutes: number; span: Span }
  | { kind: 'bucket'; bucket: Bucket; span: Span }
  | { kind: 'status'; statuses: TaskStatus[]; span: Span }
  | { kind: 'search'; text: string; fields: ('title' | 'description')[]; span: Span }
  | { kind: 'flag'; flag: FilterFlag; span: Span };

export type FilterNode =
  | { kind: 'or'; operands: FilterNode[] }
  | { kind: 'and'; operands: FilterNode[] }
  | { kind: 'not'; operand: FilterNode }
  | AtomNode;

/** 顶层逗号分隔的多段(视图指令,不是"或"):每段独立求值、独立呈现。 */
export interface FilterAst {
  lists: { node: FilterNode; source: string }[];
}

export interface FilterParseError {
  message: string;
  span: Span;
}

export type ParseFilterResult =
  { ok: true; ast: FilterAst } | { ok: false; error: FilterParseError };

// ------------------------------------------------------------------ 词法

type TokKind =
  'word' | 'string' | 'lparen' | 'rparen' | 'and' | 'or' | 'not' | 'comma' | 'colon' | 'op';

interface Token {
  kind: TokKind;
  /** word/string 的文本(string 已去引号与转义);op 为 >= <= > < = 之一 */
  text: string;
  span: Span;
}

const OPS = ['>=', '<=', '>', '<', '='];
const PUNCT: Record<string, TokKind> = {
  '(': 'lparen',
  ')': 'rparen',
  '&': 'and',
  '|': 'or',
  '!': 'not',
  ',': 'comma',
  ':': 'colon',
};

class LexError extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message);
  }
}

function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (PUNCT[ch]) {
      out.push({ kind: PUNCT[ch], text: ch, span: { start: i, end: i + 1 } });
      i += 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ kind: 'op', text: op, span: { start: i, end: i + op.length } });
      i += op.length;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      let text = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) i += 1;
        text += src[i];
        i += 1;
      }
      if (i >= src.length) throw new LexError('引号没有闭合', { start, end: src.length });
      i += 1;
      out.push({ kind: 'string', text, span: { start, end: i } });
      continue;
    }
    const start = i;
    while (i < src.length && !/[\s()&|!,:"<>=]/.test(src[i]!)) i += 1;
    out.push({ kind: 'word', text: src.slice(start, i), span: { start, end: i } });
  }
  return out;
}

// ------------------------------------------------------------------ 日期字面量

/** `today` / `tomorrow` / `yesterday` / `+N`(天)/ `-N` / `YYYY-MM-DD`。 */
function parseDateExpr(tok: Token | undefined, extra?: Token): DateExpr | null {
  if (!tok || tok.kind !== 'word') return null;
  const raw = tok.text.toLowerCase();
  if (raw === 'today') return { kind: 'relative', offsetDays: 0 };
  if (raw === 'tomorrow') return { kind: 'relative', offsetDays: 1 };
  if (raw === 'yesterday') return { kind: 'relative', offsetDays: -1 };
  const rel = /^([+-])(\d+)(d|day|days)?$/.exec(raw);
  if (rel) {
    // `+7 days` 会被拆成两个 word,第二个是单位;这里只认数值,单位由调用方吞掉
    if (rel[3] === undefined && extra !== undefined && !/^(d|day|days)$/i.test(extra.text)) {
      return null;
    }
    const n = Number(rel[2]);
    return { kind: 'relative', offsetDays: rel[1] === '-' ? -n : n };
  }
  if (isValidIsoDate(tok.text)) return { kind: 'iso', value: tok.text };
  return null;
}

/** 单位词紧跟在 `+7` 之后时要吞掉一个 token。 */
const isDayUnit = (t: Token | undefined): boolean =>
  t !== undefined && t.kind === 'word' && /^(d|day|days)$/i.test(t.text);

// ------------------------------------------------------------------ 解析

const CMP: Record<string, CmpOp> = { '<': 'lt', '<=': 'lte', '=': 'eq', '>=': 'gte', '>': 'gt' };
const ENERGY_NAMES = ['low', 'medium', 'high'];
const BUCKETS: Bucket[] = ['inbox', 'project', 'someday', 'reference'];
const STATUSES: TaskStatus[] = ['active', 'done', 'deleted'];

class Parser {
  private pos = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(k = 0): Token | undefined {
    return this.toks[this.pos + k];
  }
  private next(): Token | undefined {
    return this.toks[this.pos++];
  }
  private at(kind: TokKind): boolean {
    return this.peek()?.kind === kind;
  }
  private word(k = 0): string | null {
    const t = this.peek(k);
    return t?.kind === 'word' ? t.text.toLowerCase() : null;
  }
  private fail(message: string, span?: Span): never {
    const t = this.peek();
    throw new LexError(message, span ?? t?.span ?? { start: 0, end: 0 });
  }

  parseTop(): FilterNode[] {
    const lists: FilterNode[] = [];
    for (;;) {
      lists.push(this.parseOr());
      if (this.at('comma')) {
        this.next();
        continue;
      }
      break;
    }
    if (this.pos < this.toks.length) this.fail(`无法解析:多余的内容`);
    return lists;
  }

  private parseOr(): FilterNode {
    const operands = [this.parseAnd()];
    while (this.at('or')) {
      this.next();
      operands.push(this.parseAnd());
    }
    return operands.length === 1 ? operands[0]! : { kind: 'or', operands };
  }

  private parseAnd(): FilterNode {
    const operands = [this.parseUnary()];
    while (this.at('and')) {
      this.next();
      operands.push(this.parseUnary());
    }
    return operands.length === 1 ? operands[0]! : { kind: 'and', operands };
  }

  private parseUnary(): FilterNode {
    if (this.at('not')) {
      this.next();
      return { kind: 'not', operand: this.parseUnary() };
    }
    if (this.at('lparen')) {
      const open = this.next()!;
      const inner = this.parseOr();
      if (this.at('comma')) this.fail('括号内不能出现逗号 —— 逗号只在最外层分段,组内的"或"请写 |');
      if (!this.at('rparen')) this.fail('括号没有闭合', open.span);
      this.next();
      return inner;
    }
    return this.parseAtom();
  }

  /** `due` / `deadline` / `created` / `completed` 族:[before|after] : 值[..值] */
  private parseDateAtom(field: DateField, head: Token): AtomNode {
    let mode: 'on' | 'before' | 'after' = 'on';
    const w = this.word();
    if (w === 'before' || w === 'after') {
      mode = w;
      this.next();
    }
    if (!this.at('colon')) this.fail(`${head.text} 后面要跟冒号,例如 ${head.text}: today`);
    this.next();
    const tok = this.next();
    const from = parseDateExpr(tok, this.peek());
    if (from === null) {
      this.fail(
        `日期写法无效 —— 支持 YYYY-MM-DD、today/tomorrow/yesterday、+7 days`,
        tok?.span ?? head.span,
      );
    }
    if (isDayUnit(this.peek())) this.next();
    const end = tok!.span.end;
    // 区间 a..b 只在 `on` 模式下有意义
    if (mode === 'on' && this.word()?.startsWith('..')) {
      const rest = this.next()!;
      const to = parseDateExpr({ ...rest, text: rest.text.slice(2) }, this.peek());
      if (to === null) this.fail('区间右端日期无效', rest.span);
      if (isDayUnit(this.peek())) this.next();
      return {
        kind: 'date',
        field,
        test: { op: 'between', from, to },
        span: { start: head.span.start, end: rest.span.end },
      };
    }
    return {
      kind: 'date',
      field,
      test: { op: mode, date: from },
      span: { start: head.span.start, end },
    };
  }

  /** `energy`/`est` 族:(: | 比较符) 值;`x: v` 是 `x <= v` 的糖(容量语义,INV-02)。 */
  private parseCmpAtom(head: Token): AtomNode {
    let op: CmpOp = 'lte';
    if (this.at('colon')) this.next();
    else if (this.at('op')) op = CMP[this.next()!.text]!;
    else this.fail(`${head.text} 后面要跟冒号或比较符,例如 ${head.text}: 30`);
    const v = this.next();
    if (!v || v.kind !== 'word') this.fail(`${head.text} 缺少值`, head.span);
    const span = { start: head.span.start, end: v.span.end };
    if (head.text.toLowerCase() === 'energy') {
      const rank = ENERGY_NAMES.indexOf(v.text.toLowerCase()) + 1;
      if (rank === 0) this.fail(`精力只有 low / medium / high,得到 "${v.text}"`, v.span);
      return { kind: 'energy', op, rank, span };
    }
    const m = /^(\d+)(m|min|mins|minutes|h|hour|hours)?$/i.exec(v.text);
    if (!m) this.fail(`时长要写成分钟数(可带 m/h 后缀),得到 "${v.text}"`, v.span);
    const n = Number(m[1]);
    const minutes = /^h/i.test(m[2] ?? '') ? n * 60 : n;
    if (minutes < 1) this.fail('时长必须 ≥ 1 分钟', v.span);
    return { kind: 'estimate', op, minutes, span };
  }

  private parseAtom(): FilterNode {
    const t = this.next();
    if (!t) this.fail('查询意外结束', { start: 0, end: 0 });
    if (t.kind !== 'word' && t.kind !== 'string')
      this.fail(`这里应该是一个条件,而不是 "${t.text}"`, t.span);

    const raw = t.text;
    const w = raw.toLowerCase();

    // @标签 / #项目(名字带空格时写 @"a b")
    for (const [prefix, kind] of [
      ['@', 'label'],
      ['#', 'project'],
    ] as const) {
      if (raw.startsWith(prefix)) {
        let name = raw.slice(1);
        let end = t.span.end;
        if (name === '' && this.peek()?.kind === 'string') {
          const s = this.next()!;
          name = s.text;
          end = s.span.end;
        }
        if (name === '') this.fail(`${prefix} 后面要跟名字`, t.span);
        return { kind, name, span: { start: t.span.start, end } };
      }
    }

    // 优先级:p4 / p>=4(5 = 最高,INV-01)
    const pm = /^p([1-5])$/.exec(w);
    if (pm) {
      return { kind: 'priority', op: 'eq', value: Number(pm[1]), span: t.span };
    }
    if (w === 'p' || w === 'priority') {
      if (!this.at('op')) this.fail('优先级要写成 p4 或 p>=4', t.span);
      const op = CMP[this.next()!.text]!;
      const v = this.next();
      if (!v || !/^[1-5]$/.test(v.text))
        this.fail('优先级只有 p1(最低)到 p5(最高)', v?.span ?? t.span);
      return {
        kind: 'priority',
        op,
        value: Number(v.text),
        span: { start: t.span.start, end: v.span.end },
      };
    }

    // 裸日期关键字 —— 一律作用于**计划日**(与 Todoist 的 Date 一致)
    if (w === 'today' || w === 'tomorrow' || w === 'yesterday') {
      const offsetDays = w === 'today' ? 0 : w === 'tomorrow' ? 1 : -1;
      return {
        kind: 'date',
        field: 'scheduledDate',
        test: { op: 'on', date: { kind: 'relative', offsetDays } },
        span: t.span,
      };
    }
    if (w === 'overdue' || w === 'od') {
      return {
        kind: 'date',
        field: 'scheduledDate',
        test: { op: 'before', date: { kind: 'relative', offsetDays: 0 } },
        span: t.span,
      };
    }
    // `next 7 days` / `7 days`
    if (w === 'next' || /^\d+$/.test(w)) {
      const nTok = w === 'next' ? this.next() : t;
      const n = Number(nTok?.text);
      const unit = this.peek();
      if (!Number.isInteger(n) || n < 1 || !unit || !/^days?$/i.test(unit.text)) {
        this.fail('写法是 next 7 days 或 7 days', t.span);
      }
      this.next();
      return {
        kind: 'date',
        field: 'scheduledDate',
        test: {
          op: 'between',
          from: { kind: 'relative', offsetDays: 0 },
          to: { kind: 'relative', offsetDays: n - 1 },
        },
        span: { start: t.span.start, end: unit!.span.end },
      };
    }

    // no X
    if (w === 'no') {
      const n = this.next();
      const nw = n?.text.toLowerCase();
      const span = { start: t.span.start, end: n?.span.end ?? t.span.end };
      if (nw === 'date' || nw === 'due') {
        if (nw === 'due' && this.word() === 'date') this.next();
        return { kind: 'date', field: 'scheduledDate', test: { op: 'isNull' }, span };
      }
      if (nw === 'deadline')
        return { kind: 'date', field: 'deadline', test: { op: 'isNull' }, span };
      if (nw === 'labels' || nw === 'label')
        return { kind: 'not', operand: { kind: 'flag', flag: 'hasLabels', span } };
      if (nw === 'project')
        return { kind: 'not', operand: { kind: 'flag', flag: 'hasProject', span } };
      if (nw === 'time') return { kind: 'not', operand: { kind: 'flag', flag: 'hasTime', span } };
      if (nw === 'description' || nw === 'desc')
        return { kind: 'not', operand: { kind: 'flag', flag: 'hasDescription', span } };
      this.fail('no 后面只能是 date / deadline / labels / project / time / description', span);
    }

    // 日期族前缀
    if (w === 'due' || w === 'date') return this.parseDateAtom('scheduledDate', t);
    if (w === 'deadline') {
      if (this.word() === 'overdue') {
        const o = this.next()!;
        return {
          kind: 'date',
          field: 'deadline',
          test: { op: 'before', date: { kind: 'relative', offsetDays: 0 } },
          span: { start: t.span.start, end: o.span.end },
        };
      }
      return this.parseDateAtom('deadline', t);
    }
    if (w === 'created') return this.parseDateAtom('createdAt', t);
    if (w === 'completed') return this.parseDateAtom('completedAt', t);

    if (w === 'energy' || w === 'est' || w === 'minutes') return this.parseCmpAtom(t);

    // 容器 / 状态
    if (BUCKETS.includes(w as Bucket) && w !== 'project') {
      return { kind: 'bucket', bucket: w as Bucket, span: t.span };
    }
    if (w === 'bucket') {
      if (!this.at('colon')) this.fail('写法是 bucket: inbox', t.span);
      this.next();
      const v = this.next();
      if (!v || !BUCKETS.includes(v.text.toLowerCase() as Bucket)) {
        this.fail('容器只有 inbox / project / someday / reference', v?.span ?? t.span);
      }
      return {
        kind: 'bucket',
        bucket: v.text.toLowerCase() as Bucket,
        span: { start: t.span.start, end: v.span.end },
      };
    }
    if (w === 'done') return { kind: 'status', statuses: ['done'], span: t.span };
    if (w === 'status') {
      if (!this.at('colon')) this.fail('写法是 status: done', t.span);
      this.next();
      const statuses: TaskStatus[] = [];
      let end: number;
      for (;;) {
        const v = this.next();
        const vw = v?.text.toLowerCase();
        if (vw === 'any') statuses.push(...STATUSES);
        else if (vw && STATUSES.includes(vw as TaskStatus)) statuses.push(vw as TaskStatus);
        else this.fail('状态只有 active / done / deleted / any', v?.span ?? t.span);
        end = v!.span.end;
        if (this.at('comma') && this.peek(1)?.kind === 'word') {
          const after = this.peek(1)!.text.toLowerCase();
          if (after === 'any' || STATUSES.includes(after as TaskStatus)) {
            this.next();
            continue;
          }
        }
        break;
      }
      return {
        kind: 'status',
        statuses: [...new Set(statuses)],
        span: { start: t.span.start, end },
      };
    }

    // 搜索
    if (w === 'search' || w === 'title' || w === 'desc') {
      if (!this.at('colon')) this.fail(`写法是 ${w}: 关键词`, t.span);
      this.next();
      const v = this.next();
      if (!v || (v.kind !== 'word' && v.kind !== 'string')) this.fail(`${w} 缺少关键词`, t.span);
      const fields: ('title' | 'description')[] =
        w === 'title' ? ['title'] : w === 'desc' ? ['description'] : ['title', 'description'];
      return {
        kind: 'search',
        text: v.text,
        fields,
        span: { start: t.span.start, end: v.span.end },
      };
    }

    // 标志
    if (w === 'subtask') return { kind: 'flag', flag: 'subtask', span: t.span };
    if (w === 'mirrored' || w === 'upstream')
      return { kind: 'flag', flag: 'mirrored', span: t.span };
    // INV-36.12。关键字是 recurring(Todoist 过滤语言的既有 token),字段名是 repeat
    // (用户原话)—— 这处不对称是**有意的**,不要"顺手统一"
    if (w === 'recurring') return { kind: 'flag', flag: 'recurring', span: t.span };

    this.fail(`不认识的条件 "${raw}" —— 关键词是不是拼错了?文本搜索请写 search: ${raw}`, t.span);
  }
}

/** 解析查询文本;不碰快照(标签/项目名在求值期才解析)。 */
export function parseFilterQuery(src: string): ParseFilterResult {
  if (src.trim() === '') {
    return { ok: false, error: { message: '查询不能为空', span: { start: 0, end: src.length } } };
  }
  try {
    const nodes = new Parser(lex(src)).parseTop();
    // 逐段留下原文,供多段视图显示每段标题
    const parts = splitTopLevel(src);
    return {
      ok: true,
      ast: {
        lists: nodes.map((node, i) => ({ node, source: (parts[i] ?? src).trim() })),
      },
    };
  } catch (e) {
    if (e instanceof LexError) return { ok: false, error: { message: e.message, span: e.span } };
    throw e;
  }
}

/** 按顶层逗号切原文(括号内与引号内的逗号不算)。 */
function splitTopLevel(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '(') depth += 1;
    else if (!quoted && c === ')') depth -= 1;
    else if (!quoted && depth === 0 && c === ',') {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  out.push(src.slice(start));
  return out;
}

// ------------------------------------------------------------------ 求值

export interface FilterEvalContext {
  /** 今天(YYYY-MM-DD,本地 naive,INV-03) */
  today: string;
}

const resolveDate = (d: DateExpr, ctx: FilterEvalContext): string =>
  d.kind === 'iso' ? d.value : addDaysIso(ctx.today, d.offsetDays);

function cmp(op: CmpOp, a: number, b: number): boolean {
  switch (op) {
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
    case 'eq':
      return a === b;
    case 'gte':
      return a >= b;
    case 'gt':
      return a > b;
  }
}

/** null 日期只有 isNull 为真;其余比较一律 false(`!no date` 与 `!(due before: x)` 因此不等价)。 */
function testDate(value: string | null, test: DateTest, ctx: FilterEvalContext): boolean {
  if (test.op === 'isNull') return value === null;
  if (value === null) return false;
  const d = value.slice(0, 10);
  switch (test.op) {
    case 'on':
      return d === resolveDate(test.date, ctx);
    case 'before':
      return d < resolveDate(test.date, ctx);
    case 'after':
      return d > resolveDate(test.date, ctx);
    case 'between':
      return d >= resolveDate(test.from, ctx) && d <= resolveDate(test.to, ctx);
  }
}

function dateFieldOf(t: Task, f: DateField): string | null {
  switch (f) {
    case 'scheduledDate':
      return t.scheduledDate;
    case 'deadline':
      return t.deadline;
    case 'createdAt':
      return t.createdAt;
    case 'completedAt':
      return t.completedAt;
  }
}

function matchAtom(a: AtomNode, t: Task, snap: GtdSnapshot, ctx: FilterEvalContext): boolean {
  switch (a.kind) {
    case 'label': {
      const ids = snap.labels
        .filter((l) => l.name.toLowerCase() === a.name.toLowerCase())
        .map((l) => l.id);
      return snap.taskLabels.some((tl) => tl.taskId === t.id && ids.includes(tl.labelId));
    }
    case 'project': {
      const ids = snap.projects
        .filter((p) => p.outcome.toLowerCase() === a.name.toLowerCase())
        .map((p) => p.id);
      return t.projectId !== null && ids.includes(t.projectId);
    }
    case 'priority':
      return cmp(a.op, t.priority, a.value);
    case 'date':
      return testDate(dateFieldOf(t, a.field), a.test, ctx);
    case 'energy':
      return cmp(a.op, energyRank(t.energy), a.rank);
    case 'estimate':
      return cmp(a.op, t.estimatedMinutes, a.minutes);
    case 'bucket':
      return t.bucket === a.bucket;
    case 'status':
      return a.statuses.includes(t.status as TaskStatus);
    case 'search': {
      const q = a.text.toLowerCase();
      return a.fields.some((f) =>
        (f === 'title' ? t.title : t.description).toLowerCase().includes(q),
      );
    }
    case 'flag':
      switch (a.flag) {
        case 'hasLabels':
          return snap.taskLabels.some((tl) => tl.taskId === t.id);
        case 'hasProject':
          return t.projectId !== null;
        case 'hasTime':
          return t.startTime !== null;
        case 'hasDescription':
          return t.description.trim() !== '';
        case 'subtask':
          return t.parentTaskId !== null;
        case 'mirrored':
          return t.externalId !== null;
        case 'recurring':
          return t.repeat !== null;
      }
  }
}

function matchNode(n: FilterNode, t: Task, snap: GtdSnapshot, ctx: FilterEvalContext): boolean {
  switch (n.kind) {
    case 'and':
      return n.operands.every((o) => matchNode(o, t, snap, ctx));
    case 'or':
      return n.operands.some((o) => matchNode(o, t, snap, ctx));
    case 'not':
      return !matchNode(n.operand, t, snap, ctx);
    default:
      return matchAtom(n, t, snap, ctx);
  }
}

function collectStatuses(n: FilterNode, out: Set<TaskStatus>): void {
  if (n.kind === 'and' || n.kind === 'or') n.operands.forEach((o) => collectStatuses(o, out));
  else if (n.kind === 'not') collectStatuses(n.operand, out);
  else if (n.kind === 'status') n.statuses.forEach((s) => out.add(s));
}

/**
 * 求值一段。**隐式状态作用域**(两条,与 INV-32.3 同源):
 * 1. 整段没有任何 status token → 只看 active;
 * 2. 有 status token 但没提到 deleted → 始终排除软删。
 * 否则 `done | p5` 会把回收站里的东西一并捞出来。
 */
export function evalFilterNode(
  snap: GtdSnapshot,
  node: FilterNode,
  ctx: FilterEvalContext,
): Task[] {
  const mentioned = new Set<TaskStatus>();
  collectStatuses(node, mentioned);
  const scope = (t: Task): boolean => {
    if (mentioned.size === 0) return t.status === 'active';
    if (!mentioned.has('deleted')) return t.status !== 'deleted';
    return true;
  };
  return snap.tasks.filter((t) => scope(t) && matchNode(node, t, snap, ctx));
}

export interface FilterRunSection {
  /** 该段的查询原文(多段时作为分段标题) */
  source: string;
  tasks: Task[];
}

/** 解析 + 求值一整条查询(可能多段)。解析失败返回 error。 */
export function runFilterQuery(
  snap: GtdSnapshot,
  src: string,
  ctx: FilterEvalContext,
): { sections: FilterRunSection[] } | { error: FilterParseError } {
  const parsed = parseFilterQuery(src);
  if (!parsed.ok) return { error: parsed.error };
  return {
    sections: parsed.ast.lists.map((l) => ({
      source: l.source,
      tasks: evalFilterNode(snap, l.node, ctx),
    })),
  };
}

/** 查询里引用到的、当前并不存在的标签/项目名(用于"该条件恒不成立"的提示)。 */
export function unknownNames(
  snap: GtdSnapshot,
  ast: FilterAst,
): { labels: string[]; projects: string[] } {
  const labels: string[] = [];
  const projects: string[] = [];
  const walk = (n: FilterNode): void => {
    if (n.kind === 'and' || n.kind === 'or') n.operands.forEach(walk);
    else if (n.kind === 'not') walk(n.operand);
    else if (n.kind === 'label') {
      if (!snap.labels.some((l) => l.name.toLowerCase() === n.name.toLowerCase()))
        labels.push(n.name);
    } else if (n.kind === 'project') {
      if (!snap.projects.some((p) => p.outcome.toLowerCase() === n.name.toLowerCase()))
        projects.push(n.name);
    }
  };
  ast.lists.forEach((l) => walk(l.node));
  return { labels: [...new Set(labels)], projects: [...new Set(projects)] };
}
