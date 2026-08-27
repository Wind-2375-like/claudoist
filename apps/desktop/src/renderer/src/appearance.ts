import type { AppearanceVM, FontPair } from '../../shared/appearance';

/**
 * 把外观设置落到 DOM(M11-B/D-38):
 * - 主题:<html data-theme="…">,token 值由 styles.css 的预设提供
 * - 自定义颜色:内联 CSS 变量(优先级高于预设 —— "基于预设改几个色"因此天然成立)
 * - 字体:组装「英文, 中文, 兜底」栈写进 --font-ui/--font-chat/--font-mono
 *
 * 全部经 style.setProperty:值只能作为该属性的值存在,写不出第二条声明(注入面为零);
 * 字体名一律加引号(名字里有空格是常态)。
 */

const UI_FALLBACK = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`;
const MONO_FALLBACK = `ui-monospace, 'SF Mono', Menlo, Consolas, 'PingFang SC', monospace`;

function stack(p: FontPair, fallback: string): string {
  const parts: string[] = [];
  if (p.latin !== '') parts.push(JSON.stringify(p.latin));
  if (p.cjk !== '') parts.push(JSON.stringify(p.cjk));
  parts.push(fallback);
  return parts.join(', ');
}

export function applyAppearance(a: AppearanceVM): void {
  const root = document.documentElement;
  root.dataset['theme'] = a.theme;
  // 先清掉上一次的自定义,再放本次的(否则删掉某个自定义色后旧值还粘着)
  for (const prop of [...root.style]) {
    if (prop.startsWith('--t-') || prop.startsWith('--p-') || prop.startsWith('--font-')) {
      root.style.removeProperty(prop);
    }
  }
  for (const [k, v] of Object.entries(a.overrides)) root.style.setProperty(k, v);
  root.style.setProperty('--font-ui', stack(a.fonts.ui, UI_FALLBACK));
  root.style.setProperty('--font-chat', stack(a.fonts.chat, `var(--font-ui)`));
  root.style.setProperty('--font-code', stack(a.fonts.mono, MONO_FALLBACK));
}
