import { useEffect, useState } from 'react';
import { useContexts, useEngage } from './hooks';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskRow } from './TaskRow';

/**
 * Focus / Engage(INV-20,M7a)。GTD 的四标准择事模型:
 * **情境 → 可用时间 → 精力 → 优先级**,顺序即算法。
 *
 * calendar-first:今天已排期的任务先摆出来 —— 它们是已经承诺过的,轮不到"挑"。
 * 过滤与排序全部由 domain `engageCandidates` 决定,这里只呈现;deadline **不参与排序**
 * (INV-20.4),只随行显示。
 */
const ENERGIES = [
  { v: 'low', label: '低' },
  { v: 'medium', label: '中' },
  { v: 'high', label: '高' },
] as const;
const MINUTES = [15, 30, 60, 120];

export function FocusPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const contexts = useContexts();
  const [contextId, setContextId] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(60);
  const [energy, setEnergy] = useState<'low' | 'medium' | 'high'>('medium');
  const [detailId, setDetailId] = useState<string | null>(null);

  // 首屏直接出结果:默认取第一个 context(= CLI `engage` 不带 --context 的口径),
  // 否则 calendar-first 这段"已承诺的事"要等用户点一下才出现,与其语义相悖
  const firstContextId = contexts.data?.[0]?.id;
  useEffect(() => {
    if (contextId === null && firstContextId !== undefined) setContextId(firstContextId);
  }, [contextId, firstContextId]);

  const engage = useEngage(contextId, minutes, energy);
  const data = engage.data;

  return (
    // z-30:详情弹窗(z-40/50)要能盖在 Focus 之上
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 pt-16">
      <div className="flex max-h-[80vh] w-[720px] max-w-[95vw] flex-col rounded-xl border border-neutral-200 bg-white shadow-2xl">
        <div className="flex items-center border-b border-neutral-100 px-5 py-3">
          <h2 className="text-base font-semibold">▶ Focus</h2>
          <span className="ml-2 text-xs text-neutral-400">情境 → 时间 → 精力 → 优先级</span>
          <button
            type="button"
            className="ml-auto text-lg leading-none text-neutral-400 hover:text-neutral-700"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* calendar-first:已排期的先处理,不参与"挑" */}
          {data && data.calendarFirst.length > 0 && (
            <div className="mb-4 rounded-md border border-blue-200 bg-blue-50/60 p-3">
              <p
                className="mb-1.5 text-xs font-medium text-blue-800"
                title="已承诺的硬性日程,与下面所选情境无关"
              >
                今天已排期({data.calendarFirst.length})—— 先处理这些
              </p>
              <ul className="space-y-0.5">
                {data.calendarFirst.map((t) => (
                  <li key={t.id}>
                    <TaskRow task={t} onDetail={() => setDetailId(t.id)} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 1) 情境 */}
          <p className="mb-1.5 text-xs font-medium text-neutral-500">1 · 现在在什么情境?</p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {(contexts.data ?? []).map((c) => (
              <button
                key={c.id}
                type="button"
                className={`rounded-md border px-2 py-1 text-xs ${
                  contextId === c.id
                    ? 'border-blue-400 bg-blue-50 text-blue-700'
                    : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'
                }`}
                onClick={() => setContextId(c.id)}
              >
                {c.name}
                <span className="ml-1 text-neutral-400">{c.activeTaskCount}</span>
              </button>
            ))}
          </div>

          {/* 2) 可用时间 3) 精力 */}
          <div className="mb-4 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-neutral-500">2 · 有多少时间</span>
              {MINUTES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`rounded-md border px-2 py-1 text-xs ${
                    minutes === m
                      ? 'border-blue-400 bg-blue-50 text-blue-700'
                      : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'
                  }`}
                  onClick={() => setMinutes(m)}
                >
                  {m}m
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-neutral-500">3 · 精力</span>
              {ENERGIES.map((e) => (
                <button
                  key={e.v}
                  type="button"
                  className={`rounded-md border px-2 py-1 text-xs ${
                    energy === e.v
                      ? 'border-blue-400 bg-blue-50 text-blue-700'
                      : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'
                  }`}
                  onClick={() => setEnergy(e.v)}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>

          {/* 4) 候选 */}
          {contextId === null ? (
            <p className="text-sm text-neutral-400">
              {contexts.data?.length === 0 ? '还没有情境,先建一个再来挑事做。' : '载入中…'}
            </p>
          ) : data === undefined ? (
            <p className="text-sm text-neutral-400">计算中…</p>
          ) : data.candidates.length === 0 ? (
            <p className="text-sm text-neutral-400">
              这个情境下没有 ≤{minutes} 分钟且精力匹配的任务。换个情境,或把时间/精力放宽。
            </p>
          ) : (
            <>
              <p className="mb-1.5 text-xs font-medium text-neutral-500">
                4 · 挑一件做(按优先级;截止日不参与排序)
              </p>
              <ul className="space-y-0.5">
                {data.candidates.map((t) => (
                  <li key={t.id} className="rounded-md border border-neutral-100">
                    <TaskRow task={t} onDetail={() => setDetailId(t.id)} />
                  </li>
                ))}
              </ul>
              {data.matched > data.candidates.length && (
                <p className="mt-2 text-[11px] text-neutral-400">
                  另有 {data.matched - data.candidates.length}{' '}
                  条符合条件的任务未列出(只显示优先级最高的 {data.topN} 条)。
                </p>
              )}
            </>
          )}
        </div>
      </div>
      {detailId !== null && <TaskDetailModal taskId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
