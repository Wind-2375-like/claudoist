import { useEffect, useState } from 'react';
import { toast } from './toast';
import type { RewindPreviewVM } from '../../shared/viewModels';

/**
 * 回滚确认框(INV-35)。
 *
 * 用户接受"回滚不可撤销",但**不可撤销 ≠ 可以不吭声地吃掉他自己的改动**。所以这里做三件事:
 *
 * 1. **预检数字与执行结果同源**(与 ProjectDeleteDialog 同规):框上写的条数来自
 *    `agent:rewind.preview`,执行走同一条链,不会出现"确认说 5 条、做完 3 条"。
 * 2. **硬删单独一行醒目列出** —— 那是整套机制里唯一真正拿不回来的部分(改字段能贴回旧值,
 *    但 agent 新建的任务被回滚 = 行整个消失)。
 * 3. **冲突逐条摆出来**:agent 写完之后又被你自己(或 Google 同步、另一条会话)改过的字段,
 *    回滚会把那些改动一起抹掉。有冲突时**默认按钮是取消**。
 */
export function RewindDialog({
  conversationId,
  turnIds,
  alsoFork,
  onClose,
  onDone,
}: {
  conversationId: string;
  /** 锚点轮到最后一轮的全部 turnId */
  turnIds: string[];
  /** 第三项:分叉 + 回滚 */
  alsoFork: boolean;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const [pv, setPv] = useState<RewindPreviewVM | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.agent.rewindPreview(conversationId, turnIds).then(setPv);
  }, [conversationId, turnIds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = (): void => {
    if (busy) return;
    setBusy(true);
    void window.agent.rewindApply(conversationId, turnIds).then((r) => {
      setBusy(false);
      if (r.error !== undefined) return toast(`回滚失败:${r.error}`);
      toast(`已撤销 ${String(r.entryCount ?? 0)} 次改动${alsoFork ? ',并从这里分叉' : ''}`);
      onDone();
    });
  };

  const hasConflict = (pv?.conflicts.length ?? 0) > 0;

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 pt-24">
      <div className="w-[520px] max-w-[92vw] rounded-xl border border-neutral-700 bg-neutral-900 p-4 text-neutral-100 shadow-2xl">
        <h2 className="text-sm font-semibold">{alsoFork ? '分叉并回滚到这里' : '回滚到这里'}</h2>

        {pv === null ? (
          <p className="mt-3 text-xs text-neutral-500">正在核对会撤销哪些改动…</p>
        ) : pv.entryCount === 0 ? (
          <>
            <p className="mt-2 text-xs text-neutral-400">这一轮之后 agent 没有改过任何数据。</p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
              >
                知道了
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-xs leading-relaxed text-neutral-300">
              将撤销这一轮及其之后 agent 做的 <strong>{pv.entryCount}</strong> 次改动,
              把任务数据恢复到你发那条消息之前的样子。
              <strong className="text-amber-300">这个操作没有撤销。</strong>
            </p>

            <ul className="mt-2 space-y-0.5 rounded bg-neutral-950/60 px-2.5 py-2 text-[11px] text-neutral-400">
              {pv.tools.map((t) => (
                <li key={t.name}>
                  · <span className="font-mono text-neutral-300">{t.name}</span> ×{t.count}
                </li>
              ))}
              {pv.hardDeleteCount > 0 && (
                <li className="mt-1 text-red-300">
                  · ⚠ 其中 {pv.hardDeleteCount} 条是 agent **新建**的东西,回滚 = 整行删除, 拿不回来
                </li>
              )}
              {pv.foreignEntryCount > 0 && (
                <li className="text-amber-300">
                  · 链里有 {pv.foreignEntryCount} 条来自**别的会话**,会一并撤销
                </li>
              )}
            </ul>

            {hasConflict && (
              <div className="mt-2 rounded border border-amber-800 bg-amber-950/50 px-2.5 py-2 text-[11px] text-amber-200">
                <p className="font-medium">
                  这些改动之后有人又动过 —— 回滚会把这些后来的改动一起抹掉:
                </p>
                <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto">
                  {pv.conflicts.map((c, i) => (
                    <li key={i}>· {c.detail}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  hasConflict
                    ? 'bg-neutral-200 text-neutral-900'
                    : 'border border-neutral-700 hover:bg-neutral-800'
                }`}
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={run}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-40"
              >
                {hasConflict ? '仍然回滚(连同上面的改动)' : '回滚'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
