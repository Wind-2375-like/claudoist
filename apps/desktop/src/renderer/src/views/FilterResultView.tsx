import { useState } from 'react';
import { useFilterRun } from '../hooks';
import { TaskDetailModal } from '../TaskDetailModal';
import { TaskRow } from '../TaskRow';

/**
 * 一条查询的结果(点开过滤器、或点标签时进入)。顶层逗号分段 → 多个分段各自成列表,
 * 分段标题即该段查询原文(INV-33:逗号是视图指令,不是"或")。
 *
 * 未知标签/项目**不报错**,而是给一条黄色提示:保存时名字还在、之后被删掉,不该让
 * 一个存好的过滤器变成错误页;但也不能假装它匹配到了什么。
 */
export function FilterResultView({
  title,
  query,
}: {
  title: string;
  query: string;
}): React.JSX.Element {
  const { data, isLoading } = useFilterRun(query);
  const [detailId, setDetailId] = useState<string | null>(null);
  const total = data?.sections.reduce((n, s) => n + s.tasks.length, 0) ?? 0;
  const unknown = [
    ...(data?.unknownLabels ?? []).map((n) => `@${n}`),
    ...(data?.unknownProjects ?? []).map((n) => `#${n}`),
  ];

  return (
    <div className="px-8 py-6">
      <h1 className="mb-1 text-2xl font-bold">{title}</h1>
      <p className="mb-4 font-mono text-xs text-neutral-400">{query}</p>

      {data?.error != null && (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          查询语法错误:{data.error}
        </p>
      )}
      {unknown.length > 0 && (
        <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {unknown.join('、')} 不存在 —— 这些条件恒不成立,结果会偏少。改一下过滤器?
        </p>
      )}

      {isLoading && <p className="text-sm text-neutral-400">计算中…</p>}
      {data?.error == null && !isLoading && total === 0 && (
        <p className="text-sm text-neutral-400">没有任务匹配这条查询。</p>
      )}

      {(data?.sections ?? []).map((sec, i) => (
        <section key={`${sec.source}:${i}`} className="mb-6">
          {(data?.sections.length ?? 0) > 1 && (
            <p className="mb-1 font-mono text-xs font-medium text-neutral-500">
              {sec.source}
              <span className="ml-2 text-neutral-400">{sec.tasks.length}</span>
            </p>
          )}
          <ul>
            {sec.tasks.map((t) => (
              <li key={t.id} className="border-b border-neutral-100">
                <TaskRow task={t} onDetail={() => setDetailId(t.id)} showCompletedAt={t.done} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {detailId !== null && <TaskDetailModal taskId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
