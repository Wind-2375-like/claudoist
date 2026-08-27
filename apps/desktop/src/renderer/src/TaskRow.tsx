import { useState } from 'react';
import type { TaskVM } from '../../shared/viewModels';
import { completeTitle, completeWithFeedback, reopenTask, toast } from './toast';
import { ContextMenu, ContextMenuItem } from './ContextMenu';

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
  occurrenceCount,
  depth = 0,
  leading,
  progress,
}: {
  task: TaskVM;
  onDetail?: () => void;
  onEdit?: () => void;
  showCompletedAt?: boolean;
  /** INV-36.14:循环系列折进这一行的完成次数(>1 才显示徽章) */
  occurrenceCount?: number | undefined;
  /** 树缩进层级(M5R5) */
  depth?: number;
  /** 完成圈前的引导元素(展开/折叠箭头或占位) */
  leading?: React.ReactNode;
  /** 直接子任务 "done/total" 徽章(树视图);缺省回退到 ⑂活跃后代数 */
  progress?: { done: number; total: number };
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const done = task.done;

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
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-hov"
        style={depth > 0 ? { paddingLeft: `${depth * 22 + 8}px` } : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          // 视口坐标 —— 菜单是 portal 到 body 的 fixed 元素(见 ContextMenu.tsx)
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {/*
          折叠箭头的槽位**恒定占位**,不按有无内容显隐。
          原来写成 `leading !== undefined &&`,于是没传 leading 的视图
          (Today / Someday / Reference / 过滤器结果)整行比 Inbox、项目视图左移 24px,
          在同一个应用里切来切去左边界会跳(2026-08-12 用户反馈缩进不一致)。
          没有子任务时它就是个空槽 —— 宁可空着,也要让所有列表共用一条左边界。
        */}
        <span className="flex w-4 shrink-0 justify-center">{leading}</span>
        {!done ? (
          <button
            type="button"
            className="h-4.5 w-4.5 shrink-0 rounded-full border-2 border-line hover:border-ok hover:bg-ok-soft"
            title={completeTitle(task.subtaskCount)}
            onClick={() => void completeWithFeedback(task.title, task.id)}
          />
        ) : (
          <button
            type="button"
            className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-ok text-[10px] text-on-acc hover:bg-ok/90"
            title="已完成 — 点击撤销"
            onClick={() => void reopenTask(task.id)}
          >
            ✓
          </button>
        )}
        <button
          type="button"
          onClick={onDetail}
          className={`min-w-0 flex-1 truncate text-left text-sm ${done ? 'text-fnt line-through' : ''}`}
          title="查看详情(子任务 / 评论)"
        >
          {task.title}
          {progress && progress.total > 0 ? (
            <span className="ml-1.5 text-xs text-fnt">
              ⑂ {progress.done}/{progress.total}
            </span>
          ) : (
            !progress &&
            task.subtaskCount > 0 && (
              <span className="ml-1.5 text-xs text-fnt">⑂{task.subtaskCount}</span>
            )
          )}
        </button>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-fnt">
          {task.externalId !== null && (
            <span
              className="rounded bg-inset px-1 py-0.5"
              title="来自 Google 日历:时间不可在此修改,完成/标签等本地操作不会写回"
            >
              🗓 Google
            </span>
          )}
          {task.startTime && (
            <span className="rounded bg-acc-soft px-1 py-0.5 text-acc">
              🕐 {task.startTime}·{task.durationMinutes ?? task.estimatedMinutes}m
            </span>
          )}
          {task.scheduledDate && <span className="text-acc">📅 {task.scheduledDate}</span>}
          {/* 🔁 紧贴 📅:循环是对计划日的修饰,不该被 🎯deadline 隔开 */}
          {task.repeatShort !== null && (
            <span className="text-acc" title={task.repeatLong ?? undefined}>
              🔁 {task.repeatShort}
            </span>
          )}
          {task.deadline && (
            <span className={task.overdue ? 'font-medium text-danger-ink' : ''}>
              🎯 {task.deadline}
            </span>
          )}
          {task.priority !== 3 && (
            <span className="rounded bg-inset px-1 py-0.5">{task.priorityLabel}</span>
          )}
          {task.labels.map((l) => (
            <span
              key={l.id}
              className="hidden rounded bg-warn-soft px-1 py-0.5 text-warn-ink @md:inline"
            >
              @{l.name}
            </span>
          ))}
          {showCompletedAt && task.completedAt && <span>{task.completedAt.slice(0, 10)} 完成</span>}
          {(occurrenceCount ?? 1) > 1 && (
            <span
              className="rounded-full bg-acc-soft px-2 py-0.5 text-acc"
              title="循环任务的历史完成次数(只显示最近一次)"
            >
              共 {occurrenceCount} 次
            </span>
          )}
        </span>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {!done && (
            <ContextMenuItem
              onClick={() => {
                setMenu(null);
                void completeWithFeedback(task.title, task.id);
              }}
            >
              ✓ 完成
            </ContextMenuItem>
          )}
          {onEdit && (
            <ContextMenuItem
              onClick={() => {
                setMenu(null);
                onEdit();
              }}
            >
              ✎ 编辑 / 移动
            </ContextMenuItem>
          )}
          <ContextMenuItem
            danger
            onClick={() => {
              setMenu(null);
              void remove();
            }}
          >
            🗑 删除
          </ContextMenuItem>
        </ContextMenu>
      )}
    </div>
  );
}
