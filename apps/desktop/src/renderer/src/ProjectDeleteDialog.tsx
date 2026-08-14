import { useEffect, useState } from 'react';
import { toast } from './toast';
import type { ProjectDeletionPreviewVM } from '../../shared/viewModels';

/**
 * 删除项目的确认框(INV-34)。
 *
 * ## 为什么不能用 window.confirm
 *
 * 这里是**三选**:一并删掉内容 / 把内容退回 Inbox / 什么都别做。
 * `confirm` 只有"确定 / 取消"两个出口,把前两者映射上去意味着**「取消」会变成一次真实写入**
 * —— 那是最坏的一种交互,也直接违反 INV-15(等待用户明确同意)。
 *
 * ## 数字必须来自预检,不能自己数
 *
 * 确认框上写的条数与 usecase 返回的 consequences 走**同一个** `projectDeletionPreview`。
 * 各数各的迟早出现"确认时说 12 条、做完 toast 说 9 条",那会直接摧毁用户对确认框的信任。
 */
export function ProjectDeleteDialog({
  projectId,
  projectName,
  onClose,
  onDeleted,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const [pv, setPv] = useState<ProjectDeletionPreviewVM | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.gtd.projectDeletionPreview(projectId).then(setPv);
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = (contents: 'delete' | 'toInbox'): void => {
    if (busy) return;
    setBusy(true);
    void window.gtd.projectDelete(projectId, contents).then((r) => {
      setBusy(false);
      if ('error' in r) return toast(`删除失败:${r.error}`);
      const c = r.consequences as {
        deletedTaskCount?: number;
        movedToInboxCount?: number;
        keptDoneTaskCount?: number;
        unresolvedWaitingCount?: number;
      };
      const bits: string[] = [];
      if ((c.deletedTaskCount ?? 0) > 0) bits.push(`连同 ${c.deletedTaskCount} 个任务`);
      if ((c.movedToInboxCount ?? 0) > 0) bits.push(`${c.movedToInboxCount} 个任务已退回 Inbox`);
      if ((c.keptDoneTaskCount ?? 0) > 0) bits.push(`${c.keptDoneTaskCount} 条完成记录保留`);
      if ((c.unresolvedWaitingCount ?? 0) > 0) {
        bits.push(`⚠ 还有 ${c.unresolvedWaitingCount} 条未解决的等待项指向它`);
      }
      toast(`已把「${projectName}」移入回收站${bits.length > 0 ? ` — ${bits.join(';')}` : ''}`);
      onDeleted();
    });
  };

  const n = pv?.activeTaskCount ?? 0;

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/30 pt-28">
      <div className="w-[480px] max-w-[92vw] rounded-xl border border-neutral-200 bg-white p-4 shadow-2xl">
        <h2 className="text-sm font-semibold">删除项目「{projectName}」</h2>

        {pv === null ? (
          <p className="mt-3 text-xs text-neutral-400">读取中…</p>
        ) : (
          <>
            <p className="mt-2 text-xs leading-relaxed text-neutral-600">
              项目会进回收站(可以恢复)。
              {n > 0 ? (
                <>
                  它下面还有 <strong>{n}</strong> 个未完成任务 ——
                  <strong>这些任务不能留在已删项目里</strong>
                  (留下的话它们看不见,却照样出现在 Today 与择事候选里)。请选一个去向:
                </>
              ) : (
                '它下面没有未完成的任务。'
              )}
            </p>

            {(pv.doneTaskCount > 0 ||
              pv.unresolvedWaitingCount > 0 ||
              pv.mirrorTaskCount > 0 ||
              pv.recurringTaskCount > 0) && (
              <ul className="mt-2 space-y-0.5 rounded bg-neutral-50 px-2.5 py-2 text-[11px] text-neutral-500">
                {pv.doneTaskCount > 0 && (
                  <li>· {pv.doneTaskCount} 条已完成的任务留在项目里(完成记录不会被抹掉)</li>
                )}
                {pv.mirrorTaskCount > 0 && (
                  <li>· 其中 {pv.mirrorTaskCount} 条来自 Google 日历,时间仍归日历那边</li>
                )}
                {pv.recurringTaskCount > 0 && (
                  <li className="text-amber-700">
                    · ⚠ 其中 {pv.recurringTaskCount} 条是循环任务的当前一次 —— 删除会
                    <strong>结束这些循环</strong>(INV-36.11)
                  </li>
                )}
                {pv.unresolvedWaitingCount > 0 && (
                  <li className="text-amber-700">
                    · ⚠ {pv.unresolvedWaitingCount} 条未解决的等待项仍指向它,本次不动
                  </li>
                )}
              </ul>
            )}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
              >
                取消
              </button>
              {n > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run('toInbox')}
                  className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-40"
                  title="项目归类错了,但这些事还要做"
                >
                  把 {n} 个任务退回 Inbox
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => run('delete')}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-40"
                title="项目取消了,里面的事也不做了"
              >
                {n > 0 ? `连同 ${n} 个任务一起删` : '删除项目'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
