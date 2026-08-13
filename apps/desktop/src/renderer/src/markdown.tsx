import type { ReactNode } from 'react';

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
 * 带标记的叶子(粗体、行内代码、链接)渲染文本比源码短,无法逐字符对应 ——
 * 这类叶子标 `data-mx="1"`(inexact),复制时**整段取用**。
 * 结果:纯文本部分字符级精确,样式片段最多多带上它自己的标记符,不会少给。
 *
 * ## 支持的子集
 *
 * 标题、粗体、斜体、行内代码、围栏代码块、无序/有序列表、引用、分隔线、链接、段落。
 * 表格与嵌套列表不支持 —— agent 的回复里几乎不出现,不值得为它们把这份代码变复杂。
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
}

const leafSpan = (l: Leaf, key: number): ReactNode => {
  let cls = '';
  if (l.code) cls = 'rounded bg-neutral-900/60 px-1 py-0.5 font-mono text-[0.92em]';
  if (l.bold) cls += ' font-semibold';
  if (l.italic) cls += ' italic';
  const props = {
    key,
    'data-ms': l.start,
    'data-me': l.end,
    ...(l.inexact === true ? { 'data-mx': '1' } : {}),
    ...(cls !== '' ? { className: cls.trim() } : {}),
  };
  if (l.href !== undefined) {
    return (
      <a {...props} href={l.href} className={`${cls} text-blue-400 underline`.trim()}>
        {l.text}
      </a>
    );
  }
  return <span {...props}>{l.text}</span>;
};

/** 行内解析:**粗**、*斜*、`码`、[文](url)。返回带源码区间的叶子序列。导出供测试。 */
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

  while (i < src.length) {
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

interface Block {
  render: (key: number) => ReactNode;
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
            className="my-1 overflow-x-auto rounded-md bg-neutral-900 p-2 text-[12px] leading-relaxed"
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
      blocks.push({ render: (k) => <hr key={k} className="my-2 border-neutral-700" /> });
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
          <blockquote
            key={k}
            className="my-1 border-l-2 border-neutral-600 pl-2 text-neutral-400 italic"
          >
            {quoted.map(([t, a], n) => (
              <p key={n}>{inl(t, a)}</p>
            ))}
          </blockquote>
        ),
      });
      i = j;
      continue;
    }

    const listItem = (l: string): RegExpExecArray | null => /^\s*([-*]|\d+\.)\s+(.*)$/.exec(l);
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
                <span className="mr-1 text-neutral-500">{ordered ? mark : '·'}</span>
                {inl(t, a)}
              </li>
            ))}
          </ul>
        ),
      });
      i = j;
      continue;
    }

    // 普通段落:连续非空行合成一段(保留换行)
    const para: [string, number][] = [];
    let j = i;
    while (
      j < lines.length &&
      lines[j]!.trim() !== '' &&
      !/^```/.test(lines[j]!) &&
      !/^#{1,6}\s/.test(lines[j]!) &&
      !/^>\s?/.test(lines[j]!) &&
      !listItem(lines[j]!) &&
      !/^(-{3,}|\*{3,})\s*$/.test(lines[j]!)
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
