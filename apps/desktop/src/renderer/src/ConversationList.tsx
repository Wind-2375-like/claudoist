import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationVM } from '../../shared/viewModels';
import { IconArchive, IconFork, IconPencil, IconTrash } from './icons';
import { isSubmitEnter } from './keys';
import { relTime } from './relTime';
import { toast } from './toast';

/**
 * 历史会话(M10;2026-10-18 改成 VSCode 式下拉,用户:「历史对话 ui 要四个:edit (rename),
 * fork, archive, delete」)。
 *
 * 每行只有标题 + 相对时间;悬停时时间换成四个动作。四个动作各有各的语义,别混:
 * - **点标题** = resume,接着原来那条聊(上下文完整,SDK 从 jsonl 恢复);
 * - **改名** = 行内编辑,回车保存、Esc 取消、失焦保存;改过名的不再被首条消息自动起标题;
 * - **分叉** = 从这条的当前状态复制一份新会话,两边此后各走各的(试探性对话用);
 * - **归档** = 从列表默认视图收起,正文与索引都在,底部「已归档」里随时取消;
 * - **删除** = 索引行 + jsonl 一起删,不可恢复 —— 所以仍要二次确认。
 * 模型、花费、创建时间收进行的 tooltip:VSCode 也不在行上摆这些。
 */
export function ConversationList({
  onOpen,
  onChanged,
}: {
  onOpen: (id: string, fork: boolean) => void;
  /** 改名 / 归档 / 删除之后:顶栏标题可能要跟着变 */
  onChanged: () => void;
}): React.JSX.Element {
  const [rows, setRows] = useState<ConversationVM[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 一次编辑只结束一次:回车 / Esc 卸掉输入框时浏览器还可能补发一个 blur,
      它拿的是旧闭包 —— 不拦的话 Esc 取消的改名会被这个 blur 存进去 */
  const editDone = useRef(false);
  const startEdit = (c: ConversationVM): void => {
    editDone.current = false;
    setEditing({ id: c.id, title: c.title });
  };

  const load = useCallback(() => {
    void window.agent.conversations().then(setRows);
  }, []);
  useEffect(load, [load]);

  const finishEdit = (save: boolean): void => {
    if (editing === null || editDone.current) return;
    editDone.current = true;
    const { id, title } = editing;
    setEditing(null);
    if (!save) return;
    const old = rows?.find((r) => r.id === id)?.title;
    if (title.trim() === '' || title.trim() === old) return;
    void window.agent.renameConversation(id, title).then((r) => {
      if (r.error !== undefined) toast(r.error);
      load();
      onChanged();
    });
  };

  if (rows === null) return <p className="p-4 text-center text-xs text-fnt">读取中…</p>;
  const archivedCount = rows.filter((r) => r.archived).length;
  const visible = rows.filter((r) => r.archived === showArchived);

  return (
    <div className="flex max-h-[min(70vh,520px)] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {visible.length === 0 && (
          <p className="p-4 text-center text-xs text-fnt">
            {showArchived ? '没有已归档的会话。' : '还没有会话记录。'}
          </p>
        )}
        {visible.map((c) => (
          <div key={c.id}>
            <div
              className={`group flex items-center gap-2 rounded-md px-2 py-1.5 ${
                c.active ? 'bg-acc-soft' : 'hover:bg-hov'
              }`}
              title={[
                c.model,
                `≈$${c.costUsd.toFixed(3)}`,
                `创建于 ${c.createdAt.slice(0, 16).replace('T', ' ')}`,
                c.forkedFrom !== null ? '分叉会话' : '',
                c.sdkSessionId === null ? '还没开始' : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              {editing?.id === c.id ? (
                <input
                  autoFocus
                  value={editing.title}
                  className="min-w-0 flex-1 rounded border border-acc bg-surface px-1.5 py-0.5 text-xs outline-none"
                  onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
                  onBlur={() => finishEdit(true)}
                  onKeyDown={(e) => {
                    if (isSubmitEnter(e)) {
                      e.preventDefault();
                      finishEdit(true);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation(); // 只取消改名,别连下拉一起关
                      finishEdit(false);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs"
                  onClick={() => onOpen(c.id, false)}
                >
                  {c.forkedFrom !== null && <IconFork size={12} className="shrink-0 text-fnt" />}
                  <span className={`truncate ${c.active ? 'font-semibold text-ink' : 'text-ink'}`}>
                    {c.title}
                  </span>
                </button>
              )}
              {editing?.id !== c.id && (
                <>
                  <span className="shrink-0 text-[11px] text-fnt group-hover:hidden">
                    {relTime(c.lastMessageAt)}
                  </span>
                  <div className="hidden shrink-0 items-center gap-0.5 text-mut group-hover:flex">
                    <RowAction title="改名" onClick={() => startEdit(c)}>
                      <IconPencil size={13} />
                    </RowAction>
                    <RowAction
                      title={
                        c.sdkSessionId === null
                          ? '这条还没开始,没有可分叉的内容'
                          : '分叉:从这条复制出一条新会话(原会话不受影响)'
                      }
                      disabled={c.sdkSessionId === null}
                      onClick={() => onOpen(c.id, true)}
                    >
                      <IconFork size={13} />
                    </RowAction>
                    <RowAction
                      title={c.archived ? '取消归档' : '归档(从列表收起,随时可取消)'}
                      onClick={() => {
                        void window.agent.archiveConversation(c.id, !c.archived).then(() => {
                          toast(c.archived ? '已取消归档' : '已归档 —— 列表底部「已归档」里可找回');
                          load();
                        });
                      }}
                    >
                      <IconArchive size={13} />
                    </RowAction>
                    <RowAction title="删除" danger onClick={() => setConfirmId(c.id)}>
                      <IconTrash size={13} />
                    </RowAction>
                  </div>
                </>
              )}
            </div>
            {confirmId === c.id && (
              <div className="mx-1 mb-1 rounded bg-danger-soft px-2 py-1.5 text-[11px] text-danger-ink">
                连同对话正文一起删除,不可恢复。
                <button
                  type="button"
                  className="ml-2 rounded bg-danger px-2 py-0.5 text-on-danger"
                  onClick={() => {
                    void window.agent.deleteConversation(c.id).then(() => {
                      setConfirmId(null);
                      load();
                      onChanged();
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
      {(archivedCount > 0 || showArchived) && (
        <button
          type="button"
          className="border-t border-line-soft px-3 py-1.5 text-left text-[11px] text-mut hover:bg-hov hover:text-ink"
          onClick={() => setShowArchived(!showArchived)}
        >
          {showArchived ? '← 返回会话列表' : `已归档(${String(archivedCount)})`}
        </button>
      )}
    </div>
  );
}

function RowAction({
  title,
  onClick,
  disabled = false,
  danger = false,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`flex h-5 w-5 items-center justify-center rounded disabled:opacity-30 ${
        danger ? 'hover:bg-danger-soft hover:text-danger-ink' : 'hover:bg-sel hover:text-ink'
      }`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}
