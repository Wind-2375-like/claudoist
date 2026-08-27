import { useEffect, useState } from 'react';

/**
 * 轻量 toast(INV-14/INV-26 的后果提示载体):模块级 pub/sub,
 * 任意组件 toast() 发布,App 挂一个 <Toasts/> 订阅渲染。无第三方依赖。
 */

export interface ToastMsg {
  id: number;
  text: string;
}

type Listener = (msgs: ToastMsg[]) => void;

let seq = 0;
let msgs: ToastMsg[] = [];
const listeners = new Set<Listener>();

export function toast(text: string, durationMs = 5000): void {
  const msg: ToastMsg = { id: ++seq, text };
  msgs = [...msgs, msg];
  listeners.forEach((l) => l(msgs));
  setTimeout(() => {
    msgs = msgs.filter((m) => m.id !== msg.id);
    listeners.forEach((l) => l(msgs));
  }, durationMs);
}

export function useToasts(): ToastMsg[] {
  const [state, setState] = useState<ToastMsg[]>(msgs);
  useEffect(() => {
    const l: Listener = (m) => setState(m);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}

/** 完成任务 + 按 INV-14/INV-26 后果发提示(向下级联,D-22);供 TaskRow / 详情弹窗共用。 */
export async function completeWithFeedback(taskTitle: string, taskId: string): Promise<void> {
  const r = await window.gtd.taskComplete(taskId);
  if ('error' in r) {
    toast(`完成失败:${r.error}`);
    return;
  }
  const c = r.consequences as {
    completedSubtaskCount?: number;
    parentCompletionCandidate?: boolean;
    projectHasRemainingActivity?: boolean;
    projectBreadcrumb?: string;
  };
  const bits: string[] = [];
  if ((c.completedSubtaskCount ?? 0) > 0) {
    bits.push(`连同 ${c.completedSubtaskCount} 个子任务一并完成`);
  }
  if (c.parentCompletionCandidate === true && c.projectBreadcrumb) {
    bits.push(`项目「${c.projectBreadcrumb}」已无余活动,可在侧栏右键标记完成`);
  }
  if (bits.length > 0) toast(`已完成「${taskTitle}」— ${bits.join(';')}`);
}

/** 重开(撤销完成):误点完成圆圈后再点一下复原。仅当前任务,不级联。 */
export async function reopenTask(taskId: string): Promise<void> {
  const r = await window.gtd.taskReopen(taskId);
  if ('error' in r) toast(`撤销失败:${r.error}`);
}

/** 完成控件 hover 文案:带未完成子任务时提醒完成会向下级联(D-22 防误操作)。 */
export function completeTitle(subtaskCount: number): string {
  return subtaskCount > 0
    ? `完成将连同 ${subtaskCount} 个未完成子任务一起完成(误点可再点一下撤销)`
    : '完成(误点可再点一下撤销)';
}
