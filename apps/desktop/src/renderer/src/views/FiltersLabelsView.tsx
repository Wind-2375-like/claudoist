import { useState } from 'react';
import type { FilterListItemVM, LabelListItemVM } from '../../../shared/viewModels';
import { useFilters, useLabels } from '../hooks';
import { toast } from '../toast';
import { isSubmitEnter } from '../keys';

/**
 * Filters & Labels(M7b)。两段:保存的过滤器、标签。
 *
 * 过滤器是**文本查询**(INV-33),不是一组勾选框 —— 勾选框表达不了 `|`、`!`、括号,
 * 也表达不了"一周内到期却还没排期"这种真正有用的组合。语法帮助就摆在新建框下面,
 * 因为一个没人记得住写法的查询语言等于没有。
 */
const SYNTAX_HELP: [string, string][] = [
  ['@标签  #项目', '带该标签 / 属于该项目(名字带空格用引号:@"deep work")'],
  ['p5  p>=4', '优先级(⚠ 本仓 p5 = 最高,与 Todoist 相反)'],
  ['today  tomorrow  overdue  no date', '**计划日**(裸关键字一律指计划日)'],
  ['deadline: today  deadline before: +7 days  no deadline', '**截止日**(只能这样写)'],
  ['next 7 days  due: 2026-09-01..2026-09-30', '未来 N 天 / 计划日区间'],
  ['energy: low   est: 30', '精力 ≤ / 预估分钟 ≤(容量语义)'],
  ['inbox  someday  reference  bucket: project', '容器'],
  ['done  status: active,done  status: any', '状态(默认只看活跃;没提 deleted 就永不含软删)'],
  ['search: 关键词   title:   desc:', '文本搜索(标题+描述)'],
  ['no labels  no project  no time  subtask  mirrored  recurring', '标志位'],
  ['& | ! ( )', '与 / 或 / 非 / 分组'],
  ['a, b', '顶层逗号 = 并列两段结果(不是"或")'],
];

export function FiltersLabelsView({
  onOpenFilter,
  onOpenLabel,
}: {
  onOpenFilter: (query: string, name: string) => void;
  onOpenLabel: (name: string) => void;
}): React.JSX.Element {
  const filters = useFilters();
  const labels = useLabels();
  const [adding, setAdding] = useState<'filter' | 'label' | null>(null);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** 编辑中的过滤器(名称 + 查询同时可改) */
  const [editFilter, setEditFilter] = useState<{ id: string; name: string; query: string } | null>(
    null,
  );
  const [showHelp, setShowHelp] = useState(false);

  const reset = (): void => {
    setAdding(null);
    setName('');
    setQuery('');
  };

  const run = async (r: Promise<{ error: string } | unknown>): Promise<boolean> => {
    const res = (await r) as { error?: string };
    if (res && typeof res === 'object' && 'error' in res && res.error) {
      toast(res.error);
      return false;
    }
    return true;
  };

  const addFilter = async (): Promise<void> => {
    if (name.trim() === '' || query.trim() === '') return;
    if (await run(window.gtd.filterAdd(name.trim(), query.trim()))) reset();
  };

  const addLabel = async (): Promise<void> => {
    if (name.trim() === '') return;
    if (await run(window.gtd.labelAdd(name.trim()))) reset();
  };

  const renameLabel = async (l: LabelListItemVM): Promise<void> => {
    if (draft.trim() === '' || draft.trim() === l.name) {
      setEditing(null);
      return;
    }
    if (await run(window.gtd.labelUpdate(l.id, { name: draft.trim() }))) setEditing(null);
  };

  const saveFilter = async (): Promise<void> => {
    const e = editFilter;
    if (e === null || e.name.trim() === '' || e.query.trim() === '') return;
    if (await run(window.gtd.filterUpdate(e.id, { name: e.name.trim(), query: e.query.trim() }))) {
      setEditFilter(null);
    }
  };

  const removeFilter = async (f: FilterListItemVM): Promise<void> => {
    if (!window.confirm(`删除过滤器「${f.name}」?(不影响任何任务)`)) return;
    await run(window.gtd.filterDelete(f.id));
  };

  const removeLabel = async (l: LabelListItemVM): Promise<void> => {
    const warn =
      l.activeTaskCount > 0
        ? `删除标签 @${l.name}?${l.activeTaskCount} 个活跃任务会失去这个标签(任务本身不受影响)。`
        : `删除标签 @${l.name}?`;
    if (!window.confirm(warn)) return;
    await run(window.gtd.labelDelete(l.id));
  };

  const syntaxTable = (
    <table className="mt-2 w-full text-[11px]">
      <tbody>
        {SYNTAX_HELP.map(([syntax, desc]) => (
          <tr key={syntax} className="align-top">
            <td className="w-[46%] py-0.5 pr-3 font-mono text-neutral-700">{syntax}</td>
            <td className="py-0.5 text-neutral-500">{desc}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const sectionHead = (
    title: string,
    count: number | undefined,
    kind: 'filter' | 'label',
  ): React.JSX.Element => (
    <div className="mb-1 flex items-center gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {count !== undefined && <span className="text-xs text-neutral-400">{count}</span>}
      <button
        type="button"
        className="ml-auto rounded px-1.5 text-lg leading-none text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
        title={kind === 'filter' ? '新建过滤器' : '新建标签'}
        onClick={() => {
          setAdding(adding === kind ? null : kind);
          setName('');
          setQuery('');
        }}
      >
        ＋
      </button>
    </div>
  );

  return (
    <div className="px-8 py-6">
      <h1 className="mb-5 text-2xl font-bold">Filters &amp; Labels</h1>

      {/* ── 过滤器 ── */}
      <section className="mb-8">
        {sectionHead('My Filters', filters.data?.length, 'filter')}
        {adding === 'filter' && (
          <div className="mb-2 rounded-lg border border-neutral-200 p-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="过滤器名称"
              className="mb-2 w-full rounded border border-neutral-200 px-2 py-1 text-sm outline-none focus:border-blue-400"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (isSubmitEnter(e)) void addFilter();
                if (e.key === 'Escape') reset();
              }}
              placeholder="查询,例如:deadline before: +7 days & no date"
              className="w-full rounded border border-neutral-200 px-2 py-1 font-mono text-sm outline-none focus:border-blue-400"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-700"
                onClick={() => void addFilter()}
              >
                保存
              </button>
              <button
                type="button"
                className="text-xs text-neutral-400 hover:text-neutral-700"
                onClick={reset}
              >
                取消
              </button>
              <button
                type="button"
                className="ml-auto text-xs text-neutral-400 underline hover:text-neutral-700"
                onClick={() => setShowHelp(!showHelp)}
              >
                {showHelp ? '收起语法' : '查询语法'}
              </button>
            </div>
            {showHelp && syntaxTable}
          </div>
        )}
        <ul>
          {(filters.data ?? []).map((f) => (
            <li key={f.id} className="border-b border-neutral-100">
              {editFilter?.id === f.id ? (
                <div className="px-1 py-2">
                  <input
                    value={editFilter.name}
                    onChange={(e) => setEditFilter({ ...editFilter, name: e.target.value })}
                    className="mb-1 w-full rounded border border-neutral-200 px-2 py-1 text-sm outline-none focus:border-blue-400"
                  />
                  <input
                    value={editFilter.query}
                    onChange={(e) => setEditFilter({ ...editFilter, query: e.target.value })}
                    onKeyDown={(e) => {
                      if (isSubmitEnter(e)) void saveFilter();
                      if (e.key === 'Escape') setEditFilter(null);
                    }}
                    className="w-full rounded border border-neutral-200 px-2 py-1 font-mono text-sm outline-none focus:border-blue-400"
                  />
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-700"
                      onClick={() => void saveFilter()}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="text-xs text-neutral-400 hover:text-neutral-700"
                      onClick={() => setEditFilter(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="ml-auto text-xs text-neutral-400 underline hover:text-neutral-700"
                      onClick={() => setShowHelp(!showHelp)}
                    >
                      {showHelp ? '收起语法' : '查询语法'}
                    </button>
                  </div>
                  {showHelp && syntaxTable}
                </div>
              ) : (
                <div className="group flex items-center gap-2 px-1 py-2">
                  <span className="text-neutral-400">◍</span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onOpenFilter(f.query, f.name)}
                  >
                    <span className="block truncate text-sm">{f.name}</span>
                    <span
                      className={`block truncate font-mono text-[11px] ${
                        f.error !== null ? 'text-red-600' : 'text-neutral-400'
                      }`}
                    >
                      {f.error !== null ? `语法错误:${f.error}` : f.query}
                    </span>
                  </button>
                  {f.matchCount !== null && (
                    <span className="shrink-0 text-xs text-neutral-400">{f.matchCount}</span>
                  )}
                  <button
                    type="button"
                    className="shrink-0 text-xs text-neutral-300 opacity-0 group-hover:opacity-100 hover:text-neutral-700"
                    onClick={() => {
                      setEditFilter({ id: f.id, name: f.name, query: f.query });
                      setAdding(null);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-neutral-300 opacity-0 group-hover:opacity-100 hover:text-red-600"
                    onClick={() => void removeFilter(f)}
                  >
                    删除
                  </button>
                </div>
              )}
            </li>
          ))}
          {filters.data?.length === 0 && (
            <li className="py-2 text-xs text-neutral-400">还没有过滤器 —— 点右上角 ＋ 建一个。</li>
          )}
        </ul>
      </section>

      {/* ── 标签 ── */}
      <section>
        {sectionHead('Labels', labels.data?.length, 'label')}
        {adding === 'label' && (
          <div className="mb-2 flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (isSubmitEnter(e)) void addLabel();
                if (e.key === 'Escape') reset();
              }}
              placeholder="标签名(不用打 @)"
              className="flex-1 rounded border border-neutral-200 px-2 py-1 text-sm outline-none focus:border-blue-400"
            />
            <button
              type="button"
              className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-700"
              onClick={() => void addLabel()}
            >
              新建
            </button>
            <button
              type="button"
              className="text-xs text-neutral-400 hover:text-neutral-700"
              onClick={reset}
            >
              取消
            </button>
          </div>
        )}
        <ul>
          {(labels.data ?? []).map((l) => (
            <li
              key={l.id}
              className="group flex items-center gap-2 border-b border-neutral-100 px-1 py-2"
            >
              <span className="text-neutral-400">🏷</span>
              {editing === l.id ? (
                <input
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (isSubmitEnter(e)) void renameLabel(l);
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  onBlur={() => void renameLabel(l)}
                  className="min-w-0 flex-1 rounded border border-blue-400 px-1 py-0.5 text-sm outline-none"
                />
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm"
                  onClick={() => onOpenLabel(l.name)}
                >
                  @{l.name}
                </button>
              )}
              <span className="shrink-0 text-xs text-neutral-400">{l.activeTaskCount}</span>
              <button
                type="button"
                className="shrink-0 text-xs text-neutral-300 opacity-0 group-hover:opacity-100 hover:text-neutral-700"
                onClick={() => {
                  setDraft(l.name);
                  setEditing(l.id);
                }}
              >
                改名
              </button>
              <button
                type="button"
                className="shrink-0 text-xs text-neutral-300 opacity-0 group-hover:opacity-100 hover:text-red-600"
                onClick={() => void removeLabel(l)}
              >
                删除
              </button>
            </li>
          ))}
          {labels.data?.length === 0 && (
            <li className="py-2 text-xs text-neutral-400">还没有标签。</li>
          )}
        </ul>
      </section>
    </div>
  );
}
