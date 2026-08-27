import { useState } from 'react';
import { TaskCard } from '../TaskCard';
import { TaskDetailModal } from '../TaskDetailModal';
import { TaskTree } from '../TaskTree';
import { useProjectView } from '../hooks';
import { toast } from '../toast';

/**
 * 单项目视图(D-21/D-22):根任务树(与 Inbox 同 TaskTree;子任务显示为缩进树),
 * 底部内联 Add task(默认落本项目)。
 */
export function ProjectView({ projectId }: { projectId: string }): React.JSX.Element {
  const { data, isLoading } = useProjectView(projectId);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (isLoading) return <div className="px-8 py-6 text-sm text-fnt">加载中…</div>;
  if (!data) return <div className="px-8 py-6 text-sm text-fnt">项目不存在。</div>;

  return (
    <div className="px-8 py-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h1 className="text-2xl font-bold"># {data.name}</h1>
        {data.complete && (
          <span className="rounded bg-ok-soft px-1.5 py-0.5 text-xs text-ok">已完成</span>
        )}
        {data.deleted && (
          <span className="rounded bg-danger-soft px-1.5 py-0.5 text-xs text-danger-ink">
            在回收站
          </span>
        )}
        {data.deadline && (
          <span className="rounded bg-inset px-1.5 py-0.5 font-mono text-xs text-mut">
            🎯 {data.deadline}
          </span>
        )}
        {data.doneCount > 0 && <span className="text-xs text-fnt">已完成 {data.doneCount}</span>}
      </div>
      {data.tasks.length === 0 && !adding && (
        <p className="mb-2 text-sm text-fnt">还没有任务 —— 用下方 Add task 补第一个行动。</p>
      )}
      {/*
        回收站里的项目 = **只读视图 + 恢复入口**(INV-34)。
        软删如果没有任何可见的恢复入口,对用户就等于"不可见的硬删",
        那软删唯一不可替代的价值(误删能拿回来)就没了 —— 所以这个入口必须存在。
        ⌘K 搜得到已删项目,点进来就是这里。
      */}
      {data.deleted && (
        <div className="mb-4 rounded-lg border border-danger bg-danger-soft px-3 py-2.5 text-xs text-danger-ink">
          <p>
            这个项目在回收站里
            {data.deletedAt !== null && `(${data.deletedAt.slice(0, 16).replace('T', ' ')} 删除)`}
            。下面只是留档,不能再加任务。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded border border-danger bg-surface px-2.5 py-1 hover:bg-danger-soft"
              onClick={() => {
                void window.gtd.projectRestore(data.id, false).then((r) => {
                  if ('error' in r) return toast(`恢复失败:${r.error}`);
                  toast(`「${data.name}」已恢复`);
                });
              }}
            >
              只恢复项目
            </button>
            {data.restorableTaskCount > 0 && (
              <button
                type="button"
                className="rounded bg-danger px-2.5 py-1 text-on-danger hover:bg-danger-strong"
                onClick={() => {
                  void window.gtd.projectRestore(data.id, true).then((r) => {
                    if ('error' in r) return toast(`恢复失败:${r.error}`);
                    toast(`「${data.name}」已恢复,连同 ${data.restorableTaskCount} 个任务`);
                  });
                }}
              >
                连同 {data.restorableTaskCount} 个任务一起恢复
              </button>
            )}
          </div>
        </div>
      )}
      {data.tasks.length > 0 && <TaskTree nodes={data.tasks} onDetail={setDetailId} />}
      {!data.complete && !data.deleted && (
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
              className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-fnt hover:text-brand"
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
