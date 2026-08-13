import { useEffect, useRef, useState } from 'react';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import type { RepeatInputVM, RepeatPresetVM, RepeatPreviewVM } from '../../shared/viewModels';

/**
 * 循环入口(D-37/INV-36):日期面板/详情里的「🔁 重复」按钮 + Todoist 式预设菜单 +
 * Custom 对话框。
 *
 * 三条纪律:
 * - **不在渲染层算任何日期**(DESIGN §4.1 / INV-36.13):预设文案(「每月 12 日」的 12)
 *   来自 `gtd:repeat.presets`,预览三次来自 `gtd:repeat.preview` —— 月末/闰年正是
 *   最容易漂的地方,两套日历运算迟早分叉。
 * - **菜单必须复用 ContextMenu**(portal 到 body + fixed + 贴边翻转):详情右栏与中栏都是
 *   `overflow-y-auto`,祖先 overflow 非 visible 时 absolute 后代会被裁掉、z-index 无效
 *   (ContextMenu.tsx 头注记的就是这个已修过一次的 bug)。
 * - **校验内联报错、不静默回退**:Custom 里选出非法组合(如结束日早于计划日)时红字说明,
 *   保存按钮禁用。
 */

const label = (v: RepeatInputVM | null, fallback = '重复'): string => {
  if (v === null) return fallback;
  // 已选中时按钮文本用现算预览的短语?短语由 domain 生成,按钮上先给通用「已设循环」,
  // 具体文案由调用方传 short(TaskVM.repeatShort)—— 新建场景还没有 VM,退化显示单位
  const unitZh = { day: '天', week: '周', month: '月', year: '年' }[v.unit];
  return `每${(v.every ?? 1) > 1 ? ` ${v.every} ` : ''}${unitZh}`;
};

export function RepeatButton({
  anchor,
  value,
  valueLabel,
  onChange,
}: {
  /** 锚点日 = 当前选择的计划日;空串 = 未选日期(点开时提示先选日期) */
  anchor: string;
  value: RepeatInputVM | null;
  /** 已存在任务的 repeatShort(domain 生成);新建场景可不传 */
  valueLabel?: string | null | undefined;
  onChange: (v: RepeatInputVM | null) => void;
}): React.JSX.Element {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [presets, setPresets] = useState<RepeatPresetVM[]>([]);
  const [custom, setCustom] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);

  const open = (): void => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    setMenuAt({ x: r.left, y: r.bottom + 4 });
    if (anchor !== '') void window.gtd.repeatPresets(anchor).then(setPresets);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`rounded-md border px-2 py-1 text-xs ${
          value !== null
            ? 'border-blue-400 bg-blue-50 text-blue-700'
            : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'
        }`}
        onClick={open}
      >
        🔁 {value !== null ? (valueLabel ?? label(value)) : '重复'}
      </button>
      {menuAt !== null && (
        <ContextMenu x={menuAt.x} y={menuAt.y} onClose={() => setMenuAt(null)}>
          {anchor === '' ? (
            <div className="px-3 py-1.5 text-xs text-neutral-400">先选一个计划日期</div>
          ) : (
            <>
              {presets.map((p) => (
                <ContextMenuItem
                  key={p.key}
                  onClick={() => {
                    onChange(p.input);
                    setMenuAt(null);
                  }}
                >
                  {p.label}
                </ContextMenuItem>
              ))}
              <ContextMenuItem
                onClick={() => {
                  setMenuAt(null);
                  setCustom(true);
                }}
              >
                自定义…
              </ContextMenuItem>
              {value !== null && (
                <ContextMenuItem
                  danger
                  onClick={() => {
                    onChange(null);
                    setMenuAt(null);
                  }}
                >
                  取消循环
                </ContextMenuItem>
              )}
            </>
          )}
        </ContextMenu>
      )}
      {custom && (
        <RepeatCustomDialog
          anchor={anchor}
          initial={value}
          onClose={() => setCustom(false)}
          onSave={(v) => {
            onChange(v);
            setCustom(false);
          }}
        />
      )}
    </>
  );
}

const WEEKDAYS: { key: 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su'; zh: string }[] = [
  { key: 'mo', zh: '一' },
  { key: 'tu', zh: '二' },
  { key: 'we', zh: '三' },
  { key: 'th', zh: '四' },
  { key: 'fr', zh: '五' },
  { key: 'sa', zh: '六' },
  { key: 'su', zh: '日' },
];

/** Custom 对话框:Based on / Every N 单位 / 星期多选(每 1 周)/ Ends + 预览三次。 */
export function RepeatCustomDialog({
  anchor,
  initial,
  onClose,
  onSave,
}: {
  anchor: string;
  initial: RepeatInputVM | null;
  onClose: () => void;
  onSave: (v: RepeatInputVM) => void;
}): React.JSX.Element {
  const [from, setFrom] = useState<'scheduled' | 'completed'>(initial?.from ?? 'scheduled');
  const [every, setEvery] = useState(initial?.every ?? 1);
  const [unit, setUnit] = useState<RepeatInputVM['unit']>(initial?.unit ?? 'week');
  const [weekdays, setWeekdays] = useState<('mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su')[]>(
    initial?.weekdays ?? [],
  );
  const [until, setUntil] = useState(initial?.until ?? '');
  const [pv, setPv] = useState<RepeatPreviewVM | null>(null);

  const input: RepeatInputVM = {
    unit,
    every,
    from,
    until: until === '' ? null : until,
    ...(unit === 'week' && weekdays.length > 0 ? { weekdays } : {}),
  };

  // 预览与写入走同一 normalizeRepeat(同源):非法组合在这里就红出来
  const key = JSON.stringify(input);
  useEffect(() => {
    void window.gtd.repeatPreview(JSON.parse(key) as RepeatInputVM, anchor).then(setPv);
  }, [key, anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const invalid = pv?.error !== undefined;
  const seg = (active: boolean): string =>
    `rounded-md border px-2.5 py-1 text-xs ${active ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'}`;

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 pt-24">
      <div className="w-[480px] max-w-[92vw] rounded-xl border border-neutral-200 bg-white p-4 shadow-2xl">
        <h2 className="text-sm font-semibold">自定义循环</h2>

        <div className="mt-3 flex items-center gap-2 text-xs">
          <span className="w-16 text-neutral-500">基于</span>
          <button
            type="button"
            className={seg(from === 'scheduled')}
            onClick={() => setFrom('scheduled')}
          >
            计划日期
          </button>
          <button
            type="button"
            className={seg(from === 'completed')}
            onClick={() => setFrom('completed')}
          >
            完成日期
          </button>
          <span className="text-neutral-400">
            {from === 'completed' ? '从实际完成那天起算,永不追赶' : '按日历网格推进,逾期补齐到未来'}
          </span>
        </div>

        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="w-16 text-neutral-500">每</span>
          <input
            type="number"
            min={1}
            max={999}
            className="w-16 rounded border border-neutral-300 px-2 py-1 outline-none focus:border-blue-400"
            value={every}
            onChange={(e) => setEvery(Number(e.target.value))}
          />
          <select
            className="rounded border border-neutral-300 px-2 py-1 outline-none focus:border-blue-400"
            value={unit}
            onChange={(e) => {
              const u = e.target.value as RepeatInputVM['unit'];
              setUnit(u);
              if (u !== 'week') setWeekdays([]);
            }}
          >
            <option value="day">天</option>
            <option value="week">周</option>
            <option value="month">月</option>
            <option value="year">年</option>
          </select>
          {unit === 'month' && <span className="text-neutral-400">几号取自计划日</span>}
          {unit === 'year' && <span className="text-neutral-400">几月几号取自计划日</span>}
        </div>

        {unit === 'week' && (
          <div className="mt-2 flex items-center gap-1 text-xs">
            <span className="w-16 shrink-0 text-neutral-500">星期</span>
            {WEEKDAYS.map((w) => (
              <button
                key={w.key}
                type="button"
                className={seg(weekdays.includes(w.key))}
                onClick={() =>
                  setWeekdays((prev) =>
                    prev.includes(w.key) ? prev.filter((x) => x !== w.key) : [...prev, w.key],
                  )
                }
              >
                {w.zh}
              </button>
            ))}
            <span className="ml-1 shrink-0 text-neutral-400">不选 = 计划日那天</span>
          </div>
        )}

        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="w-16 text-neutral-500">结束</span>
          <button type="button" className={seg(until === '')} onClick={() => setUntil('')}>
            从不
          </button>
          <input
            type="date"
            className="rounded border border-neutral-300 px-2 py-1 outline-none focus:border-blue-400"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
          {until !== '' && <span className="text-neutral-400">含当天</span>}
        </div>

        <div className="mt-3 rounded bg-neutral-50 px-2.5 py-2 text-xs">
          {pv === null ? (
            <span className="text-neutral-400">…</span>
          ) : pv.error !== undefined ? (
            <span className="text-red-600">{pv.error}</span>
          ) : pv.next.length === 0 ? (
            <span className="text-amber-600">结束日早于第一次发生 —— 这个循环一次都不会发生</span>
          ) : (
            <span className="text-neutral-600">接下来:{pv.next.join('、')}</span>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={invalid}
            onClick={() => onSave(input)}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
