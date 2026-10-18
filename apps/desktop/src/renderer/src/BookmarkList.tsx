import type { BookmarkVM } from '../../shared/viewModels';
import { relTime } from './relTime';
import { IconBookmark } from './icons';

/**
 * 书签列表(顶栏 🔖,2026-10-18 用户要求「跟 vscode 差不多的 ui」)。
 * 收藏的是**某条助手回复**:点一条就切到那条会话、滚到那条回复并闪一下。
 * 书签存在设置表里(agent.bookmarks),会话删了书签跟着清掉。
 */
export function BookmarkList({
  marks,
  onJump,
  onRemove,
}: {
  marks: BookmarkVM[];
  onJump: (b: BookmarkVM) => void;
  onRemove: (b: BookmarkVM) => void;
}): React.JSX.Element {
  return (
    <div className="flex max-h-[min(70vh,520px)] flex-col">
      <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-mut">书签</div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {marks.length === 0 && (
          <p className="px-2 py-4 text-center text-[11px] text-fnt">
            还没有书签。鼠标停在 Claude 的回复上,点下方的书签图标收藏。
          </p>
        )}
        {marks.map((b) => (
          <div
            key={`${b.conversationId}:${b.uuid}`}
            className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hov"
          >
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onJump(b)}>
              <span className="line-clamp-2 text-xs text-ink">{b.preview || '(空回复)'}</span>
              <span className="mt-0.5 block truncate text-[10px] text-fnt">
                {b.title} · {relTime(b.createdAt)}
              </span>
            </button>
            <button
              type="button"
              title="取消书签"
              aria-label="取消书签"
              className="mt-0.5 shrink-0 text-acc opacity-60 group-hover:opacity-100 hover:text-ink"
              onClick={() => onRemove(b)}
            >
              <IconBookmark size={13} filled />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
