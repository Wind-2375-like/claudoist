import { useCallback, useEffect, useState } from 'react';
import type { ConversationVM } from '../../shared/viewModels';

/**
 * 历史会话抽屉(M10)。
 *
 * 三个动作各有各的语义,别混:
 * - **打开** = resume,接着原来那条聊(上下文完整,SDK 从 jsonl 恢复);
 * - **分叉** = 从这条的当前状态复制一份新会话,两边此后各走各的(试探性对话用);
 * - **删除** = 索引行 + jsonl 一起删,不可恢复。
 */
export function ConversationList({
  onOpen,
  onClose,
}: {
  onOpen: (id: string, fork: boolean) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [rows, setRows] = useState<ConversationVM[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(() => {
    void window.agent.conversations().then(setRows);
  }, []);
  useEffect(load, [load]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-700 px-4 py-3">
        <span className="text-sm font-semibold text-neutral-100">历史会话</span>
        <button type="button" className="text-neutral-400 hover:text-neutral-100" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rows.length === 0 && (
          <p className="p-6 text-center text-xs text-neutral-500">还没有会话记录。</p>
        )}
        {rows.map((c) => (
          <div
            key={c.id}
            className={`mb-1.5 rounded-lg border px-2.5 py-2 ${
              c.active
                ? 'border-blue-700 bg-blue-950/30'
                : 'border-neutral-800 hover:bg-neutral-850'
            }`}
          >
            <div className="flex items-start gap-2">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onOpen(c.id, false)}
              >
                <div className="truncate text-xs text-neutral-200">{c.title}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-neutral-500">
                  <span>{c.lastMessageAt.slice(0, 16).replace('T', ' ')}</span>
                  <span>{c.model}</span>
                  <span>${c.costUsd.toFixed(3)}</span>
                  {c.forkedFrom !== null && <span className="text-amber-500">分叉</span>}
                  {c.sdkSessionId === null && <span className="text-neutral-600">未开始</span>}
                </div>
              </button>
              <div className="flex shrink-0 gap-1 text-[10px]">
                <button
                  type="button"
                  title="从这条分叉出一条新会话(原会话不受影响)"
                  disabled={c.sdkSessionId === null}
                  className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                  onClick={() => onOpen(c.id, true)}
                >
                  分叉
                </button>
                <button
                  type="button"
                  className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-400 hover:bg-red-900 hover:text-red-200"
                  onClick={() => setConfirmId(c.id)}
                >
                  删除
                </button>
              </div>
            </div>
            {confirmId === c.id && (
              <div className="mt-2 rounded bg-red-950/60 px-2 py-1.5 text-[11px] text-red-200">
                连同对话正文一起删除,不可恢复。
                <button
                  type="button"
                  className="ml-2 rounded bg-red-700 px-2 py-0.5 text-white"
                  onClick={() => {
                    void window.agent.deleteConversation(c.id).then(() => {
                      setConfirmId(null);
                      load();
                    });
                  }}
                >
                  确认删除
                </button>
                <button
                  type="button"
                  className="ml-1 px-2 py-0.5 underline"
                  onClick={() => setConfirmId(null)}
                >
                  取消
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
