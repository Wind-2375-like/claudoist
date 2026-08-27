import { useState } from 'react';
import { TaskDetailModal } from '../TaskDetailModal';
import { TaskRow } from '../TaskRow';
import { TaskTree } from '../TaskTree';
import { useBucket, useCompleted } from '../hooks';

/** Someday/Maybe 与 Reference:对应容器的任务树(不参与 Today/engage)。 */
export function BucketView({ kind }: { kind: 'someday' | 'reference' }): React.JSX.Element {
  const { data, isLoading } = useBucket(kind);
  const [detailId, setDetailId] = useState<string | null>(null);
  const title = kind === 'someday' ? 'Someday/Maybe' : 'Reference';
  return (
    <div className="px-8 py-6">
      <h1 className="mb-1 text-2xl font-bold">{title}</h1>
      <p className="mb-4 text-xs text-neutral-400">
        {kind === 'someday'
          ? '孵化中的想法 —— 不出现在 Today,想启动就 Move 回 Inbox 或项目'
          : '参考资料型条目 —— 不参与执行'}
      </p>
      {isLoading && <p className="text-sm text-neutral-400">加载中…</p>}
      {data && data.length === 0 && <p className="text-sm text-neutral-400">空的。</p>}
      {data && data.length > 0 && <TaskTree nodes={data} onDetail={setDetailId} />}
      {detailId && <TaskDetailModal taskId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

/** Completed:done 任务记录(最近优先,上限 200;平铺,增长归档策略见 ROADMAP)。 */
export function CompletedView(): React.JSX.Element {
  const { data, isLoading } = useCompleted();
  const [detailId, setDetailId] = useState<string | null>(null);
  return (
    <div className="px-8 py-6">
      <h1 className="mb-1 text-2xl font-bold">Completed</h1>
      <p className="mb-4 text-xs text-neutral-400">
        做完了什么,一目了然。{data && data.length >= 200 ? '(只显示最近 200 条)' : ''}
      </p>
      {isLoading && <p className="text-sm text-neutral-400">加载中…</p>}
      {data && data.length === 0 && <p className="text-sm text-neutral-400">还没有完成记录。</p>}
      <ul className="space-y-0.5">
        {data?.map((t) => (
          <li key={t.id}>
            <TaskRow task={t} showCompletedAt onDetail={() => setDetailId(t.id)} />
          </li>
        ))}
      </ul>
      {detailId && <TaskDetailModal taskId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
