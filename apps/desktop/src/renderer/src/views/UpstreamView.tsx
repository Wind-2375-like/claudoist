import { useState } from 'react';
import { TaskDetailModal } from '../TaskDetailModal';
import { TaskTree } from '../TaskTree';
import { useUpstream } from '../hooks';

/**
 * Upstream(D-25/INV-29):来自外部日历(Google)的镜像任务。
 * 单独成一个容器 —— Inbox 只装"还没落实的想法",这些是**已经排进日历的承诺**,
 * 混在一起会把收件箱淹掉(2026-08-10 用户定案)。
 * 这里可以完成/加标签/加子任务;时间要改请去 Google 日历。
 */
export function UpstreamView(): React.JSX.Element {
  const { data, isLoading } = useUpstream();
  const [detailId, setDetailId] = useState<string | null>(null);

  if (isLoading || !data) {
    return <div className="px-8 py-6 text-sm text-neutral-400">加载中…</div>;
  }
  return (
    <div className="px-8 py-6">
      <h1 className="mb-1 text-2xl font-bold">Upstream</h1>
      <p className="mb-5 text-xs text-neutral-400">
        来自已连接 Google 日历的事件 · 可完成/加标签/加子任务;时间与标题请在 Google 日历中修改
      </p>
      {data.length === 0 ? (
        <p className="text-sm text-neutral-400">
          没有来自外部日历的任务。在 ⚙️ Settings 里连接账号并勾选要显示的日历。
        </p>
      ) : (
        <TaskTree nodes={data} onDetail={(id) => setDetailId(id)} reorderable={false} />
      )}
      {detailId && <TaskDetailModal taskId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
