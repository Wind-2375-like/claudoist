import { useEffect, useRef, useState } from 'react';
import { useContexts, useLabels, useProjects, useTaskDetail } from './hooks';
import { TaskCard } from './TaskCard';
import { TaskTree } from './TaskTree';
import { completeTitle, completeWithFeedback, reopenTask, toast } from './toast';

/**
 * 任务详情弹窗(D-22 Todoist 式两栏,单击任务打开):
 * 左栏 = 内容(标题/完成圈/描述/子任务/评论);右栏 = 属性面板(位置/日期/截止/优先级/
 * 标签/提醒/context,逐项就地编辑,可 Move to)。子任务用 TaskRow(可右键、单击下钻)。
 */

const PRIORITIES = [
  { value: 5, label: '最高' },
  { value: 4, label: '高' },
  { value: 3, label: '中' },
  { value: 2, label: '低' },
  { value: 1, label: '最低' },
];

const pad = (n: number): string => String(n).padStart(2, '0');
const localDate = (offset = 0): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function TaskDetailModal({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}): React.JSX.Element {
  // 下钻栈记录 id + 下钻时的标题:返回按钮显示真实上一层(可能跨层下钻,≠ parentTitle)
  const [stack, setStack] = useState<{ id: string; title: string | null }[]>([
    { id: taskId, title: null },
  ]);
  const currentId = stack[stack.length - 1]!.id;
  const { data, isLoading } = useTaskDetail(currentId);
  const projects = useProjects();
  const contexts = useContexts();
  const labels = useLabels();
  const [addingSub, setAddingSub] = useState(false);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [newReminder, setNewReminder] = useState('');

  const backTarget = stack.length > 1 ? stack[stack.length - 2]! : null;

  // 切换当前任务时清空所有编辑草稿(否则评论/子任务标题/提醒会串到别的任务)
  const resetDrafts = (): void => {
    setAddingSub(false);
    setComment('');
    setEditing(null);
    setNewReminder('');
  };
  const drill = (id: string, title: string): void => {
    resetDrafts();
    setStack((s) => {
      const next = [...s];
      if (data && next[next.length - 1]!.id === data.task.id) {
        next[next.length - 1] = { id: data.task.id, title: data.task.title };
      }
      return [...next, { id, title }];
    });
  };
  const back = (): void => {
    resetDrafts();
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };

  const report = (r: { error: string } | { consequences: unknown }): void => {
    if ('error' in r) toast(r.error);
  };

  const patch = async (p: Record<string, unknown>): Promise<void> => {
    report(await window.gtd.taskUpdate({ id: currentId, patch: p }));
    setEditing(null);
  };
  const move = async (
    to: { bucket: 'inbox' | 'someday' | 'reference' } | { bucket: 'project'; projectId: string },
  ): Promise<void> => {
    report(await window.gtd.taskMove({ id: currentId, to }));
    setEditing(null);
  };
  const toggleLabel = async (labelId: string): Promise<void> => {
    if (!data) return;
    const cur = data.task.labels.map((l) => l.id);
    const next = cur.includes(labelId) ? cur.filter((x) => x !== labelId) : [...cur, labelId];
    report(await window.gtd.taskSetLabels(currentId, next));
  };
  const addRem = async (): Promise<void> => {
    if (!newReminder) return;
    report(await window.gtd.reminderAdd(currentId, newReminder.slice(0, 16)));
    setNewReminder('');
  };
  const delRem = async (id: string): Promise<void> => {
    report(await window.gtd.reminderDelete(id));
  };

  const addCommentFn = async (): Promise<void> => {
    const body = comment.trim();
    if (!body) return;
    report(await window.gtd.commentAdd(currentId, body));
    setComment('');
  };

  const t = data?.task;
  const done = t?.completedAt != null;

  // ── 右栏属性行(点 1:有值 → 点值本身编辑(toggle);无值 → 显 ＋)──
  const attrRow = (
    key: string,
    label: string,
    hasValue: boolean,
    value: React.ReactNode,
    editor: React.ReactNode,
  ): React.JSX.Element => {
    const toggle = (): void => setEditing(editing === key ? null : key);
    return (
      <div className="border-b border-neutral-100 py-2">
        <div className="flex w-full items-center justify-between">
          <span className="text-xs font-medium text-neutral-500">{label}</span>
          {/* 无值 → ＋ 新增;编辑中 → × 收起;有值且未编辑 → 不显示 ＋(点值即可改) */}
          {!hasValue || editing === key ? (
            <button
              type="button"
              className="text-lg leading-none text-neutral-300 hover:text-neutral-600"
              title={editing === key ? '收起' : '添加'}
              onClick={toggle}
            >
              {editing === key ? '×' : '＋'}
            </button>
          ) : null}
        </div>
        {hasValue &&
          (editing === key ? (
            <div className="mt-1 text-sm">{value}</div>
          ) : (
            <button
              type="button"
              className="mt-1 w-full cursor-pointer rounded px-1 py-0.5 text-left text-sm hover:bg-neutral-200/60"
              title="点击修改"
              onClick={toggle}
            >
              {value}
            </button>
          ))}
        {editing === key && <div className="mt-2">{editor}</div>}
      </div>
    );
  };

  const chip = (active: boolean): string =>
    `rounded-md border px-2 py-1 text-xs ${active ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'}`;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-16">
      <div className="flex max-h-[82vh] w-[820px] max-w-[95vw] flex-col rounded-xl border border-neutral-200 bg-white shadow-2xl">
        {/* 顶栏 */}
        <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2 text-xs text-neutral-500">
          {backTarget && (
            <button type="button" className="hover:text-neutral-800" onClick={back}>
              ← {backTarget.title ?? '返回'}
            </button>
          )}
          <span className="truncate">📍 {data?.locationLabel ?? ''}</span>
          <button
            type="button"
            className="ml-auto text-lg leading-none text-neutral-400 hover:text-neutral-700"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {isLoading && <p className="px-5 py-6 text-sm text-neutral-400">加载中…</p>}
        {!isLoading && !data && (
          <p className="px-5 py-6 text-sm text-neutral-400">任务不存在(可能已删除)。</p>
        )}
        {data && t && (
          <div className="flex min-h-0 flex-1">
            {/* 左栏:内容 */}
            <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="flex items-start gap-3">
                {done ? (
                  <button
                    type="button"
                    className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-500 text-xs text-white hover:bg-green-600"
                    title="已完成 — 点击撤销"
                    onClick={() => void reopenTask(t.id)}
                  >
                    ✓
                  </button>
                ) : (
                  <button
                    type="button"
                    className="mt-1 h-5 w-5 shrink-0 rounded-full border-2 border-neutral-300 hover:border-green-500 hover:bg-green-50"
                    title={completeTitle(t.subtaskCount)}
                    onClick={() => void completeWithFeedback(t.title, t.id)}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <h2
                    className={`text-lg font-semibold ${done ? 'text-neutral-400 line-through' : ''}`}
                  >
                    {t.title}
                  </h2>
                  {t.description && (
                    <p className="mt-1 text-sm whitespace-pre-wrap text-neutral-600">
                      {t.description}
                    </p>
                  )}
                </div>
              </div>

              <h3 className="mt-5 mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
                子任务
              </h3>
              {/* 弹窗内 depth-0 是本任务的子任务而非容器顶层 → 禁用拖拽避免误摘父子关系 */}
              {data.subtasks.length > 0 && (
                <TaskTree
                  nodes={data.subtasks}
                  onDetail={(id, title) => drill(id, title)}
                  reorderable={false}
                />
              )}
              {data.canAddSubtask ? (
                addingSub ? (
                  <div className="mt-1">
                    <TaskCard
                      mode="add"
                      inline
                      parentTaskId={currentId}
                      parentContextId={t.contextId}
                      onClose={() => setAddingSub(false)}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="mt-1 flex items-center gap-2 px-2 py-1.5 text-sm text-neutral-400 hover:text-red-600"
                    onClick={() => setAddingSub(true)}
                  >
                    <span className="text-lg leading-none">＋</span> Add sub-task
                  </button>
                )
              ) : (
                <p className="mt-1 px-2 text-xs text-neutral-400">已到第 5 层,不能再嵌套(INV-25)</p>
              )}

              <h3 className="mt-5 mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
                评论
              </h3>
              <ul className="space-y-2">
                {data.comments.map((c) => (
                  <li key={c.id} className="rounded-md bg-neutral-50 px-3 py-2">
                    <p className="text-sm whitespace-pre-wrap">{c.body}</p>
                    <p className="mt-0.5 text-[11px] text-neutral-400">
                      {c.createdAt.replace('T', ' ')}
                    </p>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center gap-2">
                <input
                  className="flex-1 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 focus:border-blue-400"
                  placeholder="Comment(回车发送)"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void addCommentFn();
                    }
                  }}
                />
              </div>
            </div>

            {/* 右栏:属性面板 */}
            <div className="w-64 shrink-0 overflow-y-auto border-l border-neutral-100 bg-neutral-50/60 px-4 py-3">
              {attrRow(
                'loc',
                'Project / 位置',
                true,
                <span>{data.locationLabel}</span>,
                <div className="flex flex-col gap-1">
                  {(
                    [
                      { v: 'inbox', label: '📥 Inbox' },
                      { v: 'someday', label: '🌙 Someday/Maybe' },
                      { v: 'reference', label: '📚 Reference' },
                    ] as const
                  ).map((o) => (
                    <button
                      key={o.v}
                      type="button"
                      className={chip(false)}
                      onClick={() => void move({ bucket: o.v })}
                    >
                      {o.label}
                    </button>
                  ))}
                  {projects.data?.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={chip(t.projectId === p.id)}
                      onClick={() => void move({ bucket: 'project', projectId: p.id })}
                    >
                      # {p.name}
                    </button>
                  ))}
                  {t.parentTaskId !== null && (
                    <span className="text-[11px] text-neutral-400">
                      移动子任务会先脱离父任务(INV-25)
                    </span>
                  )}
                </div>,
              )}
              {attrRow(
                'date',
                'Date(计划哪天做)',
                t.scheduledDate !== null,
                <span>{t.scheduledDate}</span>,
                t.externalId !== null ? (
                  <ExternalOwnedHint />
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <DraftField
                      initial={t.scheduledDate ?? ''}
                      placeholder="YYYY-MM-DD"
                      className="w-28"
                      onCommit={(v) => {
                        if (v !== '' && !ISO_DATE.test(v)) {
                          toast('日期格式须为 YYYY-MM-DD');
                          return;
                        }
                        void patch({ scheduledDate: v === '' ? null : v });
                      }}
                      onCancel={() => setEditing(null)}
                    />
                    <button
                      type="button"
                      className={chip(false)}
                      onMouseDown={() => void patch({ scheduledDate: localDate(0) })}
                    >
                      Today
                    </button>
                    <button
                      type="button"
                      className={chip(false)}
                      onMouseDown={() => void patch({ scheduledDate: localDate(1) })}
                    >
                      Tomorrow
                    </button>
                    {t.scheduledDate && (
                      <button
                        type="button"
                        className="text-xs text-neutral-400"
                        onMouseDown={() => void patch({ scheduledDate: null })}
                      >
                        清除
                      </button>
                    )}
                  </div>
                ),
              )}
              {attrRow(
                'time',
                'Time(日历 block,D-23)',
                t.startTime !== null,
                <span>
                  🕐 {t.startTime}·{t.durationMinutes ?? t.estimatedMinutes}m
                  <span className="ml-1.5 text-[11px] text-neutral-400">
                    {t.timeZone ?? '浮动时间'}
                  </span>
                </span>,
                t.externalId !== null ? (
                  <ExternalOwnedHint />
                ) : (
                  <TimeEditor
                    startTime={t.startTime}
                    durationMinutes={t.durationMinutes}
                    timeZone={t.timeZone}
                    hasDate={t.scheduledDate !== null}
                    chipClass={chip(false)}
                    onCommit={(startTime, durationMinutes, timeZone) =>
                      void patch({ startTime, durationMinutes, timeZone })
                    }
                    onCancel={() => setEditing(null)}
                  />
                ),
              )}
              {attrRow(
                'deadline',
                'Deadline',
                t.deadline !== null,
                <span className={t.overdue ? 'text-red-600' : ''}>{t.deadline}</span>,
                <div className="flex items-center gap-2">
                  <DraftField
                    initial={t.deadline ?? ''}
                    placeholder="YYYY-MM-DD"
                    className="w-28"
                    onCommit={(v) => {
                      if (v !== '' && !ISO_DATE.test(v)) {
                        toast('日期格式须为 YYYY-MM-DD');
                        return;
                      }
                      void patch({ deadline: v === '' ? null : v });
                    }}
                    onCancel={() => setEditing(null)}
                  />
                  {t.deadline && (
                    <button
                      type="button"
                      className="text-xs text-neutral-400"
                      onMouseDown={() => void patch({ deadline: null })}
                    >
                      清除
                    </button>
                  )}
                </div>,
              )}
              {attrRow(
                'priority',
                'Priority',
                true,
                <span>{t.priorityLabel}</span>,
                <div className="flex flex-wrap gap-1.5">
                  {PRIORITIES.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      className={chip(t.priority === p.value)}
                      onClick={() => void patch({ priority: p.value })}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>,
              )}
              {attrRow(
                'labels',
                'Labels',
                t.labels.length > 0,
                <span>{t.labels.map((l) => l.name).join(', ')}</span>,
                <div className="flex flex-wrap gap-1.5">
                  {labels.data?.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      className={chip(t.labels.some((x) => x.id === l.id))}
                      onClick={() => void toggleLabel(l.id)}
                    >
                      {l.name}
                    </button>
                  ))}
                  {(labels.data?.length ?? 0) === 0 && (
                    <span className="text-[11px] text-neutral-400">还没有 label</span>
                  )}
                </div>,
              )}
              {attrRow(
                'reminders',
                'Reminders',
                data.reminders.length > 0,
                <span>{data.reminders.length} 个</span>,
                <div className="flex flex-col gap-1.5">
                  {data.reminders.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 text-xs">
                      <span>{r.remindAt.replace('T', ' ')}</span>
                      <button
                        type="button"
                        className="text-neutral-400 hover:text-red-600"
                        onClick={() => void delRem(r.id)}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center gap-1.5">
                    <input
                      type="datetime-local"
                      className="rounded border border-neutral-300 px-2 py-1 text-xs"
                      value={newReminder}
                      onChange={(e) => setNewReminder(e.target.value)}
                    />
                    <button type="button" className={chip(false)} onClick={() => void addRem()}>
                      添加
                    </button>
                  </div>
                  <span className="text-[11px] text-neutral-400">落库即存;响铃 M6 上线</span>
                </div>,
              )}
              {attrRow(
                'context',
                '@context',
                true,
                <span>{t.contextName}</span>,
                <div className="flex flex-wrap gap-1.5">
                  {contexts.data?.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={chip(t.contextId === c.id)}
                      onClick={() => void patch({ contextId: c.id })}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>,
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{2}:\d{2}$/;

/**
 * 可自由键入 + **回车保存**的小输入(Todoist 式,2026-08-10 用户定案)。
 * 键入中间态只留在本地草稿,不落库、不收起编辑器 —— 原生 <input type="date"/time>
 * 在敲第一个数字时就凑成完整值触发 onChange,会立刻持久化并收起编辑器;且显示格式
 * 随系统 locale(DD.MM.YYYY),无法按 YYYY-MM-DD 键入。故一律改用文本框。
 * Enter 提交、Esc 取消;不做 blur 提交(避免与"清除/Today"按钮的点击顺序打架)。
 */
function DraftField({
  initial,
  placeholder,
  className = '',
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      title="回车保存,Esc 取消"
      className={`rounded border border-neutral-300 px-2 py-1 text-xs outline-none focus:border-blue-400 ${className}`}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(value.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

/**
 * Time 行:时刻 + 时长两个草稿框,**任一框回车即一次性提交两者**(无独立保存按钮)。
 * 时刻留空 = 清除,连带清时长(不留孤儿 durationMinutes)。
 */
function TimeEditor({
  startTime,
  durationMinutes,
  timeZone,
  hasDate,
  chipClass,
  onCommit,
  onCancel,
}: {
  startTime: string | null;
  durationMinutes: number | null;
  timeZone: string | null;
  hasDate: boolean;
  chipClass: string;
  onCommit: (
    startTime: string | null,
    durationMinutes: number | null,
    timeZone: string | null,
  ) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [time, setTime] = useState(startTime ?? '');
  const [dur, setDur] = useState(durationMinutes === null ? '' : String(durationMinutes));
  const [zone, setZone] = useState<string | null>(timeZone);
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = (): void => {
    const tv = time.trim();
    const dv = dur.trim();
    if (tv !== '' && !ISO_TIME.test(tv)) {
      toast('时间格式须为 HH:MM(24 小时制)');
      return;
    }
    if (tv !== '' && dv !== '' && (!/^\d+$/.test(dv) || Number(dv) < 1)) {
      toast('时长须为 ≥1 的整数分钟');
      return;
    }
    onCommit(
      tv === '' ? null : tv,
      tv === '' || dv === '' ? null : Number(dv),
      tv === '' ? null : zone,
    );
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        ref={ref}
        value={time}
        placeholder="HH:MM"
        title="回车保存,Esc 取消"
        className="w-20 rounded border border-neutral-300 px-2 py-1 text-xs outline-none focus:border-blue-400"
        onChange={(e) => setTime(e.target.value)}
        onKeyDown={onKey}
      />
      <input
        value={dur}
        placeholder="分钟"
        title="回车保存,Esc 取消"
        className="w-16 rounded border border-neutral-300 px-2 py-1 text-xs outline-none focus:border-blue-400"
        onChange={(e) => setDur(e.target.value)}
        onKeyDown={onKey}
      />
      {/* 时区(D-27/INV-31):浮动 = 跨时区墙上时间不变(默认,与 naive 语义一致) */}
      <select
        className="rounded border border-neutral-300 px-1 py-1 text-xs"
        value={zone ?? ''}
        onChange={(e) => setZone(e.target.value === '' ? null : e.target.value)}
        title="浮动时间:换时区后仍是同一个墙上时间;指定时区:跨时区自动换算"
      >
        <option value="">浮动时间</option>
        <option value={localZone}>{localZone}</option>
      </select>
      {startTime !== null && (
        <button
          type="button"
          className={chipClass}
          onMouseDown={() => onCommit(null, null, null)}
          title="清除时刻(连带清时长)"
        >
          清除
        </button>
      )}
      {!hasDate && (
        <span className="text-[11px] text-neutral-400">需先设 Date(哪天)时间才会上日历</span>
      )}
    </div>
  );
}

/** 外部镜像任务:标题与时间归 Google 拥有(D-25/INV-29),本地不可改。 */
function ExternalOwnedHint(): React.JSX.Element {
  return (
    <p className="rounded-md bg-neutral-100 px-2 py-1.5 text-[11px] leading-relaxed text-neutral-500">
      该任务来自 Google 日历,<strong>时间与标题请在 Google 日历中修改</strong>。
      其余(完成、优先级、标签、子任务、评论)与普通任务一样,且不会写回 Google。
    </p>
  );
}
