import { describe, expect, it } from 'vitest';
import { parseInline } from '../src/renderer/src/markdown';

/**
 * 行内解析的**源码区间**。
 *
 * 这些偏移是"选中一段渲染后的文本、复制出 Markdown 原文"唯一的依据 —— 偏移错一位,
 * 用户粘出来的就是缺半个标记、粘回去不成立的片段。所以这里逐条钉死两个性质:
 *
 * 1. 每个叶子的 `[start, end)` 切出来的源码,必须**包含**它渲染出的可见文本;
 * 2. 纯文本叶子必须**逐字符相等**(否则选区偏移无法换算)。
 */
const invariants = (src: string): void => {
  for (const l of parseInline(src, 0)) {
    const cut = src.slice(l.start, l.end);
    expect(cut).toContain(l.text);
    if (l.inexact !== true) expect(cut).toBe(l.text);
  }
};

describe('行内 Markdown 的源码区间', () => {
  it('纯文本:区间即原文', () => {
    const [l] = parseInline('就是一句话', 0);
    expect(l).toMatchObject({ text: '就是一句话', start: 0, end: 5 });
    expect(l!.inexact).toBeUndefined();
  });

  it('粗体:区间**含**两侧标记,标记为 inexact', () => {
    const ls = parseInline('前**粗**后', 0);
    expect(ls.map((l) => l.text)).toEqual(['前', '粗', '后']);
    const bold = ls[1]!;
    expect(bold.inexact).toBe(true);
    expect('前**粗**后'.slice(bold.start, bold.end)).toBe('**粗**');
  });

  it('行内代码与链接同规', () => {
    const code = parseInline('用 `run_filter` 查', 0)[1]!;
    expect(code.code).toBe(true);
    expect('用 `run_filter` 查'.slice(code.start, code.end)).toBe('`run_filter`');

    const src = '见 [文档](https://x.dev) 吧';
    const link = parseInline(src, 0)[1]!;
    expect(link.href).toBe('https://x.dev');
    expect(src.slice(link.start, link.end)).toBe('[文档](https://x.dev)');
  });

  it('base 偏移会被叠加(块级传入行首偏移)', () => {
    const l = parseInline('abc', 100)[0]!;
    expect([l.start, l.end]).toEqual([100, 103]);
  });

  it('未闭合的标记当普通文本,不吞后文', () => {
    const ls = parseInline('这里有个 ** 没闭合', 0);
    expect(ls.map((l) => l.text).join('')).toBe('这里有个 ** 没闭合');
  });

  it('各种混排都满足两条区间性质', () => {
    for (const src of [
      '普通',
      '**只有粗体**',
      '`code` 开头',
      '结尾 **粗**',
      '**a**`b`*c*',
      '中文**粗体**混排 `code` 和 [链接](u)',
      '**',
      '``',
      '[](',
    ]) {
      invariants(src);
    }
  });

  it('拼接所有叶子的文本 = 去掉标记后的可见文本(不丢字)', () => {
    const src = '前**粗**中`码`后';
    expect(
      parseInline(src, 0)
        .map((l) => l.text)
        .join(''),
    ).toBe('前粗中码后');
  });
});
