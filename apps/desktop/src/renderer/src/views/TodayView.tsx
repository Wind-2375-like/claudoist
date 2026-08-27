import { useState } from 'react';
import { TaskCard } from '../TaskCard';
import { TaskDetailModal } from '../TaskDetailModal';
import { TaskRow } from '../TaskRow';
import { useGoogleStatus, useGoogleSync, useToday } from '../hooks';
import { toast } from '../toast';

/** ISO 日期(YYYY-MM-DD)加 n 天,UTC 计算避免时区偏移。 */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Today(D-21/D-23 日历统一)——单一任务列表(计划 ≤ 今天 ∪ 截止 ≤ 今天,来自
 * Inbox 或项目;计划段内全天在前、再按 startTime),无独立"硬边界"日程段
 * (原 CalendarItem 已并入带时间任务)。底部内联 Add task(默认 date=今天)。
 * 拖拽:拖到底部区块 = 推迟到明天;上下排序留 M6b/日历。
 */
export function TodayView(): React.JSX.Element {
  const { data, isLoading } = useToday();
  const [editId, setEditId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overPostpone, setOverPostpone] = useState(false);
  // D-25:Google 事件已镜像成任务,直接出现在下面的任务列表里;这里只保证"看 Today 时同步一次"
  const googleStatus = useGoogleStatus();
  useGoogleSync(
    data?.today ?? '1970-01-01',
    data?.today ?? '1970-01-01',
    googleStatus.data?.connected === true && data !== undefined,
  );

  if (isLoading || !data) {
    return <div className="px-8 py-6 text-sm text-fnt">加载中…</div>;
  }

  // 拖到底部区块 → 推迟到明天(改 scheduledDate;M5R6 决策:Today 手动排序留 M6)。
  // 基准日取主进程时钟的**当前** today(跨零点后渲染层缓存的 data.today 可能是昨天,
  // 用它 +1 会把"明天"算成今天,推迟失效)。
  const postpone = async (id: string): Promise<void> => {
    const fresh = await window.gtd.today();
    const r = await window.gtd.taskUpdate({
      id,
      patch: { scheduledDate: addDays(fresh.today, 1) },
    });
    if ('error' in r) toast(`推迟失败:${r.error}`);
  };
  return (
    <div className="px-8 py-6">
      <h1 className="mb-1 text-2xl font-bold">Today</h1>
      <p className="mb-5 text-xs text-fnt">{data.today}</p>

      {data.tasks.length === 0 && !adding && (
        <p className="mb-2 text-sm text-fnt">今天没有待办任务 🎉</p>
      )}
      <ul className="space-y-0.5">
        {data.tasks.map((t) => (
          <li key={t.id}>
            {editId === t.id ? (
              <TaskCard mode="edit" inline task={t} onClose={() => setEditId(null)} />
            ) : (
              // 上下拖拽换位留到 M6(Today/日历重做);当前仅支持拖到底部推迟到明天
              <div
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', t.id);
                  setDraggingId(t.id);
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setOverPostpone(false);
                }}
                className={draggingId === t.id ? 'opacity-40' : undefined}
              >
                <TaskRow
                  task={t}
                  onDetail={() => setDetailId(t.id)}
                  onEdit={() => setEditId(t.id)}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      {draggingId && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setOverPostpone(true);
          }}
          onDragLeave={() => setOverPostpone(false)}
          onDrop={(e) => {
            e.preventDefault();
            const id = draggingId;
            setDraggingId(null);
            setOverPostpone(false);
            if (id) void postpone(id);
          }}
          className={`mt-2 flex items-center justify-center gap-2 rounded-md border border-dashed py-3 text-sm transition-colors ${
            overPostpone ? 'border-acc bg-acc-soft text-acc' : 'border-line text-fnt'
          }`}
        >
          <span>↻</span> 拖到这里 → 推迟到明天({addDays(data.today, 1)})
        </div>
      )}
      <div className="mt-2">
        {adding ? (
          <TaskCard
            mode="add"
            inline
            initialScheduled={data.today}
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
      {detailId && <TaskDetailModal taskId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
