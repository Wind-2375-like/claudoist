import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseInline, parseTable, renderMarkdown, splitRow } from '../src/renderer/src/markdown';

/**
 * 表格与数学公式(2026-09-11 用户:「agent 的数学公式和 markdown 表格没法渲染」)。
 *
 * 测的是**解析层**:分隔符识别、单元格切分、每个叶子的源码区间 —— 这些是"复制还原
 * Markdown 原文"的依据。KaTeX 的排版本身在真机验(测试环境是 node,没有 DOM)。
 */

const invariants = (src: string): void => {
  for (const l of parseInline(src, 0)) {
    const cut = src.slice(l.start, l.end);
    if (l.math !== undefined)
      expect(cut).toContain(l.text); // 区间含分隔符,TeX 在里面
    else expect(cut).toContain(l.text);
    if (l.inexact !== true) expect(cut).toBe(l.text);
  }
};

describe('行内公式', () => {
  it('$x^2$:识别为公式叶子,区间含两侧 $,inexact', () => {
    const src = '面积是 $\\pi r^2$ 平方米';
    const ls = parseInline(src, 0);
    expect(ls.map((l) => l.text)).toEqual(['面积是 ', '\\pi r^2', ' 平方米']);
    const m = ls[1]!;
    expect(m.math).toEqual({ display: false });
    expect(m.inexact).toBe(true);
    expect(src.slice(m.start, m.end)).toBe('$\\pi r^2$');
    invariants(src);
  });

  it('"花了 $5 和 $10" 不是公式(Pandoc 规则:$ 后不能空白、闭合 $ 后不能跟数字)', () => {
    const ls = parseInline('花了 $5 和 $10', 0);
    expect(ls.every((l) => l.math === undefined)).toBe(true);
    expect(ls.map((l) => l.text).join('')).toBe('花了 $5 和 $10');
  });

  it('\\$ 转义显示为 $;公式里的 \\$ 不当闭合符', () => {
    const esc = parseInline('价格 \\$100', 0);
    expect(esc.map((l) => l.text).join('')).toBe('价格 $100');
    expect(esc[1]!.inexact).toBe(true);
    const inMath = parseInline('$\\$5 + x$', 0);
    expect(inMath).toHaveLength(1);
    expect(inMath[0]!.text).toBe('\\$5 + x');
  });

  it('\\( … \\) 与 $$ … $$(行内出现的块级公式)', () => {
    const a = parseInline('设 \\(E = mc^2\\)。', 0);
    expect(a[1]).toMatchObject({ text: 'E = mc^2', math: { display: false } });
    const b = parseInline('结论:$$\\sum_i x_i$$ 成立', 0);
    expect(b[1]).toMatchObject({ text: '\\sum_i x_i', math: { display: true } });
    invariants('设 \\(E = mc^2\\)。');
    invariants('结论:$$\\sum_i x_i$$ 成立');
  });

  it('未闭合的 $ / \\( 当普通文本,不吞后文', () => {
    for (const src of ['单个 $ 号', '开了 \\(没关', '$$ 也没关']) {
      const ls = parseInline(src, 0);
      expect(ls.every((l) => l.math === undefined)).toBe(true);
      expect(ls.map((l) => l.text).join('')).toBe(src);
    }
  });

  it('公式与粗体/代码混排仍满足区间性质', () => {
    for (const src of ['**重点** $a+b$ 和 `code`', '$x$ 与 $y$ 之间', '[链](u) $z$'])
      invariants(src);
  });
});

describe('表格:单元格切分与源码偏移', () => {
  it('有外框与无外框都切得出来,偏移指向去空白后的首字符', () => {
    const l1 = '| 名称 | 数量 |';
    expect(splitRow(l1, 0)).toEqual([
      { text: '名称', at: 2 },
      { text: '数量', at: 7 },
    ]);
    const l2 = '名称 | 数量';
    expect(splitRow(l2, 100)).toEqual([
      { text: '名称', at: 100 },
      { text: '数量', at: 105 },
    ]);
    for (const c of splitRow(l1, 0)) expect(l1.slice(c.at, c.at + c.text.length)).toBe(c.text);
  });

  it('行内代码里的 | 与 \\| 不切分', () => {
    const cells = splitRow('| `a|b` | x \\| y |', 0);
    expect(cells.map((c) => c.text)).toEqual(['`a|b`', 'x \\| y']);
  });

  it('parseTable:表头 + 分隔行 + 数据行;对齐;列数补齐/截断;行数', () => {
    const lines = [
      '| 项 | 值 | 备注 |',
      '|:--|:-:|--:|',
      '| a | 1 |',
      '| b | 2 | 多 | 出来 |',
      '',
      '后文',
    ];
    const starts = [0];
    for (let i = 1; i < lines.length; i += 1)
      starts.push(starts[i - 1]! + lines[i - 1]!.length + 1);
    const t = parseTable(lines, 0, starts)!;
    expect(t).not.toBeNull();
    expect(t.header.map((c) => c.text)).toEqual(['项', '值', '备注']);
    expect(t.aligns).toEqual(['left', 'center', 'right']);
    expect(t.rows.map((r) => r.map((c) => c.text))).toEqual([
      ['a', '1', ''],
      ['b', '2', '多'],
    ]);
    expect(t.lineCount).toBe(4);
    // 数据行单元格的偏移落在它自己那一行里
    const b = t.rows[1]![0]!;
    expect(lines.join('\n').slice(b.at, b.at + 1)).toBe('b');
  });

  it('流式:表头刚出来、分隔行还没到 → 不是表(先按段落显示)', () => {
    expect(parseTable(['| a | b |'], 0, [0])).toBeNull();
    expect(parseTable(['| a | b |', '正文'], 0, [0, 10])).toBeNull();
    // 列数对不上的分隔行也不算
    expect(parseTable(['| a | b |', '|---|'], 0, [0, 10])).toBeNull();
  });

  it('renderMarkdown 输出 <table>,紧跟在段落后面也能断开', () => {
    const html = renderToStaticMarkup(
      renderMarkdown('说明如下\n| k | v |\n|---|---|\n| x | 1 |\n\n结束') as React.ReactElement,
    );
    expect(html).toContain('<table');
    expect((html.match(/<tr>/g) ?? []).length).toBe(2);
    expect(html).toContain('说明如下');
    expect(html).toContain('结束');
  });
});

describe('块级公式', () => {
  it('$$ 独占行 … $$ 独占行 → 一个块;未闭合时按段落原样显示', () => {
    const closed = renderToStaticMarkup(
      renderMarkdown('推导:\n$$\nE = mc^2\n$$\n完毕') as React.ReactElement,
    );
    // 块级公式是一个带源码区间的 span(KaTeX 在浏览器里往里写内容;SSR 下为空)
    expect(closed).toMatch(/<span[^>]*data-mx="1"[^>]*class="my-1 block/);
    expect(closed).not.toContain('E = mc^2'); // 没被当普通文本渲染
    const open = renderToStaticMarkup(renderMarkdown('推导:\n$$\nE = mc^2') as React.ReactElement);
    expect(open).toContain('E = mc^2'); // 未闭合:原文可见,不闪红字
  });

  it('\\[ … \\] 与同一行闭合的 $$ a $$ 同样是块', () => {
    for (const src of ['\\[\n\\int_0^1 x\\,dx\n\\]', '$$ a + b $$']) {
      const html = renderToStaticMarkup(renderMarkdown(src) as React.ReactElement);
      expect(html).toMatch(/class="my-1 block/);
    }
  });
});
