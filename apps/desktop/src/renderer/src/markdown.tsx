import katex from 'katex';
import type { ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';

/**
 * 极小的 Markdown 渲染器(agent 回复用)。
 *
 * ## 两条硬约束决定了为什么是手写而不是拿个库
 *
 * 1. **绝不 `dangerouslySetInnerHTML`**。这里渲染的是**模型输出**,把它当 HTML 塞进 DOM
 *    等于给了一条注入通道。本渲染器只产出 React 节点,文本永远走 React 的转义。
 * 2. **复制必须还原 Markdown 原文**(用户明确要求)。渲染成 HTML 之后,选中再复制拿到的是
 *    渲染后的可见文字 —— `**粗体**` 变成 `粗体`、列表符号变成看不见的结构。要拿回原文,
 *    渲染时就得把**每个叶子节点对应的源码区间**记下来。市面上的库很少直接给这个映射。
 *
 * ## 源码区间怎么记
 *
 * 每个叶子 `<span>` 带 `data-ms`(source start)与 `data-me`(source end)。
 * 纯文本叶子的渲染文本与源码**逐字符对应**(长度相等),所以选区偏移可以精确换算;
 * 带标记的叶子(粗体、行内代码、链接、公式)渲染文本比源码短,无法逐字符对应 ——
 * 这类叶子标 `data-mx="1"`(inexact),复制时**整段取用**。
 * 结果:纯文本部分字符级精确,样式片段最多多带上它自己的标记符,不会少给。
 *
 * ## 支持的子集
 *
 * 标题、粗体、斜体、行内代码、围栏代码块、无序/有序列表、引用、分隔线、链接、段落、
 * **表格**(GFM 管道表)、**数学公式**(行内 `$…$` / `\(…\)`,块级 `$$…$$` / `\[…\]`)。
 * 嵌套列表不支持。
 *
 * ## 公式为什么能过第 1 条约束
 *
 * KaTeX 不是把输入当 HTML:它把 TeX **词法解析**成自己的语法树再生成 DOM,输入里的文本
 * 全部经它转义;`trust: false`(默认)下 `\href` `\url` `\includegraphics` `\html*` 这些
 * 能碰 URL / class / style 的命令一律禁用。所以模型输出到这里仍然只是"一段要排版的公式",
 * 不是"一段要执行的标记"。渲染走 `katex.render(tex, el)` 往一个 React **不管理子节点**
 * 的空 span 里写 —— React 树里从头到尾没有 innerHTML 字符串经手。
 */

/** 叶子:一段可见文本 + 它在源码里的区间 */
export interface Leaf {
  text: string;
  start: number;
  end: number;
  /** 渲染文本与源码不等长(有标记),复制时整段取 */
  inexact?: boolean;
  code?: boolean;
  bold?: boolean;
  italic?: boolean;
  href?: string;
  /** 数学公式:text 即 TeX 源;display = 独占一行的块级公式 */
  math?: { display: boolean };
}

/** KaTeX 落点。React 不渲染它的子节点,KaTeX 自己往里写;tex 变了就重排。 */
function MathSpan({
  tex,
  display,
  ...rest
}: {
  tex: string;
  display: boolean;
  [k: `data-${string}`]: string | number | undefined;
}): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (ref.current === null) return;
    katex.render(tex, ref.current, {
      displayMode: display,
      throwOnError: false, // 语法错的公式原样红字显示,不炸整条消息
      trust: false,
      strict: 'ignore',
    });
  }, [tex, display]);
  return (
    <span
      ref={ref}
      {...rest}
      className={display ? 'my-1 block overflow-x-auto py-0.5' : 'mx-0.5'}
    />
  );
}

const leafSpan = (l: Leaf, key: number): ReactNode => {
  let cls = '';
  if (l.code) cls = 'rounded bg-inset/60 px-1 py-0.5 font-mono text-[0.92em]';
  if (l.bold) cls += ' font-semibold';
  if (l.italic) cls += ' italic';
  const props = {
    key,
    'data-ms': l.start,
    'data-me': l.end,
    ...(l.inexact === true ? { 'data-mx': '1' } : {}),
    ...(cls !== '' ? { className: cls.trim() } : {}),
  };
  if (l.math !== undefined) {
    return (
      <MathSpan
        key={key}
        tex={l.text}
        display={l.math.display}
        data-ms={l.start}
        data-me={l.end}
        data-mx="1"
      />
    );
  }
  if (l.href !== undefined) {
    return (
      <a {...props} href={l.href} className={`${cls} text-acc underline`.trim()}>
        {l.text}
      </a>
    );
  }
  return <span {...props}>{l.text}</span>;
};

/**
 * 从 `from` 起找 `close`,跳过被反斜杠转义的位置。返回 close 的起始下标,找不到 -1。
 * 公式里 `\$` 很常见(`\$100`),不能拿它当结束符。
 */
function findClose(src: string, from: number, close: string): number {
  let k = from;
  while (k < src.length) {
    // 先认闭合符、再跳转义:`\)` `\]` 这类闭合符自己就以反斜杠开头,
    // 反过来写会把它当"转义的 )"跳过去,于是 \(…\) 永远闭合不了。
    if (src.startsWith(close, k)) return k;
    if (src[k] === '\\') {
      k += 2;
      continue;
    }
    k += 1;
  }
  return -1;
}

/**
 * 行内数学的分隔规则(与 Pandoc 同):`$` 后面不能是空白,闭合 `$` 前面不能是空白、
 * 后面不能紧跟数字。这样 "花了 $5 和 $10" 不会被当成公式。
 */
function inlineDollar(src: string, i: number): { tex: string; end: number } | null {
  const first = src[i + 1];
  if (first === undefined || first === '$' || /\s/.test(first)) return null;
  const j = findClose(src, i + 1, '$');
  if (j < 0) return null;
  if (/\s/.test(src[j - 1]!)) return null;
  const after = src[j + 1];
  if (after !== undefined && /\d/.test(after)) return null;
  const tex = src.slice(i + 1, j);
  if (tex === '') return null;
  return { tex, end: j + 1 };
}

/** 行内解析:**粗**、*斜*、`码`、[文](url)、$公式$。返回带源码区间的叶子序列。导出供测试。 */
export function parseInline(src: string, base: number): Leaf[] {
  const out: Leaf[] = [];
  let i = 0;
  let plain = '';
  let plainStart = 0;
  const flush = (end: number): void => {
    if (plain !== '') {
      // 纯文本:渲染文本 === 源码切片,可逐字符换算
      out.push({ text: plain, start: base + plainStart, end: base + end });
      plain = '';
    }
  };
  const marker = (
    open: string,
    close: string,
    make: (inner: string, s: number, e: number) => Leaf,
  ): boolean => {
    if (!src.startsWith(open, i)) return false;
    const j = src.indexOf(close, i + open.length);
    if (j < 0) return false;
    const inner = src.slice(i + open.length, j);
    if (inner === '') return false;
    flush(i);
    out.push(make(inner, base + i, base + j + close.length));
    i = j + close.length;
    plainStart = i;
    return true;
  };
  /** 公式:open…close 之间是 TeX;闭合符跳过 `\` 转义 */
  const math = (open: string, close: string, display: boolean): boolean => {
    if (!src.startsWith(open, i)) return false;
    const j = findClose(src, i + open.length, close);
    if (j < 0) return false;
    const tex = src.slice(i + open.length, j);
    if (tex.trim() === '') return false;
    flush(i);
    out.push({
      text: tex,
      start: base + i,
      end: base + j + close.length,
      inexact: true,
      math: { display },
    });
    i = j + close.length;
    plainStart = i;
    return true;
  };

  while (i < src.length) {
    // 转义的美元号:显示 `$`,源码是 `\$`(不等长 → inexact)
    if (src.startsWith('\\$', i)) {
      flush(i);
      out.push({ text: '$', start: base + i, end: base + i + 2, inexact: true });
      i += 2;
      plainStart = i;
      continue;
    }
    // 公式放在链接之前:`\[` `\(` 的反斜杠不该被别的规则吃掉
    if (math('$$', '$$', true) || math('\\[', '\\]', true) || math('\\(', '\\)', false)) {
      continue;
    }
    if (src[i] === '$') {
      const m = inlineDollar(src, i);
      if (m !== null) {
        flush(i);
        out.push({
          text: m.tex,
          start: base + i,
          end: base + m.end,
          inexact: true,
          math: { display: false },
        });
        i = m.end;
        plainStart = i;
        continue;
      }
    }
    // 链接放最前:它的 `[` 不该被别的标记吃掉
    if (src[i] === '[') {
      const close = src.indexOf('](', i);
      const end = close < 0 ? -1 : src.indexOf(')', close);
      if (close > 0 && end > 0) {
        flush(i);
        out.push({
          text: src.slice(i + 1, close),
          href: src.slice(close + 2, end),
          start: base + i,
          end: base + end + 1,
          inexact: true,
        });
        i = end + 1;
        plainStart = i;
        continue;
      }
    }
    if (
      marker('`', '`', (t, s, e) => ({ text: t, start: s, end: e, inexact: true, code: true })) ||
      marker('**', '**', (t, s, e) => ({ text: t, start: s, end: e, inexact: true, bold: true })) ||
      marker('*', '*', (t, s, e) => ({ text: t, start: s, end: e, inexact: true, italic: true }))
    ) {
      continue;
    }
    if (plain === '') plainStart = i;
    plain += src[i];
    i += 1;
  }
  flush(src.length);
  return out;
}

// ------------------------------------------------------------------ 表格

export type CellAlign = 'left' | 'center' | 'right';

/** 一个单元格:去掉首尾空白后的文本 + 它在源码里的起始偏移 */
export interface Cell {
  text: string;
  at: number;
}

/**
 * 把一行按未转义、不在行内代码里的 `|` 切成单元格,并记下每格的源码偏移。
 * 首尾的管道符是可选的(`| a | b |` 与 `a | b` 都合法)。
 * `\|` 保留原样(显示为 `\|`,换取纯文本叶子的逐字符对应 —— 表格里极少出现)。
 */
export function splitRow(line: string, at: number): Cell[] {
  const raw: { s: string; start: number }[] = [];
  let cur = '';
  let curStart = 0;
  let inCode = false;
  for (let k = 0; k < line.length; k += 1) {
    const c = line[k]!;
    if (c === '\\' && line[k + 1] === '|') {
      cur += '\\|';
      k += 1;
      continue;
    }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) {
      raw.push({ s: cur, start: curStart });
      cur = '';
      curStart = k + 1;
      continue;
    }
    cur += c;
  }
  raw.push({ s: cur, start: curStart });
  if (line.trimStart().startsWith('|') && raw.length > 0 && raw[0]!.s.trim() === '') raw.shift();
  if (line.trimEnd().endsWith('|') && raw.length > 0 && raw[raw.length - 1]!.s.trim() === '') {
    raw.pop();
  }
  return raw.map((r) => {
    const lead = r.s.length - r.s.trimStart().length;
    return { text: r.s.trim(), at: at + r.start + lead };
  });
}

const SEP_CELL = /^:?-+:?$/;

/** 分隔行:每格形如 `---` / `:--` / `:-:` / `--:`,且至少一格。 */
function separatorAligns(line: string): CellAlign[] | null {
  if (!line.includes('-')) return null;
  const cells = splitRow(line, 0);
  if (cells.length === 0 || !cells.every((c) => SEP_CELL.test(c.text))) return null;
  return cells.map((c) => {
    const l = c.text.startsWith(':');
    const r = c.text.endsWith(':');
    return l && r ? 'center' : r ? 'right' : 'left';
  });
}

export interface Table {
  header: Cell[];
  aligns: CellAlign[];
  rows: Cell[][];
  /** 表格占用的行数(含表头与分隔行) */
  lineCount: number;
}

/**
 * 从第 i 行起尝试解析一张表:表头行(含 `|`)+ 分隔行 + 若干数据行(含 `|`、非空)。
 * 不是表就返回 null。流式输出时表头刚打出来、分隔行还没到 → null,先按段落显示,
 * 分隔行一到就变成表 —— 这是有意的,比"先按表画、再抖一下"稳。
 */
export function parseTable(lines: string[], i: number, lineStart: number[]): Table | null {
  const head = lines[i];
  const sep = lines[i + 1];
  if (head === undefined || sep === undefined || !head.includes('|')) return null;
  const aligns = separatorAligns(sep);
  if (aligns === null) return null;
  const header = splitRow(head, lineStart[i]!);
  if (header.length === 0 || header.length !== aligns.length) return null;
  const rows: Cell[][] = [];
  let j = i + 2;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.trim() === '' || !l.includes('|')) break;
    const cells = splitRow(l, lineStart[j]!);
    // 列数对齐表头:少的补空、多的截掉(GFM 同规)
    while (cells.length < header.length) cells.push({ text: '', at: lineStart[j]! + l.length });
    rows.push(cells.slice(0, header.length));
    j += 1;
  }
  return { header, aligns, rows, lineCount: j - i };
}

// ------------------------------------------------------------------ 块级

interface Block {
  render: (key: number) => ReactNode;
}

const DISPLAY_OPEN = /^\s*(\$\$|\\\[)(.*)$/;

/**
 * 块级公式:`$$` 或 `\[` 起头的行,到 `$$` / `\]` 结尾的行为止。
 * 返回 [TeX, 占用行数, 源码起点, 源码终点];未闭合返回 null(先按段落显示原文,
 * 闭合符一到再变公式 —— 流式时不会出现"打到一半的公式红字闪烁")。
 */
function parseDisplayMath(
  lines: string[],
  i: number,
  lineStart: number[],
): [string, number, number, number] | null {
  const m = DISPLAY_OPEN.exec(lines[i]!);
  if (!m) return null;
  const close = m[1] === '$$' ? '$$' : '\\]';
  const openAt = lineStart[i]! + lines[i]!.indexOf(m[1]!);
  const rest = m[2]!;
  // 同一行就闭合:`$$ E = mc^2 $$`
  const same = findClose(rest, 0, close);
  if (same >= 0) {
    const tex = rest.slice(0, same);
    if (tex.trim() === '') return null;
    return [tex, 1, openAt, openAt + m[1]!.length + same + close.length];
  }
  const body: string[] = [rest];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    const k = findClose(l, 0, close);
    if (k >= 0) {
      body.push(l.slice(0, k));
      const tex = body.join('\n');
      if (tex.trim() === '') return null;
      return [tex, j - i + 1, openAt, lineStart[j]! + k + close.length];
    }
    body.push(l);
    j += 1;
  }
  return null;
}

/** 把源码切成块,逐块渲染。返回 React 节点数组。 */
export function renderMarkdown(src: string): ReactNode {
  const lines = src.split('\n');
  const blocks: Block[] = [];
  // 每行在源码里的起始偏移
  const lineStart: number[] = [];
  let acc = 0;
  for (const l of lines) {
    lineStart.push(acc);
    acc += l.length + 1;
  }

  let i = 0;
  const inl = (text: string, at: number): ReactNode[] =>
    parseInline(text, at).map((l, k) => leafSpan(l, k));
  const listItem = (l: string): RegExpExecArray | null => /^\s*([-*]|\d+\.)\s+(.*)$/.exec(l);
  const alignCls = (a: CellAlign): string =>
    a === 'center' ? 'text-center' : a === 'right' ? 'text-right' : 'text-left';

  while (i < lines.length) {
    const line = lines[i]!;
    const at = lineStart[i]!;

    // 围栏代码块(未闭合也要能渲染 —— 流式输出时经常只打出了开头)
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^```\s*$/.test(lines[j]!)) {
        body.push(lines[j]!);
        j += 1;
      }
      const start = lineStart[i + 1] ?? at + line.length;
      const text = body.join('\n');
      blocks.push({
        render: (k) => (
          <pre
            key={k}
            className="my-1 overflow-x-auto rounded-md bg-inset p-2 text-[12px] leading-relaxed"
          >
            <code data-ms={start} data-me={start + text.length}>
              {text}
            </code>
          </pre>
        ),
      });
      i = j + 1;
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // 块级公式
    const dm = parseDisplayMath(lines, i, lineStart);
    if (dm !== null) {
      const [tex, n, s, e] = dm;
      blocks.push({
        render: (k) => <MathSpan key={k} tex={tex} display data-ms={s} data-me={e} data-mx="1" />,
      });
      i += n;
      continue;
    }

    // 表格
    const table = parseTable(lines, i, lineStart);
    if (table !== null) {
      blocks.push({
        render: (k) => (
          <div key={k} className="my-1.5 overflow-x-auto">
            <table className="border-collapse text-[13px]">
              <thead>
                <tr>
                  {table.header.map((c, n) => (
                    <th
                      key={n}
                      className={`border border-line bg-inset/60 px-2 py-1 font-semibold ${alignCls(table.aligns[n]!)}`}
                    >
                      {inl(c.text, c.at)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, rn) => (
                  <tr key={rn}>
                    {r.map((c, n) => (
                      <td
                        key={n}
                        className={`border border-line px-2 py-1 align-top ${alignCls(table.aligns[n]!)}`}
                      >
                        {inl(c.text, c.at)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      });
      i += table.lineCount;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const body = h[2]!;
      const bodyAt = at + h[1]!.length + 1;
      const size = level <= 2 ? 'text-[15px]' : 'text-[13px]';
      blocks.push({
        render: (k) => (
          <p key={k} className={`mt-1.5 mb-0.5 font-semibold ${size}`}>
            {inl(body, bodyAt)}
          </p>
        ),
      });
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ render: (k) => <hr key={k} className="my-2 border-line" /> });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: [string, number][] = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j]!)) {
        const m = /^>\s?/.exec(lines[j]!)!;
        quoted.push([lines[j]!.slice(m[0].length), lineStart[j]! + m[0].length]);
        j += 1;
      }
      blocks.push({
        render: (k) => (
          <blockquote key={k} className="my-1 border-l-2 border-line pl-2 text-mut italic">
            {quoted.map(([t, a], n) => (
              <p key={n}>{inl(t, a)}</p>
            ))}
          </blockquote>
        ),
      });
      i = j;
      continue;
    }

    if (listItem(line)) {
      const items: [string, number, string][] = [];
      let j = i;
      let ordered = false;
      while (j < lines.length) {
        const m = listItem(lines[j]!);
        if (!m) break;
        if (/\d/.test(m[1]!)) ordered = true;
        items.push([m[2]!, lineStart[j]! + lines[j]!.indexOf(m[2]!), m[1]!]);
        j += 1;
      }
      blocks.push({
        render: (k) => (
          <ul key={k} className="my-1 space-y-0.5 pl-4">
            {items.map(([t, a, mark], n) => (
              <li key={n} className="list-none">
                <span className="mr-1 text-fnt">{ordered ? mark : '·'}</span>
                {inl(t, a)}
              </li>
            ))}
          </ul>
        ),
      });
      i = j;
      continue;
    }

    // 普通段落:连续非空行合成一段(保留换行)。
    // 下一行若开启了别的块(表格 / 块级公式 / 代码 / 标题 …),段落到此为止。
    const para: [string, number][] = [];
    let j = i;
    while (
      j < lines.length &&
      lines[j]!.trim() !== '' &&
      !/^```/.test(lines[j]!) &&
      !/^#{1,6}\s/.test(lines[j]!) &&
      !/^>\s?/.test(lines[j]!) &&
      !listItem(lines[j]!) &&
      !/^(-{3,}|\*{3,})\s*$/.test(lines[j]!) &&
      (j === i || (parseTable(lines, j, lineStart) === null && !DISPLAY_OPEN.test(lines[j]!)))
    ) {
      para.push([lines[j]!, lineStart[j]!]);
      j += 1;
    }
    blocks.push({
      render: (k) => (
        <p key={k} className="my-1 first:mt-0 last:mb-0">
          {para.map(([t, a], n) => (
            <span key={n}>
              {n > 0 && '\n'}
              {inl(t, a)}
            </span>
          ))}
        </p>
      ),
    });
    i = j;
  }

  return <>{blocks.map((b, k) => b.render(k))}</>;
}

// ------------------------------------------------------------------ 复制

/**
 * 把当前选区还原成 Markdown 原文。
 *
 * 思路:选区两端各自找到最近的带 `data-ms` 的叶子,换算出源码偏移,然后从**该气泡的
 * 源码**里切片。纯文本叶子逐字符对应,可精确换算;带标记的叶子(`data-mx`)整段取用 ——
 * 宁可多带上它自己的 `**`,也不能给出一段少了标记、粘回去就不成立的 Markdown。
 * 公式叶子同规:KaTeX 生成的 DOM 都在那个 span 里面,`closest('[data-ms]')` 会爬回它,
 * 复制出来的是 `$…$` 原文。
 *
 * 返回 null = 选区不在消息气泡里(交给浏览器默认行为)。
 */
export function selectionToMarkdown(
  sel: Selection,
  sourceOf: (el: Element) => string | null,
): string | null {
  if (sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);

  const bubbleOf = (n: Node | null): Element | null => {
    const el = n instanceof Element ? n : (n?.parentElement ?? null);
    return el?.closest('[data-md-bubble]') ?? null;
  };
  const startBubble = bubbleOf(range.startContainer);
  const endBubble = bubbleOf(range.endContainer);
  if (startBubble === null || startBubble !== endBubble) return null;
  const src = sourceOf(startBubble);
  if (src === null) return null;

  /** 端点 → 源码偏移。`which`='start' 时不足处向左取,'end' 时向右取。 */
  const offsetAt = (node: Node, off: number, which: 'start' | 'end'): number | null => {
    const el = node instanceof Element ? node : node.parentElement;
    const leaf = el?.closest('[data-ms]');
    if (!leaf) return null;
    const ms = Number(leaf.getAttribute('data-ms'));
    const me = Number(leaf.getAttribute('data-me'));
    if (!Number.isFinite(ms) || !Number.isFinite(me)) return null;
    // 带标记的叶子:渲染文本比源码短,无法逐字符换算 → 取整段
    if (leaf.getAttribute('data-mx') === '1') return which === 'start' ? ms : me;
    return which === 'start' ? Math.min(me, ms + off) : Math.min(me, ms + off);
  };

  const a = offsetAt(range.startContainer, range.startOffset, 'start');
  const b = offsetAt(range.endContainer, range.endOffset, 'end');
  if (a === null || b === null) return null;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const cut = src.slice(lo, hi);
  return cut.trim() === '' ? null : cut;
}
