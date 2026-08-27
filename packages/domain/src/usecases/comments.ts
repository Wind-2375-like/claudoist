import type { Id } from '../entities/common';
import type { TaskComment } from '../entities/taskComment';
import type { GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import type { UsecaseResult } from './types';

/** 任务评论(D-21,INVARIANTS §2.9):仅追加,不参与任何不变量。 */

export interface AddCommentInput {
  taskId: Id;
  body: string;
}

export interface AddCommentConsequences {
  commentId: Id;
}

export function addComment(
  snap: GtdSnapshot,
  deps: FlowDeps,
  input: AddCommentInput,
): UsecaseResult<AddCommentConsequences> {
  const body = input.body.trim();
  if (!body) return { error: '评论不能为空' };
  const task = snap.tasks.find((t) => t.id === input.taskId);
  if (!task) return { error: `任务不存在: ${input.taskId}` };
  const comment: TaskComment = {
    id: deps.idGen.next(),
    taskId: task.id,
    body,
    createdAt: deps.clock.now(),
  };
  return {
    commands: [{ kind: 'createComment', comment }],
    consequences: { commentId: comment.id },
  };
}

export interface DeleteCommentInput {
  id: Id;
}

export function deleteComment(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: DeleteCommentInput,
): UsecaseResult<{ commentId: Id }> {
  if (!snap.comments.some((c) => c.id === input.id)) {
    return { error: `评论不存在: ${input.id}` };
  }
  return {
    commands: [{ kind: 'deleteComment', id: input.id }],
    consequences: { commentId: input.id },
  };
}
