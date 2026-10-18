import { useEffect, useState } from 'react';
import type { ModelInfoVM } from '../../shared/viewModels';
import type { AgentStatusVM } from './AgentSettings';
import { IconArrowUp, IconCheck, IconMode, IconStop, IconTimer } from './icons';
import { cacheTooltip, cacheWindow, type CacheRecord } from './promptCache';
import { toast } from './toast';

/**
 * Composer 底栏(2026-10-18 用户:「我想要跟 vscode 差不多的 ui」)。
 *
 * 布局照 VSCode 的 Claude Code:左边 `+` 附件、`/` 命令、缓存计时、模型药丸,
 * 右边权限模式药丸 + 发送键。模型和权限原来只能进设置弹窗改,现在底栏点一下就换 ——
 * 用户在对话中途最常调的就是这两样。
 */

export const EFFORT_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * 药丸上显示的模型名。Default 显示它此刻指向的型号(「Opus 5.5」)而不是「Default」——
 * 用户关心的是实际在用哪个;目录外的旧值如实显示原值。
 */
export function modelLabel(models: ModelInfoVM[], value: string | null): string {
  const v = value ?? 'default';
  const row = models.find((m) => m.value === v);
  if (row === undefined) return models.length === 0 && v === 'default' ? '模型' : v;
  if (v !== 'default') return row.displayName;
  const same = models.find(
    (m) =>
      m.value !== 'default' &&
      m.resolvedModel !== undefined &&
      m.resolvedModel === row.resolvedModel,
  );
  return same?.displayName ?? 'Default';
}

// ------------------------------------------------------------------ 模型菜单

export function ModelMenu({
  status,
  models,
  onChanged,
  onPicked,
  onMore,
}: {
  status: AgentStatusVM;
  models: ModelInfoVM[];
  onChanged: () => void;
  /** 选了模型就收起(effort 留着,常常是连着调的) */
  onPicked: () => void;
  onMore: () => void;
}): React.JSX.Element {
  const selected = status.model ?? 'default';
  const current = models.find((m) => m.value === selected);
  const orphan = models.length > 0 && current === undefined ? selected : null;
  return (
    <div>
      <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-mut">模型</div>
      <div className="max-h-60 overflow-y-auto">
        {models.length === 0 && <p className="px-3 py-2 text-[11px] text-fnt">读取中…</p>}
        {orphan !== null && (
          <div className="flex items-start gap-2 px-3 py-1.5 text-xs text-acc">
            <IconCheck size={14} className="mt-0.5 shrink-0" />
            <span title="这个型号已不在当前模型目录里;仍会按它起会话,换一个即可">
              {orphan}(目录外)
            </span>
          </div>
        )}
        {models.map((m) => (
          <button
            key={m.value}
            type="button"
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-hov"
            onClick={() => {
              void window.agent.setModel(m.value).then((r) => {
                // 先落盘再热切(见 ipc/agent.ts):热切失败也不回滚,下次起会话就是它
                if (r.error !== undefined) toast(`已保存,但当前会话切换失败:${r.error}`);
                onChanged();
              });
              onPicked();
            }}
          >
            <span className="mt-0.5 w-3.5 shrink-0 text-acc">
              {selected === m.value && <IconCheck size={14} />}
            </span>
            <span className="min-w-0">
              <span className="block text-xs text-ink">{m.displayName}</span>
              {m.description !== undefined && (
                <span className="block truncate text-[11px] text-fnt">{m.description}</span>
              )}
            </span>
          </button>
        ))}
      </div>
      <div className="border-t border-line-soft px-3 py-2">
        <div className="mb-1 text-[11px] font-semibold text-mut">思考深度</div>
        <div className="flex flex-wrap gap-1">
          {EFFORTS.map((e) => {
            // 可用档位由**当前模型**决定;不支持的禁用并说明,而不是点了没反应
            const supported =
              current?.supportsEffort !== false &&
              (current?.supportedEffortLevels === undefined ||
                current.supportedEffortLevels.includes(e));
            const off = status.thinking === 'off';
            return (
              <button
                key={e}
                type="button"
                disabled={!supported || off}
                title={
                  off
                    ? '思考已关闭,effort 不生效'
                    : supported
                      ? undefined
                      : `${current?.displayName ?? '当前模型'}不支持 ${EFFORT_LABEL[e] ?? e}`
                }
                className={`rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-30 ${
                  status.effort === e
                    ? 'border-acc bg-acc-soft text-acc'
                    : 'border-line text-mut hover:bg-hov'
                }`}
                onClick={() => {
                  void window.agent.setEffort(e).then((r) => {
                    if (r.error !== undefined) toast(r.error);
                    onChanged();
                  });
                }}
              >
                {EFFORT_LABEL[e]}
              </button>
            );
          })}
        </div>
      </div>
      <MenuFooter onClick={onMore}>更多设置(思考显示、Claude Code 版本、护栏)…</MenuFooter>
    </div>
  );
}

// ------------------------------------------------------------------ 权限模式

export const MODE_SHORT: Record<string, string> = {
  plan: '只读',
  manual: '逐条确认',
  acceptEdits: '自动改已有',
  auto: '自动',
  bypass: '全部放行',
};
/** 颜色是安全信号,不是装饰:越放得开越"暖" */
export const MODE_TONE: Record<string, string> = {
  plan: 'text-mut',
  manual: 'text-ok',
  acceptEdits: 'text-warn-ink',
  auto: 'text-warn-ink',
  bypass: 'text-danger-ink',
};

export function ModeMenu({
  mode,
  onChanged,
  onPicked,
  onMore,
}: {
  mode: string;
  onChanged: () => void;
  onPicked: () => void;
  onMore: () => void;
}): React.JSX.Element {
  const [modes, setModes] = useState<{ id: string; label: string; hint: string }[]>([]);
  useEffect(() => {
    void window.agent.permissionModes().then((r) => setModes(r.modes));
  }, []);
  return (
    <div>
      <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-mut">权限模式</div>
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-hov"
          onClick={() => {
            onPicked();
            void window.agent.setPermissionMode(m.id).then((r) => {
              if (r.error !== undefined) return toast(r.error);
              // 只读 ↔ 可写会改变工具面,必须重起会话才生效
              if (r.needsRestart === true && (m.id === 'plan' || mode === 'plan')) {
                toast('已切换 —— 新建会话后完全生效(当前会话的工具面不会变)');
              }
              onChanged();
            });
          }}
        >
          <IconMode mode={m.id} size={14} className={`mt-0.5 shrink-0 ${MODE_TONE[m.id] ?? ''}`} />
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-ink">{m.label}</span>
            <span className="block text-[11px] text-fnt">{m.hint}</span>
          </span>
          <span className="mt-0.5 w-3.5 shrink-0 text-acc">
            {mode === m.id && <IconCheck size={14} />}
          </span>
        </button>
      ))}
      <MenuFooter onClick={onMore}>始终允许、审计记录…</MenuFooter>
    </div>
  );
}

// ------------------------------------------------------------------ 「/」命令

export interface SlashItem {
  /** 键入 `/` 后按它过滤,也显示在行尾 */
  id: string;
  group: string;
  label: string;
  hint?: string;
  disabledReason?: string;
  run: () => void;
}

export function filterSlash(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return items;
  return items.filter(
    (it) =>
      it.id.startsWith(q) ||
      it.label.toLowerCase().includes(q) ||
      (it.hint?.toLowerCase().includes(q) ?? false),
  );
}

export function SlashMenu({
  items,
  active,
  onHover,
  onPick,
}: {
  items: SlashItem[];
  active: number;
  onHover: (i: number) => void;
  onPick: (it: SlashItem) => void;
}): React.JSX.Element {
  if (items.length === 0) {
    return (
      <p className="px-3 py-2 text-[11px] text-fnt">没有匹配的命令 —— 回车会按原文发给 Claude。</p>
    );
  }
  let lastGroup = '';
  return (
    <div className="max-h-72 overflow-y-auto py-1">
      {items.map((it, i) => {
        const head = it.group !== lastGroup ? it.group : null;
        lastGroup = it.group;
        return (
          <div key={it.id}>
            {head !== null && (
              <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold text-fnt">{head}</div>
            )}
            <button
              type="button"
              disabled={it.disabledReason !== undefined}
              title={it.disabledReason}
              className={`flex w-full items-baseline gap-2 px-3 py-1 text-left disabled:opacity-40 ${
                i === active ? 'bg-hov' : ''
              }`}
              onMouseEnter={() => onHover(i)}
              // mousedown 而不是 click:不让输入框先失焦
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(it);
              }}
            >
              <span className="shrink-0 text-xs text-ink">{it.label}</span>
              {it.hint !== undefined && (
                <span className="min-w-0 flex-1 truncate text-[11px] text-fnt">{it.hint}</span>
              )}
              <span className="ml-auto shrink-0 font-mono text-[10px] text-fnt">/{it.id}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ 小件

export function CacheBadge({
  rec,
  now,
}: {
  rec: CacheRecord | null;
  now: number;
}): React.JSX.Element | null {
  const w = cacheWindow(rec, now);
  if (w.kind === 'unknown') return null;
  return (
    <span
      role="status"
      title={cacheTooltip(w)}
      className={`flex h-7 shrink-0 items-center gap-0.5 rounded-md px-1 text-[11px] ${
        w.kind === 'warm' ? 'text-mut' : 'text-fnt opacity-60'
      }`}
    >
      <IconTimer size={14} />
      {w.kind === 'warm' && <span className="tabular-nums">{w.minutesLeft}m</span>}
    </span>
  );
}

export function SendButton({
  canSend,
  busy,
  onSend,
  onStop,
}: {
  canSend: boolean;
  busy: boolean;
  onSend: () => void;
  onStop: () => void;
}): React.JSX.Element {
  // 回复中、输入框又是空的 → 这颗键就是「停」;一旦输入了东西,又变回发送(忙时照发、排队)
  if (busy && !canSend) {
    return (
      <button
        type="button"
        title="中断这一轮(会话继续)"
        aria-label="中断"
        className="flex h-7 w-7 items-center justify-center rounded-md bg-acc text-on-acc hover:bg-acc-strong"
        onClick={onStop}
      >
        <IconStop size={14} />
      </button>
    );
  }
  return (
    <button
      type="button"
      title={busy ? '发送(排在这一轮之后)' : '发送(Enter)'}
      aria-label="发送"
      disabled={!canSend}
      className="flex h-7 w-7 items-center justify-center rounded-md bg-acc text-on-acc hover:bg-acc-strong disabled:opacity-35"
      onClick={onSend}
    >
      <IconArrowUp size={15} />
    </button>
  );
}

function MenuFooter({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="w-full border-t border-line-soft px-3 py-1.5 text-left text-[11px] text-mut hover:bg-hov hover:text-ink"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
