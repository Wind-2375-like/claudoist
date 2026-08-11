import { useEffect, useState } from 'react';
import type { ProjectListItemVM, SearchHitVM } from '../../shared/viewModels';
import { SpikeChat } from './SpikeChat';
import { TaskCard } from './TaskCard';
import { ProjectModal } from './ProjectModal';
import { SettingsModal } from './SettingsModal';
import { SearchPalette } from './SearchPalette';
import { TaskDetailModal } from './TaskDetailModal';
import { toast, useToasts } from './toast';
import { useBucketCounts, useInbox, useProjects, useToday } from './hooks';
import { InboxView } from './views/InboxView';
import { TodayView } from './views/TodayView';
import { CalendarView } from './views/CalendarView';
import { UpstreamView } from './views/UpstreamView';
import { ProjectView } from './views/ProjectView';
import { MyProjectsView } from './views/MyProjectsView';
import { BucketView, CompletedView } from './views/BucketView';

/** 三栏壳(D-21):侧栏平面项目(计数徽章/折叠/新建/右键编辑)+ GTD 组计数。 */

type View =
  | {
      kind:
        | 'inbox'
        | 'today'
        | 'calendar'
        | 'upstream'
        | 'someday'
        | 'reference'
        | 'completed'
        | 'myprojects';
    }
  | { kind: 'project'; id: string };

interface AppInfo {
  version: string;
  electron: string;
  userData: string;
  packaged: boolean;
}

const DISABLED_MENU = [{ icon: '🏷️', label: 'Filters & Labels', hint: 'M7' }] as const;

/** 可拖拽分栏:宽度持久化 localStorage;invert 用于右栏(向左拖变宽)。 */
function usePaneResize(
  key: string,
  initial: number,
  min: number,
  max: number,
  invert = false,
): { width: number; onPointerDown: (e: React.PointerEvent) => void } {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return saved >= min && saved <= max ? saved : initial;
  });
  const onPointerDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      const next = Math.min(max, Math.max(min, startW + (invert ? -dx : dx)));
      setWidth(next);
      localStorage.setItem(key, String(next));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { width, onPointerDown };
}

function PaneHandle({
  onPointerDown,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
}): React.JSX.Element {
  return (
    <div
      className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-blue-400 active:bg-blue-500"
      onPointerDown={onPointerDown}
    />
  );
}

/** 侧栏项目行:计数徽章 + 右键菜单(编辑 / 标记完成)。 */
function SidebarProject({
  project,
  active,
  onOpen,
  onEdit,
  onCompleted,
}: {
  project: ProjectListItemVM;
  active: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onCompleted: () => void;
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const complete = async (): Promise<void> => {
    if (
      project.activeCount > 0 &&
      !window.confirm(
        `「${project.name}」还有 ${project.activeCount} 个未完成任务(它们不会被改动)。仍标记项目完成?`,
      )
    ) {
      return;
    }
    const r = await window.gtd.projectComplete(project.id);
    if ('error' in r) {
      toast(`完成项目失败:${r.error}`);
      return;
    }
    toast(`项目「${project.name}」已完成`);
    onCompleted();
  };
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onOpen}
        onContextMenu={(e) => {
          e.preventDefault();
          // 相对按钮(currentTarget)定位;offsetX/Y 会随冒泡子元素错乱
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        }}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
          active ? 'bg-red-50 font-medium text-red-700' : 'hover:bg-neutral-200'
        }`}
      >
        <span className="text-neutral-400">#</span>
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {project.activeCount > 0 && (
          <span className="rounded-full bg-neutral-300 px-1.5 text-xs text-neutral-700">
            {project.activeCount}
          </span>
        )}
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          <div
            className="absolute z-50 w-32 rounded-lg border border-neutral-200 bg-white py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-50"
              onClick={() => {
                setMenu(null);
                onEdit();
              }}
            >
              ✎ 编辑
            </button>
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-50"
              onClick={() => {
                setMenu(null);
                void complete();
              }}
            >
              ✓ 标记完成
            </button>
          </div>
        </>
      )}
    </li>
  );
}

function Toasts(): React.JSX.Element {
  const msgs = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {msgs.map((m) => (
        <div
          key={m.id}
          className="max-w-[70vw] rounded-lg bg-neutral-800 px-4 py-2 text-sm text-white shadow-xl"
        >
          {m.text}
        </div>
      ))}
    </div>
  );
}

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'today' });
  const [info, setInfo] = useState<AppInfo | null>(null);
  const left = usePaneResize('pane.left', 240, 180, 420);
  const right = usePaneResize('pane.right', 384, 300, 680, true);
  const inbox = useInbox();
  const today = useToday();
  const projects = useProjects();
  const bucketCounts = useBucketCounts();
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [projectModal, setProjectModal] = useState<'add' | ProjectListItemVM | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // 搜索命中任务后在此层开详情:各视图各有自己的详情态,跨视图跳转只能由 App 承担
  const [searchDetailId, setSearchDetailId] = useState<string | null>(null);

  useEffect(() => {
    void window.gtd.appInfo().then(setInfo);
  }, []);

  // 全局快捷键:⌘N 快速添加、⌘K 搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return;
      if (e.key === 'n') {
        e.preventDefault();
        setQuickAddOpen(true);
      } else if (e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** 命中 → 切到该条目的容器视图;任务再顺手打开详情。 */
  const openHit = (hit: SearchHitVM): void => {
    setView(
      hit.target.view === 'project'
        ? { kind: 'project', id: hit.target.projectId }
        : { kind: hit.target.view },
    );
    setSearchOpen(false);
    setSearchDetailId(hit.kind === 'task' ? hit.id : null);
  };

  // D-23/M6a:hard-landscape 并入任务列表,徽章即任务数
  const todayBadge = today.data ? today.data.tasks.length : undefined;

  const navItem = (
    kind: 'inbox' | 'today' | 'calendar' | 'upstream' | 'someday' | 'reference' | 'completed',
    icon: string,
    label: string,
    badge?: number,
  ): React.JSX.Element => (
    <button
      type="button"
      onClick={() => setView({ kind })}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
        view.kind === kind ? 'bg-red-50 font-medium text-red-700' : 'hover:bg-neutral-200'
      }`}
    >
      <span>{icon}</span>
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto rounded-full bg-neutral-300 px-1.5 text-xs text-neutral-700">
          {badge}
        </span>
      )}
    </button>
  );

  return (
    <div className="flex h-screen select-none bg-white text-neutral-800">
      {/* 左栏:menu */}
      <aside
        style={{ width: left.width }}
        className="flex shrink-0 flex-col overflow-y-auto border-r border-neutral-200 bg-neutral-50 p-3"
      >
        <button
          className="mb-4 flex items-center gap-2 rounded-md px-2 py-1.5 text-left font-medium text-red-600 hover:bg-neutral-200"
          type="button"
          title="快速添加(⌘N)"
          onClick={() => setQuickAddOpen(true)}
        >
          <span className="text-lg leading-none">＋</span> Add task
        </button>
        <nav className="space-y-0.5">
          {navItem('inbox', '📥', 'Inbox', inbox.data?.length)}
          {navItem('today', '📅', 'Today', todayBadge)}
          {navItem('calendar', '🗓️', 'Calendar')}
          <button
            type="button"
            data-testid="search-open"
            onClick={() => setSearchOpen(true)}
            title="搜索(⌘K)"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-neutral-200"
          >
            <span>🔍</span>
            Search
            <kbd className="ml-auto text-[10px] text-neutral-400">⌘K</kbd>
          </button>
          {DISABLED_MENU.map((item) => (
            <div
              key={item.label}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm text-neutral-400"
              title={`${item.hint} 上线`}
            >
              <span>{item.icon}</span>
              {item.label}
            </div>
          ))}
        </nav>

        {/* My Projects 组头:点文字 → 总览;+ 新建;箭头折叠 */}
        <div className="mt-6 flex items-center gap-1 px-2">
          <button
            type="button"
            onClick={() => setView({ kind: 'myprojects' })}
            className={`flex-1 text-left text-xs font-semibold ${
              view.kind === 'myprojects'
                ? 'text-red-700'
                : 'text-neutral-500 hover:text-neutral-700'
            }`}
            title="项目总览(进度)"
          >
            My Projects
          </button>
          <button
            type="button"
            className="rounded px-1 text-sm text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
            title="新建项目"
            onClick={() => setProjectModal('add')}
          >
            ＋
          </button>
          <button
            type="button"
            className="rounded px-1 text-xs text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
            title={projectsCollapsed ? '展开项目列表' : '折叠项目列表'}
            onClick={() => setProjectsCollapsed((v) => !v)}
          >
            {projectsCollapsed ? '▸' : '▾'}
          </button>
        </div>
        {!projectsCollapsed && (
          <ul className="mt-1 space-y-0.5">
            {projects.data?.map((p) => (
              <SidebarProject
                key={p.id}
                project={p}
                active={view.kind === 'project' && view.id === p.id}
                onOpen={() => setView({ kind: 'project', id: p.id })}
                onEdit={() => setProjectModal(p)}
                onCompleted={() => {
                  // 正在看这个项目 → 回总览,避免停留在已完成项目里继续操作
                  setView((v) =>
                    v.kind === 'project' && v.id === p.id ? { kind: 'myprojects' } : v,
                  );
                }}
              />
            ))}
          </ul>
        )}

        <div className="mt-6 px-2 text-xs font-semibold text-neutral-500">GTD</div>
        <nav className="mt-1 space-y-0.5">
          {/* Upstream(Google 镜像)不进侧栏:条目太多,徽章长期是个大数字,喧宾夺主。
              镜像任务本来就在 Calendar/Today 上各就各位;这个容器视图保留,经 ⌘K 命中可达。 */}
          {navItem('someday', '🌙', 'Someday/Maybe', bucketCounts.data?.someday)}
          {navItem('reference', '📚', 'Reference', bucketCounts.data?.reference)}
          {navItem('completed', '☑️', 'Completed')}
        </nav>
        <button
          type="button"
          className="mt-auto flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-neutral-200"
          onClick={() => setSettingsOpen(true)}
          title="设置(Google 日历连接)"
        >
          <span>⚙️</span> Settings
        </button>
        <div className="px-2 pt-2 text-[11px] leading-relaxed text-neutral-400">
          {info
            ? `v${info.version} · Electron ${info.electron} · ${info.packaged ? 'packaged' : 'dev'}`
            : 'IPC…'}
        </div>
      </aside>

      <PaneHandle onPointerDown={left.onPointerDown} />

      {/* 中栏:content(@container 供视图做容器查询降级) */}
      <main className="@container min-w-0 flex-1 overflow-y-auto">
        {view.kind === 'inbox' && <InboxView />}
        {view.kind === 'today' && <TodayView />}
        {view.kind === 'calendar' && <CalendarView />}
        {view.kind === 'upstream' && <UpstreamView />}
        {view.kind === 'myprojects' && (
          <MyProjectsView onOpenProject={(id) => setView({ kind: 'project', id })} />
        )}
        {view.kind === 'project' && <ProjectView projectId={view.id} />}
        {view.kind === 'someday' && <BucketView kind="someday" />}
        {view.kind === 'reference' && <BucketView kind="reference" />}
        {view.kind === 'completed' && <CompletedView />}
      </main>

      {quickAddOpen && <TaskCard mode="add" onClose={() => setQuickAddOpen(false)} />}
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} onPick={openHit} />}
      {searchDetailId !== null && (
        <TaskDetailModal taskId={searchDetailId} onClose={() => setSearchDetailId(null)} />
      )}
      <Toasts />
      {projectModal !== null && (
        <ProjectModal
          {...(projectModal === 'add' ? {} : { project: projectModal })}
          onClose={() => setProjectModal(null)}
        />
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      <PaneHandle onPointerDown={right.onPointerDown} />

      {/* 右栏:agent */}
      <aside
        style={{ width: right.width }}
        className="flex shrink-0 flex-col border-l border-neutral-200 bg-neutral-900 text-neutral-100"
      >
        <div className="flex items-center justify-between border-b border-neutral-700 px-4 py-3">
          <span className="text-sm font-semibold">Agent</span>
          <div className="flex gap-2 text-neutral-400">
            <span title="历史会话(M10)">🕘</span>
            <span title="新建会话(M10)">＋</span>
          </div>
        </div>
        <SpikeChat />
      </aside>
    </div>
  );
}
