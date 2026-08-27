import { useState } from 'react';
import type { TaskVM } from '../../shared/viewModels';
import { completeTitle, completeWithFeedback, reopenTask, toast } from './toast';

/**
 * 任务行(D-21/22):完成勾选圈(complete↔reopen 可切换)+ 标题 + 属性 chip(label 名)。
 * 单击行主体 → 详情弹窗(onDetail);右键 → 完成 / 编辑(onEdit,原卡片)/ 删除。
 * 完成向下级联(D-22),圈上 hover 提示;误点再点一下撤销。删除带子任务确认含数量。
 */
export function TaskRow({
  task,
  onDetail,
  onEdit,
  showCompletedAt = false,
  depth = 0,
  leading,
  progress,
}: {
  task: TaskVM;
  onDetail?: () => void;
  onEdit?: () => void;
  showCompletedAt?: boolean;
  /** 树缩进层级(M5R5) */
  depth?: number;
  /** 完成圈前的引导元素(展开/折叠箭头或占位) */
  leading?: React.ReactNode;
  /** 直接子任务 "done/total" 徽章(树视图);缺省回退到 ⑂活跃后代数 */
  progress?: { done: number; total: number };
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const done = task.completedAt !== null;

  const remove = async (): Promise<void> => {
    // INV-26.2:级联仅含 active 子树;subtaskCount 与 deletedSubtaskCount 同口径
    if (
      task.subtaskCount > 0 &&
      !window.confirm(`「${task.title}」有 ${task.subtaskCount} 个子任务,将一并删除(可恢复)。继续?`)
    ) {
      return;
    }
    const r = await window.gtd.taskDelete(task.id);
    if ('error' in r) toast(`删除失败:${r.error}`);
  };

  return (
    <div className="relative">
      <div
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-neutral-50"
        style={depth > 0 ? { paddingLeft: `${depth * 22 + 8}px` } : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          // 相对行容器(currentTarget)定位;offsetX/Y 会随冒泡子元素错乱
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        }}
      >
        {leading !== undefined && (
          <span className="flex w-4 shrink-0 justify-center">{leading}</span>
        )}
        {!done ? (
          <button
            type="button"
            className="h-4.5 w-4.5 shrink-0 rounded-full border-2 border-neutral-300 hover:border-green-500 hover:bg-green-50"
            title={completeTitle(task.subtaskCount)}
            onClick={() => void completeWithFeedback(task.title, task.id)}
          />
        ) : (
          <button
            type="button"
            className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-green-500 text-[10px] text-white hover:bg-green-600"
            title="已完成 — 点击撤销"
            onClick={() => void reopenTask(task.id)}
          >
            ✓
          </button>
        )}
        <button
          type="button"
          onClick={onDetail}
          className={`min-w-0 flex-1 truncate text-left text-sm ${done ? 'text-neutral-400 line-through' : ''}`}
          title="查看详情(子任务 / 评论)"
        >
          {task.title}
          {progress && progress.total > 0 ? (
            <span className="ml-1.5 text-xs text-neutral-400">
              ⑂ {progress.done}/{progress.total}
            </span>
          ) : (
            !progress &&
            task.subtaskCount > 0 && (
              <span className="ml-1.5 text-xs text-neutral-400">⑂{task.subtaskCount}</span>
            )
          )}
        </button>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-400">
          {task.externalId !== null && (
            <span
              className="rounded bg-neutral-100 px-1 py-0.5"
              title="来自 Google 日历:时间不可在此修改,完成/标签等本地操作不会写回"
            >
              🗓 Google
            </span>
          )}
          {task.startTime && (
            <span className="rounded bg-blue-50 px-1 py-0.5 text-blue-600">
              🕐 {task.startTime}·{task.durationMinutes ?? task.estimatedMinutes}m
            </span>
          )}
          {task.scheduledDate && <span className="text-blue-600">📅 {task.scheduledDate}</span>}
          {task.deadline && (
            <span className={task.overdue ? 'font-medium text-red-600' : ''}>
              🎯 {task.deadline}
            </span>
          )}
          {task.priority !== 3 && (
            <span className="rounded bg-neutral-100 px-1 py-0.5">{task.priorityLabel}</span>
          )}
          {task.labels.map((l) => (
            <span
              key={l.id}
              className="hidden rounded bg-amber-50 px-1 py-0.5 text-amber-700 @md:inline"
            >
              {l.name}
            </span>
          ))}
          {showCompletedAt && task.completedAt && <span>{task.completedAt.slice(0, 10)} 完成</span>}
        </span>
      </div>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          <div
            className="absolute z-50 w-36 rounded-lg border border-neutral-200 bg-white py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {!done && (
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-50"
                onClick={() => {
                  setMenu(null);
                  void completeWithFeedback(task.title, task.id);
                }}
              >
                ✓ 完成
              </button>
            )}
            {onEdit && (
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-50"
                onClick={() => {
                  setMenu(null);
                  onEdit();
                }}
              >
                ✎ 编辑 / 移动
              </button>
            )}
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
              onClick={() => {
                setMenu(null);
                void remove();
              }}
            >
              🗑 删除
            </button>
          </div>
        </>
      )}
    </div>
  );
}
