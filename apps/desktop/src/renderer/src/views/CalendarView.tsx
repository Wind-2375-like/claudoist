import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskVM } from '../../../shared/viewModels';
import { TaskDetailModal } from '../TaskDetailModal';
import { useCalendarRange, useGoogleCalendars, useGoogleStatus, useGoogleSync } from '../hooks';
import { completeWithFeedback, reopenTask, toast } from '../toast';
import { isSubmitEnter } from '../keys';

/**
 * 日历周网格(D-23/INV-28/M6b)。日历 = 任务按 scheduledDate + startTime 的投影,
 * 没有独立实体、没有独立写路径:建块走 quickAddTask,拖动/拉伸走 updateTask,
 * 删块 = 软删任务。交互一律用鼠标事件(HTML5 DnD 在网格里定位不可靠)。
 */

// 网格常量:QUARTER_MIN / 默认块长与 domain `rules/calendarGrid.ts`(INV-28)必须一致 ——
// renderer 不 import 内层包(DESIGN §4.1),故此处重写一份;**改动须同步两处**
// (与 CLI today/calendar 的"同口径,改动需同步"约定一致)。
const HOUR_PX = 48; // 每小时高度;15 分钟 = 12px
/** 拖拽吸附粒度:5 分钟(镜像 domain SNAP_MINUTES;更细的时刻在任务详情里填) */
const QUARTER_MIN = 5;
const DEFAULT_BLOCK_MIN = 30;
/** 判定"单击 vs 拖动"的像素阈值:低于此位移一律视为单击(不写库)。 */
const DRAG_THRESHOLD_PX = 4;
const GUTTER_PX = 56;
const MIN_BLOCK_PX = 16;
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本地今天(与主进程 clock 同口径:本地 naive 日期)。 */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** 周一为一周之首。 */
function startOfWeek(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(y!, m! - 1, d!).getDay(); // 0=周日
  return addDays(iso, dow === 0 ? -6 : 1 - dow);
}

const minutesOf = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const timeOf = (min: number): string => {
  const m = Math.max(0, Math.min(1439, Math.round(min)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
const snapQuarter = (min: number): number => Math.floor(min / QUARTER_MIN) * QUARTER_MIN;
/** 镜像 domain `blockMinutes`(rules/calendarGrid.ts):非法时长回退默认块长。 */
const blockMin = (t: TaskVM): number => {
  const d = t.durationMinutes ?? t.estimatedMinutes;
  return Number.isInteger(d) && d >= 1 ? d : DEFAULT_BLOCK_MIN;
};
/** 镜像 domain `endTimeLabel`:1440 = 当日 24:00(timeOf 只能到 23:59)。 */
const endLabel = (min: number): string => (min >= 1440 ? '24:00' : timeOf(min));
/** 镜像 domain `blockFromDrag`(INV-28):位移不足一格 = 单击(默认 30 分钟)。 */
const blockFromDrag = (fromMin: number, toMin: number): { start: number; end: number } => {
  const a = snapQuarter(Math.min(fromMin, toMin));
  const b = Math.max(fromMin, toMin);
  const rawEnd =
    b - a < QUARTER_MIN ? a + DEFAULT_BLOCK_MIN : Math.ceil(b / QUARTER_MIN) * QUARTER_MIN;
  return { start: a, end: Math.min(1440, Math.max(a + QUARTER_MIN, rawEnd)) };
};

/**
 * 重叠分栏:同一簇内并排显示(col/cols)。**任务块与外部日历事件同池计算** ——
 * 否则同一时段的外部事件会整列铺开、与任务块互相压住(2026-08-10 用户复现)。
 */
interface Placed {
  key: string;
  start: number;
  end: number;
  col: number;
  cols: number;
  task: TaskVM;
}

function layout(tasks: TaskVM[]): Placed[] {
  const raw = tasks
    .map((t) => {
      const start = minutesOf(t.startTime ?? '00:00');
      return { key: t.id, start, end: Math.min(1440, start + blockMin(t)), task: t };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const flush = (): void => {
    for (const p of cluster) p.cols = Math.max(...cluster.map((x) => x.col)) + 1;
    out.push(...cluster);
    cluster = [];
    clusterEnd = -1;
  };
  for (const it of raw) {
    if (cluster.length > 0 && it.start >= clusterEnd) flush();
    const used = new Set(cluster.filter((p) => p.end > it.start).map((p) => p.col));
    let col = 0;
    while (used.has(col)) col += 1;
    cluster.push({ ...it, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  if (cluster.length > 0) flush();
  return out;
}

interface DragOrigin {
  /** mousedown 时的视口坐标:用像素位移判定单击/拖动,避免"吸附后值不等"造成的假拖动 */
  ox: number;
  oy: number;
}
type Drag =
  | ({ mode: 'select'; day: number; from: number; to: number } & DragOrigin)
  | ({
      mode: 'move';
      task: TaskVM;
      day: number;
      start: number;
      grab: number;
      moved: boolean;
    } & DragOrigin)
  | ({
      mode: 'resize';
      task: TaskVM;
      day: number;
      start: number;
      end: number;
      moved: boolean;
    } & DragOrigin);

interface Composer {
  date: string;
  startTime: string | null;
  durationMinutes: number | null;
  x: number;
  y: number;
}

export function CalendarView(): React.JSX.Element {
  const [anchor, setAnchor] = useState(() => startOfWeek(todayIso()));
  const { data } = useCalendarRange(anchor, 7);
  // 外部日历(D-25):事件已被镜像成任务,这里只负责"看这一周时拉一次"与取日历配色
  const googleStatus = useGoogleStatus();
  const connected = googleStatus.data?.connected === true;
  const weekEnd = addDays(anchor, 6);
  const gSync = useGoogleSync(anchor, weekEnd, connected);
  // 同步失败必须让用户看见(否则"日历没更新"会被当成应用坏了)
  useEffect(() => {
    const r = gSync.data;
    if (r && 'error' in r) toast(`Google 同步失败:${r.error}`);
  }, [gSync.data]);
  const gCalendars = useGoogleCalendars(connected);
  const calColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of gCalendars.data ?? []) if (c.backgroundColor) m.set(c.id, c.backgroundColor);
    return m;
  }, [gCalendars.data]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<{ task: TaskVM; x: number; y: number } | null>(null);
  const [nowMin, setNowMin] = useState(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  });

  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const allDayRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  // 首次滚到 7:00(与 Google Calendar 习惯一致)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX - 8;
  }, []);

  // 当前时刻红线,每分钟走一步
  useEffect(() => {
    const id = window.setInterval(() => {
      const d = new Date();
      setNowMin(d.getHours() * 60 + d.getMinutes());
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const days = data?.days ?? [];
  const laidOut = useMemo(() => days.map((d) => layout(d.timed)), [days]);

  /** 指针 y → 该列的当日分钟(列 rect 已含滚动偏移)。 */
  const minutesAt = (day: number, clientY: number): number => {
    const el = colRefs.current[day];
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1440, ((clientY - rect.top) / HOUR_PX) * 60));
  };
  const dayAt = (clientX: number): number | null => {
    for (let i = 0; i < colRefs.current.length; i++) {
      const r = colRefs.current[i]?.getBoundingClientRect();
      if (r && clientX >= r.left && clientX <= r.right) return i;
    }
    return null;
  };
  const overAllDay = (clientY: number): boolean => {
    const r = allDayRef.current?.getBoundingClientRect();
    return r !== undefined && clientY >= r.top && clientY <= r.bottom;
  };
  /** 落点是否在时间网格可视区内(x 命中某列 且 y 在滚动容器内)。 */
  const insideGrid = (clientX: number, clientY: number): boolean => {
    const sr = scrollRef.current?.getBoundingClientRect();
    if (!sr || clientY < sr.top || clientY > sr.bottom) return false;
    return dayAt(clientX) !== null;
  };
  const movedEnough = (d: Drag, e: MouseEvent): boolean =>
    Math.abs(e.clientX - d.ox) > DRAG_THRESHOLD_PX ||
    Math.abs(e.clientY - d.oy) > DRAG_THRESHOLD_PX;

  const createTask = async (
    date: string,
    startTime: string | null,
    durationMinutes: number | null,
    title: string,
  ): Promise<void> => {
    const r = await window.gtd.taskCreate({
      title,
      scheduledDate: date,
      ...(startTime !== null ? { startTime } : {}),
      ...(durationMinutes !== null ? { durationMinutes } : {}),
    });
    if ('error' in r) toast(r.error);
  };

  const patchTask = async (id: string, patch: Record<string, unknown>): Promise<void> => {
    const r = await window.gtd.taskUpdate({ id, patch });
    if ('error' in r) toast(r.error);
  };

  // 拖拽全程走 window 监听:指针移出列/移出窗口也能正确收尾
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === 'select') {
        setDrag({ ...d, to: minutesAt(d.day, e.clientY) });
      } else if (d.mode === 'move') {
        // 只有真实像素位移才算拖动:块的 startTime 未必落在刻度上,拿吸附值与原值比会把
        // 1px 抖动误判成拖动 → 单击查看详情变成静默改时间(评审 HIGH)
        const moved = d.moved || movedEnough(d, e);
        const day = dayAt(e.clientX) ?? d.day;
        const start = snapQuarter(Math.max(0, minutesAt(day, e.clientY) - d.grab));
        if (moved !== d.moved || day !== d.day || start !== d.start) {
          setDrag({ ...d, day, start: moved ? start : d.start, moved });
        }
      } else {
        const moved = d.moved || movedEnough(d, e);
        // 预览就按 5 分钟吸附(与松手写入同一公式),别让用户看到 11:33 这种中间态
        const snapped = Math.ceil(minutesAt(d.day, e.clientY) / QUARTER_MIN) * QUARTER_MIN;
        const end = Math.min(1440, Math.max(d.start + QUARTER_MIN, snapped));
        if (moved !== d.moved || end !== d.end) setDrag({ ...d, end, moved });
      }
    };
    const onUp = (e: MouseEvent): void => {
      const d = dragRef.current;
      setDrag(null);
      if (!d || days.length === 0) return;
      if (d.mode === 'select') {
        const { start: a, end } = blockFromDrag(d.from, d.to);
        setComposer({
          date: days[d.day]!.date,
          startTime: timeOf(a),
          durationMinutes: end - a,
          x: e.clientX,
          y: e.clientY,
        });
      } else if (d.mode === 'move') {
        if (!d.moved) {
          setDetailId(d.task.id);
          return;
        }
        // 落点必须在网格内或全天条上;否则丢弃(否则会按滚动位置外推出一个无关时刻)
        if (!overAllDay(e.clientY) && !insideGrid(e.clientX, e.clientY)) return;
        // 已完成/外部镜像不参与改期(起点已挡,这里兜底)
        if (d.task.done || d.task.externalId !== null) return;
        if (overAllDay(e.clientY)) {
          void patchTask(d.task.id, {
            scheduledDate: days[d.day]!.date,
            startTime: null,
            durationMinutes: null,
          });
        } else {
          void patchTask(d.task.id, {
            scheduledDate: days[d.day]!.date,
            startTime: timeOf(d.start),
          });
        }
      } else if (d.moved && insideGrid(e.clientX, e.clientY)) {
        // 与预览同源:预览用的是吸附后的 end,这里也从吸附后的 end 反推时长
        const dur = Math.max(QUARTER_MIN, d.end - d.start);
        void patchTask(d.task.id, { durationMinutes: Math.max(1, Math.min(1440 - d.start, dur)) });
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDrag(null); // 拖到一半反悔:Esc 丢弃,不落库
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [drag !== null, days]);

  const weekLabel =
    data !== undefined ? `${data.from} — ${data.to}` : `${anchor} — ${addDays(anchor, 6)}`;

  return (
    <div className="flex h-full flex-col px-6 py-4">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-2xl font-bold">Calendar</h1>
        <span className="text-xs text-neutral-400">{weekLabel}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="rounded-md border border-neutral-200 px-2 py-1 text-sm hover:bg-neutral-50"
            onClick={() => setAnchor((a) => addDays(a, -7))}
            title="上一周"
          >
            ‹
          </button>
          <button
            type="button"
            className="rounded-md border border-neutral-200 px-2 py-1 text-sm hover:bg-neutral-50"
            onClick={() => setAnchor(startOfWeek(todayIso()))}
          >
            本周
          </button>
          <button
            type="button"
            className="rounded-md border border-neutral-200 px-2 py-1 text-sm hover:bg-neutral-50"
            onClick={() => setAnchor((a) => addDays(a, 7))}
            title="下一周"
          >
            ›
          </button>
        </div>
      </div>

      {/* 日期表头 */}
      <div className="flex border-b border-neutral-200 pb-1" style={{ paddingLeft: GUTTER_PX }}>
        {days.map((d, i) => (
          <div key={d.date} className="min-w-0 flex-1 text-center">
            <div className="text-[11px] text-neutral-400">周{WEEKDAYS[i]}</div>
            <div
              className={`text-sm ${d.isToday ? 'font-bold text-red-600' : 'text-neutral-700'}`}
              title={d.date}
            >
              {Number(d.date.slice(8, 10))}
            </div>
          </div>
        ))}
      </div>

      {/* 全天段:点空白建全天任务;拖块到此变全天 */}
      <div className="flex border-b border-neutral-200" ref={allDayRef}>
        <div
          className="shrink-0 py-1 text-right text-[11px] text-neutral-400"
          style={{ width: GUTTER_PX, paddingRight: 6 }}
        >
          全天
        </div>
        {days.map((d, di) => (
          <div
            key={d.date}
            className="min-h-8 min-w-0 flex-1 border-l border-neutral-100 p-0.5"
            onMouseDown={(e) => {
              if (e.button !== 0) return; // 右键/中键不建任务
              if (e.currentTarget !== e.target) return; // 点在 chip 上不建新任务
              setComposer({
                date: d.date,
                startTime: null,
                durationMinutes: null,
                x: e.clientX,
                y: e.clientY,
              });
            }}
          >
            {d.allDay.map((t) => {
              const external = t.externalId !== null;
              const isDone = t.done;
              const canDrag = !external && !isDone;
              return (
                <AllDayChip
                  key={t.id}
                  task={t}
                  color={external ? (calColor.get(t.externalCalendarId ?? '') ?? '#6b7280') : null}
                  draggable={canDrag}
                  {...(!isDone ? { onOpen: () => setDetailId(t.id) } : {})}
                  onMenu={(e) => setMenu({ task: t, x: e.clientX, y: e.clientY })}
                  onGrab={(e) => {
                    // 全天块拖回时间轴:复用 move 状态机(grab=0,落点即起始时刻)
                    if (!canDrag) return;
                    setDrag({
                      mode: 'move',
                      task: t,
                      day: di,
                      start: 0,
                      grab: 0,
                      moved: false,
                      ox: e.clientX,
                      oy: e.clientY,
                    });
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* 时间网格 */}
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
        <div className="flex" style={{ height: 24 * HOUR_PX }}>
          <div className="relative shrink-0" style={{ width: GUTTER_PX }}>
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={h}
                className="absolute right-1.5 -translate-y-1/2 text-[11px] text-neutral-400"
                style={{ top: h * HOUR_PX }}
              >
                {h > 0 ? `${pad(h)}:00` : ''}
              </div>
            ))}
          </div>
          {days.map((d, di) => (
            <div
              key={d.date}
              ref={(el) => {
                colRefs.current[di] = el;
              }}
              className="relative min-w-0 flex-1 border-l border-neutral-100 select-none"
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                // 通常只在"落在列本身"时起手,免得在块上按下也开始拖选。
                // 例外:**已完成的块是惰性的**(不拖、不拉、左键点了什么都不发生),
                // 它却实实在在占着一片时间 —— 再把 mousedown 挡掉,那片时间就成了死区,
                // 用户没法在它附近拖出新任务(2026-08-12 用户实测)。所以放它冒泡上来。
                const inert = (e.target as HTMLElement).closest('[data-cal-inert]') !== null;
                if (e.currentTarget !== e.target && !inert) return;
                const m = snapQuarter(minutesAt(di, e.clientY));
                setDrag({ mode: 'select', day: di, from: m, to: m, ox: e.clientX, oy: e.clientY });
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <div
                  key={h}
                  className="pointer-events-none absolute inset-x-0 border-t border-neutral-100"
                  style={{ top: h * HOUR_PX }}
                />
              ))}
              {d.isToday && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 border-t border-red-500"
                  style={{ top: (nowMin / 60) * HOUR_PX }}
                >
                  <span className="absolute -top-1 -left-1 h-2 w-2 rounded-full bg-red-500" />
                </div>
              )}
              {/* 拖选 ghost */}
              {drag?.mode === 'select' && drag.day === di && (
                <SelectionGhost from={drag.from} to={drag.to} />
              )}
              {laidOut[di]?.map((p) => {
                const task = p.task;
                // 交互能力(2026-08-10 用户定案):
                // - 已完成:日历上完全锁死(不拖、不拉、不点开)——先右键撤销完成再操作
                // - 外部镜像:时间归 Google → 不拖不拉,但**可以点开**改优先级/标签/完成
                const external = task.externalId !== null;
                const isDone = task.done;
                const draggable = !external && !isDone;
                const dragging =
                  drag && drag.mode !== 'select' && drag.task.id === task.id ? drag : null;
                const start = dragging?.mode === 'move' ? dragging.start : p.start;
                const end =
                  dragging?.mode === 'resize'
                    ? dragging.end
                    : dragging?.mode === 'move'
                      ? dragging.start + (p.end - p.start)
                      : p.end;
                const hiddenHere = dragging?.mode === 'move' && dragging.day !== di;
                if (hiddenHere) return null;
                return (
                  <CalendarBlock
                    key={p.key}
                    task={task}
                    start={start}
                    end={end}
                    col={p.col}
                    cols={p.cols}
                    active={dragging !== null}
                    externalColor={
                      external ? (calColor.get(task.externalCalendarId ?? '') ?? '#6b7280') : null
                    }
                    draggable={draggable}
                    {...(!draggable && !isDone ? { onOpen: () => setDetailId(task.id) } : {})}
                    onGrab={(e, grab) => {
                      if (!draggable) return;
                      setDrag({
                        mode: 'move',
                        task,
                        day: di,
                        start: p.start,
                        grab,
                        moved: false,
                        ox: e.clientX,
                        oy: e.clientY,
                      });
                    }}
                    onResize={(e) => {
                      if (!draggable) return;
                      setDrag({
                        mode: 'resize',
                        task,
                        day: di,
                        start: p.start,
                        end: p.end,
                        moved: false,
                        ox: e.clientX,
                        oy: e.clientY,
                      });
                    }}
                    onMenu={(e) => setMenu({ task, x: e.clientX, y: e.clientY })}
                  />
                );
              })}
              {/* 被拖到本列的块(跨列移动预览) */}
              {drag?.mode === 'move' &&
                drag.moved &&
                drag.day === di &&
                !laidOut[di]?.some((p) => p.task?.id === drag.task.id) && (
                  <CalendarBlock
                    task={drag.task}
                    start={drag.start}
                    end={Math.min(1440, drag.start + blockMin(drag.task))}
                    col={0}
                    cols={1}
                    active
                    onGrab={() => undefined}
                    onResize={() => undefined}
                    onMenu={() => undefined}
                  />
                )}
            </div>
          ))}
        </div>
      </div>

      {composer && (
        <QuickComposer
          composer={composer}
          onCancel={() => setComposer(null)}
          onSubmit={(title) => {
            const c = composer;
            setComposer(null);
            void createTask(c.date, c.startTime, c.durationMinutes, title);
          }}
        />
      )}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          <div
            className="fixed z-50 w-36 rounded-lg border border-neutral-200 bg-white py-1 shadow-xl"
            style={{
              left: Math.min(menu.x, window.innerWidth - 150),
              top: Math.min(menu.y, window.innerHeight - 120),
            }}
          >
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-50"
              onClick={() => {
                const t = menu.task;
                setMenu(null);
                if (t.done) void reopenTask(t.id);
                else void completeWithFeedback(t.title, t.id);
              }}
            >
              {menu.task.done ? '↺ 撤销完成' : '✓ 完成'}
            </button>
            {menu.task.completedAt === null && menu.task.externalId === null && (
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-50"
                onClick={() => {
                  const t = menu.task;
                  setMenu(null);
                  void patchTask(t.id, { startTime: null, durationMinutes: null });
                }}
              >
                ⇧ 移到全天
              </button>
            )}
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
              onClick={async () => {
                const t = menu.task;
                setMenu(null);
                if (!window.confirm(`删除「${t.title}」?(日历块即任务,可恢复)`)) return;
                const r = await window.gtd.taskDelete(t.id);
                if ('error' in r) toast(r.error);
              }}
            >
              🗑 删除
            </button>
          </div>
        </>
      )}
      {detailId && <TaskDetailModal taskId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function SelectionGhost({ from, to }: { from: number; to: number }): React.JSX.Element {
  // 与松手时的写入公式同源(blockFromDrag),否则短拖预览 15 分钟、实际建 30 分钟
  const { start: a, end: b } = blockFromDrag(from, to);
  return (
    <div
      className="pointer-events-none absolute inset-x-1 z-10 rounded-md border border-blue-400 bg-blue-200/50"
      style={{ top: (a / 60) * HOUR_PX, height: ((b - a) / 60) * HOUR_PX }}
    >
      <span className="px-1 text-[10px] text-blue-700">
        {timeOf(a)}–{endLabel(b)}
      </span>
    </div>
  );
}

function AllDayChip({
  task,
  color,
  draggable,
  onOpen,
  onGrab,
  onMenu,
}: {
  task: TaskVM;
  /** 非空 = 外部日历镜像(用日历配色 + 虚线) */
  color: string | null;
  draggable: boolean;
  onOpen?: (() => void) | undefined;
  onGrab: (e: React.MouseEvent) => void;
  onMenu: (e: React.MouseEvent) => void;
}): React.JSX.Element {
  const done = task.done;
  return (
    <div
      className={`mb-0.5 block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] ${
        done
          ? 'bg-neutral-100 text-neutral-400 line-through'
          : color != null
            ? 'border border-dashed text-neutral-800'
            : 'bg-blue-50 text-blue-700'
      }`}
      style={{
        cursor: draggable ? 'grab' : onOpen ? 'pointer' : 'default',
        ...(color != null && !done ? { borderColor: color, background: `${color}1a` } : {}),
      }}
      title={
        draggable
          ? `${task.title}(可拖到下方时间轴设定时刻)`
          : done
            ? `${task.title}(已完成 — 右键撤销后才能改)`
            : task.title
      }
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation(); // 别触发全天格的"建全天任务"
        if (draggable) onGrab(e);
      }}
      onClick={() => {
        if (!draggable) onOpen?.();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e);
      }}
    >
      {task.title}
    </div>
  );
}

function CalendarBlock({
  task,
  start,
  end,
  col,
  cols,
  active,
  externalColor,
  draggable = true,
  onOpen,
  onGrab,
  onResize,
  onMenu,
}: {
  task: TaskVM;
  start: number;
  end: number;
  col: number;
  cols: number;
  active: boolean;
  /** 非空 = 外部日历镜像(虚线 + 日历配色,不可拖动) */
  externalColor?: string | null;
  /** 可拖动/拉伸(已完成或外部镜像为 false) */
  draggable?: boolean;
  /** 不可拖动但仍可点开详情时用(拖动块的"单击"由拖拽状态机处理,不走这里) */
  onOpen?: (() => void) | undefined;
  onGrab: (e: React.MouseEvent, grabOffsetMinutes: number) => void;
  onResize: (e: React.MouseEvent) => void;
  onMenu: (e: React.MouseEvent) => void;
}): React.JSX.Element {
  const done = task.done;
  const height = Math.max(MIN_BLOCK_PX, ((end - start) / 60) * HOUR_PX);
  return (
    <div
      className={`absolute z-10 overflow-hidden rounded-md border px-1 py-0.5 text-[11px] shadow-sm ${
        done
          ? 'border-neutral-200 bg-neutral-100 text-neutral-400 line-through'
          : externalColor != null
            ? 'border-dashed text-neutral-800'
            : 'border-blue-300 bg-blue-100 text-blue-900'
      } ${active ? 'opacity-70 ring-2 ring-blue-400' : ''}`}
      style={{
        top: (start / 60) * HOUR_PX,
        height,
        left: `calc(${(col / cols) * 100}% + 2px)`,
        width: `calc(${100 / cols}% - 4px)`,
        // 不能改期就不给"可拖动"的光标暗示;可点开的给 pointer
        cursor: draggable ? 'grab' : onOpen ? 'pointer' : 'default',
        ...(externalColor != null && !done
          ? { borderColor: externalColor, background: `${externalColor}1a` }
          : {}),
      }}
      title={
        done
          ? `${timeOf(start)}–${endLabel(end)} ${task.title}(已完成 — 右键可撤销)`
          : `${timeOf(start)}–${endLabel(end)} ${task.title}`
      }
      {...(done ? { 'data-cal-inert': '1' } : {})}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // 已完成 = 惰性块:**不吞 mousedown**,让它冒泡给列去起拖选,
        // 否则这块时间没法再建任务。右键仍由本块处理(contextmenu 是另一个事件)。
        if (done) return;
        e.stopPropagation(); // 别在块上按下时触发列的"拖选建块"
        if (!draggable) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onGrab(e, ((e.clientY - rect.top) / HOUR_PX) * 60);
      }}
      onClick={() => onOpen?.()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e);
      }}
    >
      <div className="truncate font-medium">{task.title}</div>
      {height > 28 && (
        <div className="truncate opacity-70">
          {timeOf(start)}–{endLabel(end)}
        </div>
      )}
      {draggable && (
        <div
          className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            onResize(e);
          }}
        />
      )}
    </div>
  );
}

function QuickComposer({
  composer,
  onCancel,
  onSubmit,
}: {
  composer: Composer;
  onCancel: () => void;
  onSubmit: (title: string) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState('');
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const label =
    composer.startTime === null
      ? `${composer.date} · 全天`
      : `${composer.date} · ${composer.startTime}–${endLabel(
          minutesOf(composer.startTime) + (composer.durationMinutes ?? DEFAULT_BLOCK_MIN),
        )}`;
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onCancel} />
      <div
        className="fixed z-50 w-64 rounded-lg border border-neutral-200 bg-white p-2 shadow-xl"
        style={{
          left: Math.min(composer.x, window.innerWidth - 280),
          top: Math.min(composer.y, window.innerHeight - 120),
        }}
      >
        <p className="mb-1 text-[11px] text-neutral-400">{label}</p>
        <input
          ref={ref}
          className="w-full rounded border border-neutral-200 px-2 py-1 text-sm outline-none focus:border-blue-400"
          placeholder="任务标题(回车创建)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (isSubmitEnter(e) && title.trim() !== '') onSubmit(title.trim());
            if (e.key === 'Escape') onCancel();
          }}
        />
      </div>
    </>
  );
}
