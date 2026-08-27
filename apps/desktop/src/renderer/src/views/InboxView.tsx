import { useState } from 'react';
import { TaskCard } from '../TaskCard';
import { TaskDetailModal } from '../TaskDetailModal';
import { TaskTree } from '../TaskTree';
import { useInbox } from '../hooks';

/**
 * Inbox(D-20/D-22):bucket='inbox' 的任务树——task 生在这里,不挪不消失。
 * 子任务显示为缩进树(M5R5);单击行 → 详情弹窗;右键编辑/Move;想让 Claude 理清就右栏对话。
 */
export function InboxView(): React.JSX.Element {
  const { data, isLoading } = useInbox();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <div className="px-8 py-6">
      <h1 className="mb-4 text-2xl font-bold">Inbox</h1>
      {isLoading && <p className="text-sm text-fnt">加载中…</p>}
      {data && data.length === 0 && !adding && (
        <p className="mb-2 text-sm text-fnt">收件箱是空的 — 头脑清爽 ✨</p>
      )}
      {data && data.length > 0 && <TaskTree nodes={data} onDetail={setDetailId} />}
      <div className="mt-2">
        {adding ? (
          <TaskCard mode="add" inline onClose={() => setAdding(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-fnt hover:text-brand"
          >
            <span className="text-lg leading-none">＋</span> Add task
          </button>
        )}
      </div>
      {detailId && <TaskDetailModal taskId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
