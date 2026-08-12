import { useEffect, useState } from 'react';
import type { PermissionRequestVM } from '../../shared/viewModels';

/**
 * 工具审批弹窗(M9)。
 *
 * 设计上有三处是刻意的:
 *
 * 1. **回车什么都不做**,允许只能靠点击。弹窗可能在用户正打字时冒出来,一个回车就把删除
 *    放行是不可接受的失败方式。反过来"回车 = 拒绝"也不行(实测踩到):用户敲的那个回车
 *    本意是发消息,结果静默否掉了一次审批,他还以为 agent 自己放弃了。所以回车**无操作**,
 *    只留 Esc 作为快捷拒绝 —— 误触的代价是"什么都没发生"。
 * 2. **破坏性的那句话放在最显眼处**,而且是数据算出来的("会连带完成 3 个子任务"),
 *    不是泛泛的"此操作有风险"。
 * 3. **入参完整展示**。用户要能看出它到底要改哪一条,而不是只看见工具名。
 */

const CLASS_LABEL: Record<string, string> = {
  read: '读取',
  create: '新建',
  edit: '修改',
  destructive: '破坏性',
};

const TOOL_LABEL: Record<string, string> = {
  capture: '丢进 Inbox',
  create_task: '新建任务',
  add_subtask: '新建子任务',
  create_project: '新建项目',
  create_waiting_for: '记一条等待项',
  create_follow_up: '建催办行动',
  create_label: '新建标签',
  create_filter: '保存过滤器',
  update_task: '修改任务',
  move_task: '移动任务',
  set_task_labels: '设置标签',
  update_project: '修改项目',
  add_comment: '添加评论',
  reopen_task: '重开任务',
  restore_task: '从回收站恢复',
  resolve_waiting_for: '标记等待项已回音',
  complete_task: '完成任务',
  complete_project: '完成项目',
  delete_task: '删除任务',
};

export function PermissionPrompt({
  req,
  onDone,
}: {
  req: PermissionRequestVM;
  onDone: () => void;
}): React.JSX.Element {
  const [sending, setSending] = useState(false);
  const destructive = req.toolClass === 'destructive';

  const respond = (
    r: { behavior: 'allow'; always?: boolean } | { behavior: 'deny'; message?: string },
  ): void => {
    if (sending) return;
    setSending(true);
    void window.agent.respondPermission(req.id, r).then(onDone);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 只认 Esc。Enter 一律不接管 —— 见文件头第 1 条
      if (e.key === 'Escape') {
        e.preventDefault();
        respond({ behavior: 'deny' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req.id, sending]);

  const entries = Object.entries(req.input);

  return (
    <div className="absolute inset-0 z-30 flex items-end justify-center bg-black/50 p-3">
      <div
        className={`w-full rounded-xl border bg-neutral-900 p-3 shadow-2xl ${
          destructive ? 'border-red-700' : 'border-neutral-700'
        }`}
      >
        <div className="flex items-center gap-2">
          <span>{destructive ? '⚠️' : '🔧'}</span>
          <span className="text-sm font-semibold text-neutral-100">
            Claude 想{TOOL_LABEL[req.tool] ?? req.tool}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              destructive ? 'bg-red-900 text-red-200' : 'bg-neutral-800 text-neutral-400'
            }`}
          >
            {CLASS_LABEL[req.toolClass] ?? req.toolClass}
          </span>
        </div>

        {req.escalation !== undefined && (
          <p className="mt-2 rounded bg-red-950/70 px-2 py-1.5 text-xs text-red-200">
            {req.escalation}
          </p>
        )}

        <dl className="mt-2 max-h-40 overflow-auto rounded bg-neutral-950/60 p-2 text-[11px]">
          <div className="mb-1 font-mono text-neutral-500">{req.tool}</div>
          {entries.length === 0 && <span className="text-neutral-500">(无参数)</span>}
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="shrink-0 font-mono text-neutral-500">{k}</dt>
              <dd className="min-w-0 flex-1 break-all text-neutral-300">
                {typeof v === 'string' ? v : JSON.stringify(v)}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={sending}
            data-testid="perm-deny"
            className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
            onClick={() => respond({ behavior: 'deny' })}
          >
            拒绝 <span className="text-neutral-500">(Esc)</span>
          </button>
          <button
            type="button"
            disabled={sending}
            className={`rounded px-3 py-1 text-xs text-white disabled:opacity-40 ${
              destructive ? 'bg-red-700 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-500'
            }`}
            data-testid="perm-allow"
            onClick={() => respond({ behavior: 'allow' })}
          >
            允许这一次
          </button>
          <button
            type="button"
            disabled={sending}
            title={
              destructive
                ? '这是破坏性操作 —— 选了之后它在任何模式下都不再问你'
                : '之后同类调用不再询问(可在设置里清除)'
            }
            className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"
            data-testid="perm-always"
            onClick={() => respond({ behavior: 'allow', always: true })}
          >
            始终允许 {req.tool}
          </button>
        </div>
      </div>
    </div>
  );
}
