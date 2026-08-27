import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPEARANCE,
  sanitizeAppearance,
  THEMES,
  TOKEN_GROUPS,
} from '../src/shared/appearance';

/**
 * 外观设置的清洗(D-38):settings 表能被 CLI/手工改到,坏值不该让窗口起不来;
 * overrides 是要写进 <html> 内联样式的东西,进库前必须证明"只能是颜色"。
 */

describe('sanitizeAppearance', () => {
  it('空/坏输入回默认', () => {
    expect(sanitizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance('garbage')).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance({ theme: 'hotdog-stand' }).theme).toBe('claudoist-light');
  });

  it('合法主题原样保留', () => {
    for (const t of THEMES) {
      expect(sanitizeAppearance({ theme: t.id }).theme).toBe(t.id);
    }
  });

  it('overrides:合法 token+颜色放行;非法键/值静默丢弃', () => {
    const r = sanitizeAppearance({
      overrides: {
        '--t-app': '#fdf6e3',
        '--p-ink': 'rgb(147 161 161)',
        '--t-acc-soft': 'rgb(38 139 210 / 0.12)',
        '--t-brand': 'tomato', // 命名色放行(纯字母无注入面;是不是真颜色由渲染层 CSS.supports 提示)
        'background-image': 'url(evil)', // 非 token 名
        '--t-app2': 'red', // token 名带数字,键校验拒绝
        '--t-line': '#fff; content: "x"', // 值注入
        '--t-side': '#12345', // 5 位 hex 不是合法 CSS,存了 = 标成已自定义却不生效
        '--t-hov': '#1234567', // 7 位同理
      },
    });
    expect(Object.keys(r.overrides).sort()).toEqual([
      '--p-ink',
      '--t-acc-soft',
      '--t-app',
      '--t-brand',
    ]);
  });

  it('字体名:常规名放行(含中文/空格/连字符),越界字符丢弃', () => {
    const r = sanitizeAppearance({
      fonts: {
        ui: { latin: 'SF Pro Text', cjk: '霞鹜文楷' },
        chat: { latin: 'JetBrains Mono', cjk: 'Source Han Serif SC' },
        mono: { latin: 'Menlo"; }; body{', cjk: '' }, // 引号注入 → 丢
      },
    });
    expect(r.fonts.ui).toEqual({ latin: 'SF Pro Text', cjk: '霞鹜文楷' });
    expect(r.fonts.chat.cjk).toBe('Source Han Serif SC');
    expect(r.fonts.mono.latin).toBe('');
  });

  it('编辑器暴露的每个 token 名都过得了 sanitize 的键校验', () => {
    const all = TOKEN_GROUPS.flatMap((g) => g.tokens.map((t) => t.v));
    const r = sanitizeAppearance({
      overrides: Object.fromEntries(all.map((v) => [v, '#123456'])),
    });
    expect(Object.keys(r.overrides).sort()).toEqual([...all].sort());
  });
});
