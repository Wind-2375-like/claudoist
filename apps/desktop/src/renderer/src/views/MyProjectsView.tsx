import { useState } from 'react';
import { ProjectModal } from '../ProjectModal';
import { useProjects } from '../hooks';

/**
 * My Projects 总览(D-21):平面项目列表 + 进度条(done/(done+active))。
 * 点击项目名进入单项目视图(由 App 路由)。
 */
export function MyProjectsView({
  onOpenProject,
}: {
  onOpenProject: (id: string) => void;
}): React.JSX.Element {
  const { data, isLoading } = useProjects();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="px-8 py-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-2xl font-bold">My Projects</h1>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
        >
          ＋ 新建项目
        </button>
      </div>
      {isLoading && <p className="text-sm text-neutral-400">加载中…</p>}
      {data && data.length === 0 && <p className="text-sm text-neutral-400">还没有项目。</p>}
      <ul className="max-w-2xl space-y-1">
        {data?.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-4 rounded-md px-2 py-2 hover:bg-neutral-50"
          >
            <button
              type="button"
              onClick={() => onOpenProject(p.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
            >
              <span className="text-neutral-400">#</span>
              <span className="truncate">{p.name}</span>
              {p.deadline && (
                <span className="shrink-0 font-mono text-xs text-neutral-400">{p.deadline}</span>
              )}
            </button>
            <div className="flex w-44 shrink-0 items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200">
                <div
                  className="h-full rounded-full bg-blue-500"
                  style={{ width: `${p.progressPct}%` }}
                />
              </div>
              <span className="w-9 text-right font-mono text-xs text-neutral-500">
                {p.progressPct}%
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-xs text-neutral-400">
        进度 = 已完成任务 / (已完成 + 未完成);侧栏项目名右侧数字 = 未完成任务数
      </p>
      {addOpen && <ProjectModal onClose={() => setAddOpen(false)} />}
    </div>
  );
}
