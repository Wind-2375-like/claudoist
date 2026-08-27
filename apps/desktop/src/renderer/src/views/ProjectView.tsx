import { useState } from 'react';
import { TaskCard } from '../TaskCard';
import { TaskDetailModal } from '../TaskDetailModal';
import { TaskTree } from '../TaskTree';
import { useProjectView } from '../hooks';

/**
 * 单项目视图(D-21/D-22):根任务树(与 Inbox 同 TaskTree;子任务显示为缩进树),
 * 底部内联 Add task(默认落本项目)。
 */
export function ProjectView({ projectId }: { projectId: string }): React.JSX.Element {
  const { data, isLoading } = useProjectView(projectId);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (isLoading) return <div className="px-8 py-6 text-sm text-neutral-400">加载中…</div>;
  if (!data) return <div className="px-8 py-6 text-sm text-neutral-400">项目不存在。</div>;

  return (
    <div className="px-8 py-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h1 className="text-2xl font-bold"># {data.name}</h1>
        {data.complete && (
          <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">已完成</span>
        )}
        {data.deadline && (
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-500">
            🎯 {data.deadline}
          </span>
        )}
        {data.doneCount > 0 && (
          <span className="text-xs text-neutral-400">已完成 {data.doneCount}</span>
        )}
      </div>
      {data.tasks.length === 0 && !adding && (
        <p className="mb-2 text-sm text-neutral-400">
          还没有任务 —— 用下方 Add task 补第一个行动。
        </p>
      )}
      {data.tasks.length > 0 && <TaskTree nodes={data.tasks} onDetail={setDetailId} />}
      {!data.complete && (
        <div className="mt-2">
          {adding ? (
            <TaskCard
              mode="add"
              inline
              initialLocation={data.id}
              onClose={() => setAdding(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-neutral-400 hover:text-red-600"
            >
              <span className="text-lg leading-none">＋</span> Add task
            </button>
          )}
        </div>
      )}
      {detailId && <TaskDetailModal taskId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
