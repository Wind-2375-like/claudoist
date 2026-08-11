import { useEffect, useRef, useState } from 'react';
import type { AddSubtaskInputVM, QuickAddTaskInputVM, TaskVM } from '../../shared/viewModels';
import { useLabels, useProjects } from './hooks';
import { PRIORITY_CHOICES as PRIORITIES } from '../../shared/priority';

/**
 * Todoist 式统一卡片(D-20 容器模型):
 * - mode='add':位置=Inbox 且零属性 → 纯捕捉(任务生在 Inbox,不挪不消失);
 *   否则直建任务(位置=Someday/Reference 时先建后移)。
 * - mode='add' + parentTaskId:添加子任务(D-22)——同一表单,继承父的位置,
 *   不显示 Move to 选择器(子任务随根,INV-25)。
 * - mode='edit':编辑既有任务属性;位置变化 = 容器移动(Move to)。
 */

const pad = (n: number): string => String(n).padStart(2, '0');
const localDate = (offset = 0): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export interface TaskCardProps {
  mode: 'add' | 'edit';
  task?: TaskVM;
  inline?: boolean;
  /** add 模式预填计划日(Today 视图的 Add task) */
  initialScheduled?: string;
  /** add 模式预选位置(项目视图的 Add task 传 projectId) */
  initialLocation?: string;
  /** add 模式:作为该任务的子任务创建(D-22;继承父的位置,隐藏 Move to) */
  parentTaskId?: string;
  onClose: () => void;
}

export function TaskCard({
  mode,
  task,
  inline = false,
  initialScheduled,
  initialLocation: initialLocationProp,
  parentTaskId,
  onClose,
}: TaskCardProps): React.JSX.Element {
  const labels = useLabels();
  const projects = useProjects();
  const titleRef = useRef<HTMLInputElement>(null);
  const isSubtask = parentTaskId !== undefined;

  const initialLocation = task
    ? task.bucket === 'project'
      ? (task.projectId ?? 'inbox')
      : task.bucket
    : (initialLocationProp ?? 'inbox');

  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [scheduled, setScheduled] = useState(task?.scheduledDate ?? initialScheduled ?? '');
  const [deadline, setDeadline] = useState(task?.deadline ?? '');
  const [priority, setPriority] = useState(task?.priority ?? 3);
  const [labelIds, setLabelIds] = useState<string[]>(task?.labels.map((l) => l.id) ?? []);
  const [reminderAt, setReminderAt] = useState('');
  const [location, setLocation] = useState(initialLocation);
  const [showChip, setShowChip] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const specified =
    scheduled !== '' ||
    deadline !== '' ||
    priority !== 3 ||
    labelIds.length > 0 ||
    reminderAt !== '' ||
    description.trim() !== '' ||
    location !== 'inbox' ||
    initialScheduled !== undefined;

  const isBucketLoc = location === 'inbox' || location === 'someday' || location === 'reference';

  const fail = (r: { error: string } | { consequences: unknown }): boolean => {
    if ('error' in r) {
      setError(r.error);
      return true;
    }
    return false;
  };

  const moveTarget = () =>
    isBucketLoc
      ? { bucket: location as 'inbox' | 'someday' | 'reference' }
      : { bucket: 'project' as const, projectId: location };

  const submit = async (): Promise<void> => {
    setError('');
    if (!title.trim()) {
      setError('先写点什么吧');
      return;
    }

    if (mode === 'edit' && task) {
      const patch: Record<string, unknown> = {};
      if (title.trim() !== task.title) patch['title'] = title.trim();
      if (description !== task.description) patch['description'] = description;
      if ((scheduled || null) !== task.scheduledDate) patch['scheduledDate'] = scheduled || null;
      if ((deadline || null) !== task.deadline) patch['deadline'] = deadline || null;
      if (priority !== task.priority) patch['priority'] = priority;
      if (Object.keys(patch).length > 0) {
        const r = await window.gtd.taskUpdate({ id: task.id, patch });
        if (fail(r)) return;
      }
      if (location !== initialLocation) {
        const r = await window.gtd.taskMove({ id: task.id, to: moveTarget() });
        if (fail(r)) return;
      }
      onClose();
      return;
    }

    // mode === 'add' + parentTaskId:创建子任务(D-22;继承父位置)
    if (isSubtask) {
      const input: AddSubtaskInputVM = {
        parentTaskId: parentTaskId!,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(scheduled ? { scheduledDate: scheduled } : {}),
        ...(deadline ? { deadline } : {}),
        ...(priority !== 3 ? { priority } : {}),
        ...(labelIds.length > 0 ? { labelIds } : {}),
        ...(reminderAt ? { reminderAt: reminderAt.slice(0, 16) } : {}),
      };
      const r = await window.gtd.subtaskAdd(input);
      if (fail(r)) return;
      // 连续添加:清空标题保留其余,聚焦
      setTitle('');
      titleRef.current?.focus();
      onClose();
      return;
    }

    // mode === 'add'
    if (!specified) {
      const r = await window.gtd.capture([title.trim()]);
      if (fail(r)) return;
      setTitle('');
      setFeedback('已捕捉进 Inbox,继续输入可连续捕捉');
      titleRef.current?.focus();
      return;
    }
    const input: QuickAddTaskInputVM = {
      title: title.trim(),
      priority,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(scheduled ? { scheduledDate: scheduled } : {}),
      ...(deadline ? { deadline } : {}),
      ...(labelIds.length > 0 ? { labelIds } : {}),
      ...(reminderAt ? { reminderAt: reminderAt.slice(0, 16) } : {}),
      ...(!isBucketLoc ? { projectId: location } : {}),
    };
    const r = await window.gtd.taskCreate(input);
    if (fail(r)) return;
    if ((location === 'someday' || location === 'reference') && 'consequences' in r) {
      const taskId = (r.consequences as { taskId?: string }).taskId;
      if (taskId) {
        const mv = await window.gtd.taskMove({ id: taskId, to: { bucket: location } });
        if (fail(mv)) return;
      }
    }
    onClose();
  };

  const chipCls = (active: boolean): string =>
    `rounded-md border px-2 py-1 text-xs ${active ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'}`;

  const card = (
    <div
      className={`rounded-xl border border-neutral-200 bg-white p-4 ${inline ? '' : 'w-[600px] max-w-[94vw] shadow-2xl'}`}
    >
      <input
        ref={titleRef}
        className="w-full border-none text-base font-medium outline-none placeholder:text-neutral-400"
        placeholder={
          isSubtask
            ? 'Sub-task name'
            : mode === 'add'
              ? 'Task name(直接回车 = 捕捉进 Inbox)'
              : 'Task name'
        }
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <input
        className="mt-1 w-full border-none text-sm outline-none placeholder:text-neutral-400"
        placeholder="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={chipCls(!!scheduled)}
          onClick={() => setShowChip(showChip === 'date' ? null : 'date')}
        >
          📅 {scheduled ? `计划 ${scheduled}` : 'Date'}
        </button>
        <button
          type="button"
          className={chipCls(!!deadline)}
          onClick={() => setShowChip(showChip === 'deadline' ? null : 'deadline')}
        >
          🎯 {deadline ? `截止 ${deadline}` : 'Deadline'}
        </button>
        <button
          type="button"
          className={chipCls(priority !== 3)}
          onClick={() => setShowChip(showChip === 'priority' ? null : 'priority')}
        >
          🚩 {PRIORITIES.find((p) => p.value === priority)?.label}
        </button>
        {mode === 'add' && (
          <>
            <button
              type="button"
              className={chipCls(labelIds.length > 0)}
              onClick={() => setShowChip(showChip === 'labels' ? null : 'labels')}
            >
              🏷 {labelIds.length > 0 ? `${labelIds.length} 个 label` : 'Labels'}
            </button>
            <button
              type="button"
              className={chipCls(!!reminderAt)}
              onClick={() => setShowChip(showChip === 'reminder' ? null : 'reminder')}
            >
              ⏰ {reminderAt ? '已设提醒' : 'Reminders'}
            </button>
          </>
        )}
      </div>

      {showChip === 'date' && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className={chipCls(scheduled === localDate(0))}
            onClick={() => {
              setScheduled(localDate(0));
              setShowChip(null);
            }}
          >
            Today
          </button>
          <button
            type="button"
            className={chipCls(scheduled === localDate(1))}
            onClick={() => {
              setScheduled(localDate(1));
              setShowChip(null);
            }}
          >
            Tomorrow
          </button>
          <input
            placeholder="YYYY-MM-DD"
            className="w-28 rounded border border-neutral-300 px-2 py-1 text-xs outline-none focus:border-blue-400"
            value={scheduled}
            onChange={(e) => setScheduled(e.target.value)}
          />
          {scheduled && (
            <button
              type="button"
              className="text-xs text-neutral-400"
              onClick={() => setScheduled('')}
            >
              清除
            </button>
          )}
        </div>
      )}
      {showChip === 'deadline' && (
        <div className="mt-2 flex items-center gap-2">
          <input
            placeholder="YYYY-MM-DD"
            className="w-28 rounded border border-neutral-300 px-2 py-1 text-xs outline-none focus:border-blue-400"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
          <span className="text-xs text-neutral-400">最迟完成日(与"计划哪天做"互补)</span>
          {deadline && (
            <button
              type="button"
              className="text-xs text-neutral-400"
              onClick={() => setDeadline('')}
            >
              清除
            </button>
          )}
        </div>
      )}
      {showChip === 'priority' && (
        <div className="mt-2 flex gap-1.5">
          {PRIORITIES.map((p) => (
            <button
              key={p.value}
              type="button"
              className={chipCls(priority === p.value)}
              onClick={() => {
                setPriority(p.value);
                setShowChip(null);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      {showChip === 'labels' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {labels.data?.map((l) => (
            <button
              key={l.id}
              type="button"
              className={chipCls(labelIds.includes(l.id))}
              onClick={() =>
                setLabelIds((prev) =>
                  prev.includes(l.id) ? prev.filter((x) => x !== l.id) : [...prev, l.id],
                )
              }
            >
              @{l.name}
            </button>
          ))}
        </div>
      )}
      {showChip === 'reminder' && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="datetime-local"
            className="rounded border border-neutral-300 px-2 py-1 text-xs"
            value={reminderAt}
            onChange={(e) => setReminderAt(e.target.value)}
          />
          <span className="text-xs text-neutral-400">落库即存;响铃 M6 上线</span>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {feedback && <p className="mt-2 text-xs text-green-600">{feedback}</p>}

      <div className="mt-4 flex items-center gap-2 border-t border-neutral-100 pt-3">
        {isSubtask ? (
          <span className="text-xs text-neutral-400">子任务继承父任务的位置</span>
        ) : (
          <select
            className="max-w-56 rounded-md border border-neutral-300 px-2 py-1.5 text-xs"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            title="位置(Move to)"
          >
            <option value="inbox">
              {task?.externalId != null ? '🔗 Upstream(来自 Google 日历)' : '📥 Inbox'}
            </option>
            <option value="someday">🌙 Someday/Maybe</option>
            <option value="reference">📚 Reference</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                # {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
          >
            {mode === 'edit'
              ? '保存'
              : isSubtask
                ? 'Add sub-task'
                : specified
                  ? 'Add task'
                  : '捕捉'}
          </button>
        </div>
      </div>
    </div>
  );

  if (inline) return card;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-24">
      {card}
    </div>
  );
}
