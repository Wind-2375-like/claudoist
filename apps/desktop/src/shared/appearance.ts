/**
 * 外观设置(M11-B / D-38):主题 + 自定义颜色 + 分部位/分中英文字体。
 * 类型与 token 目录在 shared —— 主进程存取校验、渲染层编辑器共用一份,
 * 各写一份迟早漂(与 VM 层一贯纪律相同)。
 */

export type ThemeId = 'claudoist-light' | 'claudoist-dark' | 'solarized-light' | 'solarized-dark';

/** appBg = 主区底色(主进程用它设窗口背景;原生标题栏明暗跟 dark 标志走) */
export const THEMES: { id: ThemeId; label: string; dark: boolean; appBg: string }[] = [
  { id: 'claudoist-light', label: 'Claudoist Light', dark: false, appBg: '#ffffff' },
  { id: 'claudoist-dark', label: 'Claudoist Dark', dark: true, appBg: '#171717' },
  { id: 'solarized-light', label: 'Solarized Light', dark: false, appBg: '#fdf6e3' },
  { id: 'solarized-dark', label: 'Solarized Dark', dark: true, appBg: '#002b36' },
];

/** 一个部位的字体:英文 + 中文分开设;'' = 用内置兜底栈 */
export interface FontPair {
  latin: string;
  cjk: string;
}

export interface AppearanceVM {
  theme: ThemeId;
  /**
   * 自定义颜色:token 变量名(--t-* 主区 / --p-* agent 面板)→ CSS 颜色。
   * 以内联变量写在 <html> 上,优先级高于 data-theme 的预设值 —— 所以"自定义"
   * 天然是"基于当前预设改几个色",不必整套重配。
   */
  overrides: Record<string, string>;
  fonts: {
    /** 界面(列表/侧栏/弹窗) */
    ui: FontPair;
    /** Agent 聊天面板 */
    chat: FontPair;
    /** 等宽(代码块/快捷键) */
    mono: FontPair;
  };
}

export const DEFAULT_APPEARANCE: AppearanceVM = {
  theme: 'claudoist-light',
  overrides: {},
  fonts: {
    ui: { latin: '', cjk: '' },
    chat: { latin: '', cjk: '' },
    mono: { latin: '', cjk: '' },
  },
};

/** 自定义编辑器暴露的 token(精选;全量 token 见 styles.css)。 */
export const TOKEN_GROUPS: { group: string; tokens: { v: string; label: string }[] }[] = [
  {
    group: '背景',
    tokens: [
      { v: '--t-app', label: '窗口 / 中栏' },
      { v: '--t-side', label: '侧栏' },
      { v: '--t-surface', label: '卡片 / 输入框' },
      { v: '--t-raised', label: '弹窗 / 菜单' },
      { v: '--t-inset', label: '提示盒 / 凹陷区' },
      { v: '--t-hov', label: 'Hover' },
      { v: '--t-sel', label: '选中' },
    ],
  },
  {
    group: '文字与边框',
    tokens: [
      { v: '--t-ink', label: '主文字' },
      { v: '--t-mut', label: '次要文字' },
      { v: '--t-fnt', label: '提示文字' },
      { v: '--t-line', label: '边框' },
      { v: '--t-line-soft', label: '分隔线' },
    ],
  },
  {
    group: '强调与状态',
    tokens: [
      { v: '--t-acc', label: '强调(蓝)' },
      { v: '--t-acc-soft', label: '强调底色' },
      { v: '--t-brand', label: '品牌动作(Add task)' },
      { v: '--t-danger-ink', label: '危险文字' },
      { v: '--t-warn-ink', label: '警示文字' },
      { v: '--t-ok', label: '成功' },
    ],
  },
  {
    group: 'Agent 面板',
    tokens: [
      { v: '--p-app', label: '面板背景' },
      { v: '--p-surface', label: '面板卡片' },
      { v: '--p-ink', label: '面板主文字' },
      { v: '--p-mut', label: '面板次要文字' },
      { v: '--p-line', label: '面板边框' },
      { v: '--p-acc', label: '面板强调' },
    ],
  },
];

/** 常见 macOS 字体候选(设置页 datalist;仍可自由输入任何已安装字体名)。 */
export const FONT_SUGGESTIONS = {
  latin: [
    'SF Pro Text',
    'Helvetica Neue',
    'Avenir Next',
    'Georgia',
    'Palatino',
    'Charter',
    'Optima',
    'Futura',
    'Inter',
    'JetBrains Mono',
    'SF Mono',
    'Menlo',
  ],
  cjk: [
    'PingFang SC',
    'Hiragino Sans GB',
    'Heiti SC',
    'Songti SC',
    'Kaiti SC',
    'Yuanti SC',
    'LXGW WenKai',
    'Source Han Sans SC',
    'Source Han Serif SC',
    'Noto Sans CJK SC',
    'Noto Serif CJK SC',
    'Sarasa Gothic SC',
  ],
};

const TOKEN_RE = /^--[tp]-[a-z-]{2,32}$/;
// 颜色值白名单:hex / rgb() / hsl() / color()。挡住的是"值里带分号/括号逃逸"这类注入 ——
// 虽然 setProperty 本身不可逃逸,但存进库的东西必须是颜色,不是任意字符串
// hex 只认 3/4/6/8 位(#12345 这类长度 CSS 不存在,存了也只是"标成已自定义却不生效");
// 另放行纯字母命名色(red/tomato/transparent —— 无注入面,字母而已)
const COLOR_RE =
  /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]{3,24}|(rgb|rgba|hsl|hsla|color|oklch|lab)\([0-9a-zA-Z\s.,%/-]{1,64}\))$/;
const FONT_RE = /^[\p{L}\p{N}\s._-]{0,64}$/u;

/** 存/取两侧共用的清洗:未知主题回默认,非法 token/颜色/字体名静默丢弃。 */
export function sanitizeAppearance(raw: unknown): AppearanceVM {
  const r = (raw ?? {}) as Partial<AppearanceVM>;
  const theme = THEMES.some((t) => t.id === r.theme) ? (r.theme as ThemeId) : 'claudoist-light';
  const overrides: Record<string, string> = {};
  if (r.overrides !== null && typeof r.overrides === 'object') {
    for (const [k, v] of Object.entries(r.overrides as Record<string, unknown>)) {
      if (typeof v === 'string' && TOKEN_RE.test(k) && COLOR_RE.test(v.trim())) {
        overrides[k] = v.trim();
      }
    }
  }
  const pair = (p: unknown): FontPair => {
    const q = (p ?? {}) as Partial<FontPair>;
    const clean = (s: unknown): string =>
      typeof s === 'string' && FONT_RE.test(s.trim()) ? s.trim() : '';
    return { latin: clean(q.latin), cjk: clean(q.cjk) };
  };
  const f = (r.fonts ?? {}) as Partial<AppearanceVM['fonts']>;
  return { theme, overrides, fonts: { ui: pair(f.ui), chat: pair(f.chat), mono: pair(f.mono) } };
}
