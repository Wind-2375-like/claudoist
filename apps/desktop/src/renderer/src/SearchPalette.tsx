import { useEffect, useRef, useState } from 'react';
import type { SearchHitVM } from '../../shared/viewModels';
import { useSearch } from './hooks';
import { isSubmitEnter } from './keys';

/**
 * ⌘K 全局搜索(M7a)。匹配、排序、截断全部来自 domain `searchAll` —— 这里只呈现与导航,
 * 不做任何自己的过滤(同 INV-20.6 的纪律:一套口径只能有一处实现)。
 *
 * 键盘:↑/↓ 移动、Enter 打开、Esc 关闭。选中项跟随结果变化重置到第一条。
 */
export function SearchPalette({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (hit: SearchHitVM) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data, isFetching } = useSearch(query);
  const hits = data?.hits ?? [];

  // 命令面板打开即可输入 —— 这是它存在的全部意义
  useEffect(() => inputRef.current?.focus(), []);

  // 结果变了就回到第一条,否则光标会停在一个已经不存在的位置上
  useEffect(() => setCursor(0), [query]);

  // 选中项滚入可视区(键盘翻到列表外时)
  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (hits.length === 0 ? 0 : (c + 1) % hits.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (hits.length === 0 ? 0 : (c - 1 + hits.length) % hits.length));
    } else if (isSubmitEnter(e)) {
      e.preventDefault();
      const hit = hits[cursor];
      if (hit) onPick(hit);
    }
  };

  const q = query.trim();
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim pt-24"
      onClick={onClose}
    >
      <div
        className="flex max-h-[60vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-line bg-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
          <span className="text-fnt">🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索任务、项目…"
            className="min-w-0 flex-1 text-sm outline-none placeholder:text-fnt"
          />
          <kbd className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fnt">Esc</kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {q === '' ? (
            <p className="px-4 py-6 text-center text-xs text-fnt">
              输入关键词搜索任务标题与描述、项目名称。
            </p>
          ) : hits.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-fnt">
              {isFetching ? '搜索中…' : `没有匹配「${q}」的任务或项目。`}
            </p>
          ) : (
            <ul ref={listRef} className="py-1">
              {hits.map((h, i) => (
                <li key={`${h.kind}:${h.id}`}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 px-4 py-2 text-left ${
                      i === cursor ? 'bg-brand-soft' : 'hover:bg-hov'
                    }`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => onPick(h)}
                  >
                    <span className="shrink-0 text-xs">{h.kind === 'project' ? '📁' : '○'}</span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-sm ${h.done ? 'text-fnt line-through' : ''}`}
                      >
                        {h.title}
                      </span>
                      <span className="block truncate text-[11px] text-fnt">{h.subtitle}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {q !== '' && hits.length > 0 && (
          <div className="border-t border-line-soft px-4 py-1.5 text-[11px] text-fnt">
            {data && data.totalMatched > hits.length
              ? `显示 ${hits.length} / ${data.totalMatched} 条(含未在此列出的等待项)`
              : `${hits.length} 条结果`}
            <span className="float-right">↑↓ 选择 · ↵ 打开</span>
          </div>
        )}
      </div>
    </div>
  );
}
