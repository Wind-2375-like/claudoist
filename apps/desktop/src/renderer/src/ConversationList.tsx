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
    <div className="absolute inset-0 z-20 flex flex-col bg-app">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-sm font-semibold text-ink">历史会话</span>
        <button type="button" className="text-mut hover:text-ink" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rows.length === 0 && <p className="p-6 text-center text-xs text-fnt">还没有会话记录。</p>}
        {rows.map((c) => (
          <div
            key={c.id}
            className={`mb-1.5 rounded-lg border px-2.5 py-2 ${
              c.active ? 'border-acc bg-acc-soft' : 'border-line-soft hover:bg-hov'
            }`}
          >
            <div className="flex items-start gap-2">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onOpen(c.id, false)}
              >
                <div className="truncate text-xs text-ink">{c.title}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-fnt">
                  <span>{c.lastMessageAt.slice(0, 16).replace('T', ' ')}</span>
                  <span>{c.model}</span>
                  <span>${c.costUsd.toFixed(3)}</span>
                  {c.forkedFrom !== null && <span className="text-warn-ink">分叉</span>}
                  {c.sdkSessionId === null && <span className="text-fnt">未开始</span>}
                </div>
              </button>
              <div className="flex shrink-0 gap-1 text-[10px]">
                <button
                  type="button"
                  title="从这条分叉出一条新会话(原会话不受影响)"
                  disabled={c.sdkSessionId === null}
                  className="rounded border border-line px-1.5 py-0.5 text-mut hover:bg-hov disabled:opacity-30"
                  onClick={() => onOpen(c.id, true)}
                >
                  分叉
                </button>
                <button
                  type="button"
                  className="rounded border border-line px-1.5 py-0.5 text-mut hover:bg-danger-soft hover:text-danger-ink"
                  onClick={() => setConfirmId(c.id)}
                >
                  删除
                </button>
              </div>
            </div>
            {confirmId === c.id && (
              <div className="mt-2 rounded bg-danger-soft px-2 py-1.5 text-[11px] text-danger-ink">
                连同对话正文一起删除,不可恢复。
                <button
                  type="button"
                  className="ml-2 rounded bg-danger px-2 py-0.5 text-on-danger"
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
