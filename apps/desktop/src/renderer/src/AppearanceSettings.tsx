import { useEffect, useRef, useState } from 'react';
import type { AppearanceVM, FontPair, ThemeId } from '../../shared/appearance';
import {
  DEFAULT_APPEARANCE,
  FONT_SUGGESTIONS,
  THEMES,
  TOKEN_GROUPS,
  sanitizeAppearance,
} from '../../shared/appearance';
import { applyAppearance } from './appearance';

/**
 * 外观设置(M11-B/D-38):主题卡片 + 自定义颜色 + 分部位/分中英文字体。
 *
 * 交互纪律:
 * - **所见即所得**:任何改动立即 applyAppearance 生效,持久化 400ms 防抖落 settings 表 ——
 *   调颜色是试错型操作,"改了要按保存才能看"会让人来回点到烦。
 * - 自定义颜色是**基于当前预设的差量**(overrides):换预设不清差量、「重置自定义」才清,
 *   两个动作分开,误触换主题不会毁掉调了半天的色。
 * - 颜色输入 = 色板 + 文本双通道:色板只认 #rrggbb,带透明度的 token(*-soft)手输
 *   rgb(… / .x) 也合法(sanitize 白名单放行)。
 */

const swatches: Record<ThemeId, { app: string; panel: string; acc: string; brand: string }> = {
  'claudoist-light': { app: '#ffffff', panel: '#171717', acc: '#2563eb', brand: '#dc2626' },
  'claudoist-dark': { app: '#171717', panel: '#0d0d0d', acc: '#60a5fa', brand: '#ef4444' },
  'solarized-light': { app: '#fdf6e3', panel: '#002b36', acc: '#268bd2', brand: '#dc322f' },
  'solarized-dark': { app: '#002b36', panel: '#00212b', acc: '#268bd2', brand: '#dc322f' },
};

const FONT_PARTS: { key: keyof AppearanceVM['fonts']; label: string; hint: string }[] = [
  { key: 'ui', label: '界面', hint: '列表 / 侧栏 / 弹窗' },
  { key: 'chat', label: 'Agent 聊天', hint: '右侧面板与消息气泡' },
  { key: 'mono', label: '等宽', hint: '代码块 / 快捷键' },
];

export function AppearanceSettings(): React.JSX.Element {
  const [a, setA] = useState<AppearanceVM | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void window.appearance.get().then(setA);
  }, []);

  const update = (next: AppearanceVM): void => {
    setA(next); // 输入框保留原始文本(打字打到一半也不清空)
    // **实时生效与落库走同一条清洗**:曾经 live 用原始值、落库才 sanitize ——
    // 输入 red 当场变红、库里却没存,重开设置后界面与编辑器分叉(审查抓到)。
    // 现在没通过清洗的值两边都不生效,输入框红框提示(见 invalidValue)。
    const clean = sanitizeAppearance(next);
    applyAppearance(clean);
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void window.appearance.set(clean), 400);
  };

  /**
   * 该 token 的输入非空但不会生效 → 红框点出来。两层判定:
   * 白名单(挡注入,存储侧同款)+ CSS.supports(挡"纯字母但不是颜色名"的 foobar ——
   * 白名单只看形状,浏览器才知道哪些词真的是颜色)。
   */
  const invalidValue = (token: string): boolean => {
    const v = a?.overrides[token];
    if (v === undefined || v === '') return false;
    const passed =
      sanitizeAppearance({ theme: a!.theme, overrides: { [token]: v }, fonts: a!.fonts }).overrides[
        token
      ] !== undefined;
    return !passed || !CSS.supports('color', v);
  };

  if (a === null) return <p className="text-sm text-fnt">加载中…</p>;

  /** 当前 token 的生效值(override 优先,否则读预设的计算值)—— 色板与占位符都用它 */
  const effective = (token: string): string => {
    const o = a.overrides[token];
    if (o !== undefined) return o;
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  };

  const setOverride = (token: string, value: string): void => {
    const overrides = { ...a.overrides };
    if (value === '') delete overrides[token];
    else overrides[token] = value;
    update({ ...a, overrides });
  };

  const setFont = (part: keyof AppearanceVM['fonts'], patch: Partial<FontPair>): void => {
    update({ ...a, fonts: { ...a.fonts, [part]: { ...a.fonts[part], ...patch } } });
  };

  const fontStack = (p: FontPair): string =>
    [p.latin, p.cjk]
      .filter((x) => x !== '')
      .map((x) => JSON.stringify(x))
      .concat('var(--font-ui)')
      .join(', ');

  return (
    <div className="space-y-6">
      {/* ---- 主题 ---- */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">主题</h3>
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map((t) => {
            const sw = swatches[t.id];
            const active = a.theme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => update({ ...a, theme: t.id })}
                className={`flex items-center gap-3 rounded-lg border p-2.5 text-left ${
                  active ? 'border-acc bg-acc-soft' : 'border-line hover:bg-hov'
                }`}
              >
                {/* 迷你预览:主区 + 面板双色块,角标是强调/品牌色 */}
                <span
                  className="relative h-9 w-14 shrink-0 overflow-hidden rounded border border-line"
                  style={{ background: sw.app }}
                >
                  <span
                    className="absolute inset-y-0 right-0 w-1/3"
                    style={{ background: sw.panel }}
                  />
                  <span
                    className="absolute bottom-1 left-1 h-2 w-2 rounded-full"
                    style={{ background: sw.acc }}
                  />
                  <span
                    className="absolute bottom-1 left-4 h-2 w-2 rounded-full"
                    style={{ background: sw.brand }}
                  />
                </span>
                <span>
                  <span className="block text-sm">{t.label}</span>
                  <span className="block text-[11px] text-fnt">{t.dark ? '深色' : '浅色'}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ---- 自定义颜色 ---- */}
      <section>
        <div className="mb-2 flex items-center">
          <h3 className="text-sm font-semibold">自定义颜色</h3>
          <span className="ml-2 text-[11px] text-fnt">基于当前主题改;留空 = 跟随主题</span>
          {Object.keys(a.overrides).length > 0 && (
            <button
              type="button"
              className="ml-auto text-xs text-danger-ink hover:underline"
              onClick={() => update({ ...a, overrides: {} })}
            >
              重置全部自定义({Object.keys(a.overrides).length})
            </button>
          )}
        </div>
        <div className="space-y-3">
          {TOKEN_GROUPS.map((g) => (
            <div key={g.group} className="rounded-lg border border-line-soft p-2.5">
              <p className="mb-1.5 text-xs font-medium text-mut">{g.group}</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {g.tokens.map((tk) => {
                  const cur = effective(tk.v);
                  const overridden = a.overrides[tk.v] !== undefined;
                  const hex = /^#[0-9a-fA-F]{6}$/.test(cur) ? cur : '#888888';
                  return (
                    <label key={tk.v} className="flex items-center gap-2 text-xs">
                      <input
                        type="color"
                        value={hex}
                        onChange={(e) => setOverride(tk.v, e.target.value)}
                        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-line bg-transparent"
                        title={tk.v}
                      />
                      <span className={`w-28 shrink-0 ${overridden ? 'text-acc' : 'text-mut'}`}>
                        {tk.label}
                      </span>
                      <input
                        type="text"
                        value={a.overrides[tk.v] ?? ''}
                        placeholder={cur}
                        onChange={(e) => setOverride(tk.v, e.target.value.trim())}
                        className={`min-w-0 flex-1 rounded border bg-surface px-1.5 py-0.5 font-mono text-[11px] outline-none placeholder:text-fnt focus:border-acc ${
                          invalidValue(tk.v) ? 'border-danger' : 'border-line'
                        }`}
                        title={
                          invalidValue(tk.v)
                            ? '不是合法颜色(hex / rgb() / hsl() / 命名色)'
                            : undefined
                        }
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---- 字体 ---- */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">字体</h3>
        <p className="mb-2 text-[11px] text-fnt">
          每个部位可分别设英文与中文字体(英文字体在前,拉丁字符命中它,汉字落到中文字体); 留空 =
          系统默认。填系统里装过的字体名即可。
        </p>
        <div className="space-y-2.5">
          {FONT_PARTS.map((part) => {
            const p = a.fonts[part.key];
            return (
              <div key={part.key} className="rounded-lg border border-line-soft p-2.5">
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className="text-xs font-medium">{part.label}</span>
                  <span className="text-[11px] text-fnt">{part.hint}</span>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    list="font-latin-suggestions"
                    value={p.latin}
                    placeholder="英文字体(如 SF Pro Text)"
                    onChange={(e) => setFont(part.key, { latin: e.target.value })}
                    className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-xs outline-none placeholder:text-fnt focus:border-acc"
                  />
                  <input
                    type="text"
                    list="font-cjk-suggestions"
                    value={p.cjk}
                    placeholder="中文字体(如 PingFang SC)"
                    onChange={(e) => setFont(part.key, { cjk: e.target.value })}
                    className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-xs outline-none placeholder:text-fnt focus:border-acc"
                  />
                </div>
                <p
                  className="mt-1.5 truncate rounded bg-inset px-2 py-1 text-sm"
                  style={{ fontFamily: fontStack(p) }}
                >
                  预览 Preview — 把大石头先放进罐子 The quick brown fox 0123
                </p>
              </div>
            );
          })}
        </div>
        <datalist id="font-latin-suggestions">
          {FONT_SUGGESTIONS.latin.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <datalist id="font-cjk-suggestions">
          {FONT_SUGGESTIONS.cjk.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </section>

      {/* ---- 恢复默认 + 错误日志 ---- */}
      <section className="flex items-center gap-3 border-t border-line-soft pt-3">
        <button
          type="button"
          className="rounded-md border border-line px-2.5 py-1 text-xs hover:bg-hov"
          onClick={() => update(structuredClone(DEFAULT_APPEARANCE))}
        >
          全部恢复默认
        </button>
        <button
          type="button"
          className="rounded-md border border-line px-2.5 py-1 text-xs hover:bg-hov"
          onClick={() => void window.appearance.openLogs()}
          title="主进程与界面崩溃都会落到 logs/errors.log"
        >
          打开错误日志目录
        </button>
      </section>
    </div>
  );
}
