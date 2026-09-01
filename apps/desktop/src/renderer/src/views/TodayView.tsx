import { useState } from 'react';
import { TaskCard } from '../TaskCard';
import { TaskDetailModal } from '../TaskDetailModal';
import { TaskRow } from '../TaskRow';
import { useGoogleStatus, useGoogleSync, useToday } from '../hooks';
import { toast } from '../toast';
import { useReorderDrag } from '../useReorderDrag';

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
 * 拖拽两用(D-40/INV-38):**拖到别的任务行上 = 换顺序**(仅未定时任务;定时任务按时刻
 * 排在下半段,它同时画在 Calendar 上,手动挪会让两个视图打架);**拖到底部区块 = 推迟到明天**。
 */
export function TodayView(): React.JSX.Element {
  const { data, isLoading } = useToday();
  const [editId, setEditId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [overPostpone, setOverPostpone] = useState(false);
  // D-25:Google 事件已镜像成任务,直接出现在下面的任务列表里;这里只保证"看 Today 时同步一次"
  // 手动排序(D-40/INV-38):只有未定时任务参与落点计算,定时任务按时刻锚在下半段。
  // hook 必须在早退之前调用(React 规则),所以用 data?. 兜底。
  const drag = useReorderDrag(
    'today',
    (data?.tasks ?? []).filter((t) => t.todaySortable).map((t) => t.id),
    (id, beforeId) => {
      void window.gtd.todayReorder(id, beforeId).then((r) => {
        if ('error' in r) toast(r.error);
      });
    },
  );
  const googleStatus = useGoogleStatus();
  useGoogleSync(
    data?.today ?? '1970-01-01',
    data?.today ?? '1970-01-01',
    googleStatus.data?.connected === true && data !== undefined,
  );

  if (isLoading || !data) {
    return <div className="px-8 py-6 text-sm text-fnt">加载中…</div>;
  }

  // 拖到底部区块 → 推迟到明天(改 scheduledDate)。
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
      {/* 落到定时段(那些行不收落点)时冒泡到这里:钳到未定时段末尾,而不是静默无反应。
          未定时行自己 stopPropagation,不会走到这儿 */}
      <ul
        className="space-y-0.5"
        onDragOver={(e) => {
          if (drag.dragId !== null) e.preventDefault();
        }}
        onDrop={(e) => {
          if (drag.dragId === null) return;
          e.preventDefault();
          const id = drag.dragId;
          drag.reset();
          const sortable = data.tasks.filter((x) => x.todaySortable);
          // 已经在末尾就别写了(零动作)
          if (sortable.length > 0 && sortable[sortable.length - 1]?.id !== id) {
            void window.gtd.todayReorder(id).then((r) => {
              if ('error' in r) toast(r.error);
            });
          }
        }}
      >
        {data.tasks.map((t) => (
          <li key={t.id}>
            {editId === t.id ? (
              <TaskCard mode="edit" inline task={t} onClose={() => setEditId(null)} />
            ) : (
              // 拖到别的行 = 换顺序(仅未定时);拖到底部区块 = 推迟到明天
              <div
                {...drag.rowProps(t.id, t.todaySortable)}
                onDragEnd={() => {
                  drag.reset();
                  setOverPostpone(false);
                }}
                className={`${drag.dragId === t.id ? 'opacity-40' : ''} ${
                  drag.hint(t.id) === 'before' ? 'border-t-2 border-acc' : ''
                } ${drag.hint(t.id) === 'after' ? 'border-b-2 border-acc' : ''}`}
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
      {drag.dragId && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setOverPostpone(true);
          }}
          onDragLeave={() => setOverPostpone(false)}
          onDrop={(e) => {
            e.preventDefault();
            const id = drag.dragId;
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
