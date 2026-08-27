import { useMemo, useRef, useState } from 'react';
import type { TaskTreeVM } from '../../shared/viewModels';
import { TaskCard } from './TaskCard';
import { TaskRow } from './TaskRow';
import { toast } from './toast';

/**
 * 任务树(M5R6 拖拽 v2 / D-24 / INV-27)。以**扁平行 + 缩进**呈现嵌套(Todoist 式)。
 * 拖拽交互(仅 reorderable 时):
 *   - 上下拖 = 换位(在目标间隙插入),live 蓝线指示落点;
 *   - 向右拖 = indent(缩进,挂到上一行下作子任务);向左拖 = outdent(返回上层);
 *   - 缩进层级由**水平位移**决定,并在 [minDepth, maxDepth] 内夹取(≤5 层,INV-25)。
 * 拖拽时被拖子树**保留占位**(visibility:hidden):列表高度不变,底下的行与 Add task
 * 不会上跳,所以「向右缩进」就是纯粹的向右拖(Todoist 式预留行)。
 * 跨容器/成环由 reorderTask 兜底拒绝并 toast。
 *
 * reorderable=false(详情弹窗复用):此处 depth-0 行是聚焦任务的**子任务**而非容器顶层,
 * 若允许拖拽会把 parentTaskId 误置 null(把子任务摘到容器根)。故弹窗内禁用拖拽,仅展示。
 */

const INDENT = 22; // 每层缩进像素(与 TaskRow paddingLeft = depth*22+8 对齐)
const BASE_PAD = 8;
// 行首偏移:缩进 padding 之后还有 chevron 槽(w-4=16px)+ gap-2(8px)才到完成圈。
// 蓝线要与**落点行的完成圈**对齐(不加会撞上父行的圈,视觉上少一级缩进)。
const ROW_LEAD = 24;
const MAX_LEVEL = 5; // INV-25 最大层级(1-indexed);depth 为 0-indexed,故 depth ≤ MAX_LEVEL-1

interface FlatNode {
  node: TaskTreeVM;
  depth: number; // 0 = 顶层
  parentId: string | null;
  hasChildren: boolean;
  collapsed: boolean;
}

interface Projection {
  indicatorTop: number; // 相对容器的像素 y(蓝线 = 占位行上沿)
  depth: number; // 落点缩进(0-indexed)
  /** 在"候选行序列"中的插入位置 —— 占位行渲染到这里 */
  idx: number;
  parentTaskId: string | null;
  beforeId?: string;
}

/** 拖拽开始时冻结的"抽走被拖块之后"的行几何(内容坐标)。 */
interface DragGeometry {
  tops: number[];
  bottoms: number[];
}

/** space-y-0.5 的行间距 */
const ROW_GAP = 2;

function flatten(
  nodes: TaskTreeVM[],
  collapsed: Set<string>,
  depth = 0,
  parentId: string | null = null,
): FlatNode[] {
  const out: FlatNode[] = [];
  for (const n of nodes) {
    const hasChildren = n.children.length > 0;
    const isCollapsed = hasChildren && collapsed.has(n.task.id);
    out.push({ node: n, depth, parentId, hasChildren, collapsed: isCollapsed });
    if (hasChildren && !isCollapsed) {
      out.push(...flatten(n.children, collapsed, depth + 1, n.task.id));
    }
  }
  return out;
}

/** 被拖任务在**可见扁平列表**中的连续子树块(自身 + 其后 depth 更深的连续行)。 */
function subtreeBlock(flat: FlatNode[], id: string): FlatNode[] {
  const start = flat.findIndex((f) => f.node.task.id === id);
  if (start < 0) return [];
  const rootDepth = flat[start]!.depth;
  const block = [flat[start]!];
  for (let i = start + 1; i < flat.length && flat[i]!.depth > rootDepth; i++) block.push(flat[i]!);
  return block;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function TaskTree({
  nodes,
  onDetail,
  reorderable = true,
}: {
  nodes: TaskTreeVM[];
  onDetail: (id: string, title: string) => void;
  /** 是否允许拖拽重排;详情弹窗复用时须为 false(depth-0≠容器顶层)。 */
  reorderable?: boolean;
}): React.JSX.Element {
  const [editId, setEditId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [projection, setProjection] = useState<Projection | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragStartX = useRef(0);
  /** 抓取点在被拖块内的纵向偏移:定位用**块上沿**而非光标,否则上下移动不对称 */
  const grabOffsetY = useRef(0);
  const geomRef = useRef<DragGeometry | null>(null);
  const draggedDepth = useRef(0);
  const draggedHeight = useRef(1);
  const dragActive = useRef(false);

  const flat = useMemo(() => flatten(nodes, collapsed), [nodes, collapsed]);

  // 被拖子树(含后代)的 id 集:渲染时整体隐藏(display:none),投影时从候选集排除。
  const draggedSet = useMemo(
    () => (draggedId ? new Set(subtreeBlock(flat, draggedId).map((f) => f.node.task.id)) : null),
    [draggedId, flat],
  );

  const toggleCollapse = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * 拖拽开始时冻结几何:量出"把被拖块整段抽走之后"每个候选行的位置。
   * 之后整个拖拽过程都用这份快照定位 —— 占位行会跟着落点移动,若还去读实时 DOM,
   * 位置就会随占位行反复横跳(自反馈抖动)。
   */
  const captureGeometry = (draggedRootId: string, pointerY: number): void => {
    const container = containerRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const toContent = (y: number): number => y - cRect.top + container.scrollTop;
    const block = subtreeBlock(flat, draggedRootId);
    const blockIds = new Set(block.map((b) => b.node.task.id));
    const rects = new Map<string, { top: number; bottom: number }>();
    for (const f of flat) {
      const el = rowRefs.current.get(f.node.task.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      rects.set(f.node.task.id, { top: toContent(r.top), bottom: toContent(r.bottom) });
    }
    const blockRects = block.map((b) => rects.get(b.node.task.id)).filter((r) => r !== undefined);
    if (blockRects.length === 0) return;
    const blockTop = Math.min(...blockRects.map((r) => r.top));
    const blockBottom = Math.max(...blockRects.map((r) => r.bottom));
    const span = blockBottom - blockTop + ROW_GAP;

    const tops: number[] = [];
    const bottoms: number[] = [];
    for (const f of flat) {
      if (blockIds.has(f.node.task.id)) continue;
      const r = rects.get(f.node.task.id);
      if (!r) continue;
      const top = r.top > blockTop ? r.top - span : r.top;
      tops.push(top);
      bottoms.push(top + (r.bottom - r.top));
    }
    geomRef.current = { tops, bottoms };
    // 光标到块上沿的距离(视口坐标即可,两者同一坐标系)
    const rootEl = rowRefs.current.get(draggedRootId);
    grabOffsetY.current = rootEl ? pointerY - rootEl.getBoundingClientRect().top : 0;
  };

  const project = (clientX: number, clientY: number): Projection | null => {
    const container = containerRef.current;
    const geom = geomRef.current;
    if (!container || !draggedSet || !geom) return null;
    const cands = flat.filter((f) => !draggedSet.has(f.node.task.id));
    if (cands.length === 0) return null;

    const cRect = container.getBoundingClientRect();
    // 参考点 = **被拖块的上沿**(光标 − 抓取偏移),不是光标本身:
    // 冻结几何是"抽走该块之后"的坐标,块下方的行在其中已上移一整块高度;拿光标去比中线
    // 会让"向下"只需挪几像素、"向上"要挪一整行 —— 横向缩进时极易被判成向下移动
    // (2026-08-10 用户复现)。用块上沿则起手处恰好落在原位,上下所需距离都是半行。
    const refY = clientY - grabOffsetY.current - cRect.top + container.scrollTop;

    let idx = cands.length;
    for (let i = 0; i < cands.length; i++) {
      const mid = ((geom.tops[i] ?? 0) + (geom.bottoms[i] ?? 0)) / 2;
      if (refY < mid) {
        idx = i;
        break;
      }
    }
    // 蓝线 = 占位行的**上沿**(Todoist 口径:线永远在将要落下的那一行之上)
    const indicatorTop =
      idx < cands.length ? (geom.tops[idx] ?? 0) : (geom.bottoms[cands.length - 1] ?? 0) + ROW_GAP;

    const prev = idx > 0 ? cands[idx - 1]! : null;
    const next = idx < cands.length ? cands[idx]! : null;

    // 水平位移 → 期望缩进;在 [minDepth, maxDepth] 内夹取
    const steps = Math.round((clientX - dragStartX.current) / INDENT);
    const wantDepth = draggedDepth.current + steps;
    const maxByPrev = prev ? prev.depth + 1 : 0;
    const maxByBudget = MAX_LEVEL - draggedHeight.current; // 保证子树最深叶 ≤ 5 层
    const maxDepth = Math.max(0, Math.min(maxByPrev, maxByBudget));
    // 下界固定为 0:落在"父与其子之间"时也允许选更浅的层级 —— 结果是后面那棵更深的
    // 子树被**收养**到落点任务下(见 onDrop),这是合法树形;真正非法的只有"首行就缩进"
    // 那种孤儿,而它由 maxByPrev(首行 prev 为 null → 0)天然挡住(2026-08-10 用户定案)。
    const depth = clamp(wantDepth, 0, maxDepth);

    // parentTaskId:dnd-kit 式解析(相对间隙上方的项)
    let parentTaskId: string | null;
    if (depth === 0 || !prev) {
      parentTaskId = null;
    } else if (depth === prev.depth) {
      parentTaskId = prev.parentId;
    } else if (depth > prev.depth) {
      parentTaskId = prev.node.task.id;
    } else {
      parentTaskId = null;
      for (let i = idx - 1; i >= 0; i--) {
        if (cands[i]!.depth === depth) {
          parentTaskId = cands[i]!.parentId;
          break;
        }
      }
    }

    // beforeId:仅当 next 与落点同层同父时,才插到它之前;否则追加到该父的末尾
    const beforeId =
      next && next.depth === depth && next.parentId === parentTaskId
        ? next.node.task.id
        : undefined;

    return {
      indicatorTop,
      depth,
      idx,
      parentTaskId,
      ...(beforeId !== undefined ? { beforeId } : {}),
    };
  };

  const onDrop = async (): Promise<void> => {
    const dragged = draggedId;
    const p = projection;
    const cands = draggedSet ? flat.filter((f) => !draggedSet.has(f.node.task.id)) : [];
    setDraggedId(null);
    setProjection(null);
    if (!dragged || !p) return;
    const r = await window.gtd.taskReorder({
      id: dragged,
      parentTaskId: p.parentTaskId,
      ...(p.beforeId !== undefined ? { beforeId: p.beforeId } : {}),
    });
    if ('error' in r) {
      toast(r.error);
      return;
    }
    // 落点比后一行浅 → 后一行(及其子树)收养到落点任务下。
    // 例:a / └b / c,把 c 放到 a 与 b 之间并选顶层 → a / c / └b。
    // 不收养的话 b 仍是 a 的子任务,渲染时会紧跟 a 跑到 c 前面,和所见不符。
    const next = cands[p.idx];
    if (next && next.depth > p.depth) {
      const adopt = await window.gtd.taskReorder({ id: next.node.task.id, parentTaskId: dragged });
      if ('error' in adopt) toast(adopt.error);
    }
  };

  /**
   * 渲染序列:拖拽中把被拖块**搬到落点**(占位行跟着走,并按投影缩进)——
   * 占位行钉在原处会让蓝线时而落在空档上方、时而下方,与 Todoist 不符(用户复现)。
   */
  const displayed = ((): FlatNode[] => {
    if (!draggedSet || !projection) return flat;
    const block = flat.filter((f) => draggedSet.has(f.node.task.id));
    const cands = flat.filter((f) => !draggedSet.has(f.node.task.id));
    if (block.length === 0) return flat;
    const delta = projection.depth - block[0]!.depth;
    const shifted = block.map((b) => ({ ...b, depth: b.depth + delta }));
    return [...cands.slice(0, projection.idx), ...shifted, ...cands.slice(projection.idx)];
  })();

  const list = (
    <ul className="space-y-0.5">
      {displayed.map((f) => {
        const id = f.node.task.id;
        if (editId === id) {
          return (
            <li key={id} style={{ paddingLeft: `${f.depth * INDENT + BASE_PAD}px` }}>
              <TaskCard mode="edit" inline task={f.node.task} onClose={() => setEditId(null)} />
            </li>
          );
        }
        const chevron = f.hasChildren ? (
          <button
            type="button"
            className="text-xs text-fnt hover:text-ink"
            title={f.collapsed ? '展开' : '折叠'}
            onClick={() => toggleCollapse(id)}
          >
            {f.collapsed ? '▸' : '▾'}
          </button>
        ) : null;
        const row = (
          <TaskRow
            task={f.node.task}
            depth={f.depth}
            progress={{ done: f.node.subtaskDone, total: f.node.subtaskTotal }}
            leading={chevron}
            onDetail={() => onDetail(id, f.node.task.title)}
            onEdit={() => setEditId(id)}
          />
        );
        if (!reorderable) {
          return <li key={id}>{row}</li>;
        }
        return (
          // 被拖的块此刻就渲染在落点上(半透明占位),所见即所得
          <li key={id} className={draggedSet?.has(id) === true ? 'opacity-40' : undefined}>
            <div
              ref={(el) => {
                if (el) rowRefs.current.set(id, el);
                else rowRefs.current.delete(id);
              }}
              draggable
              // 只在**可拖拽的行**上禁选:选中文本会跟 HTML5 拖拽打架。
              // 早先是整个应用根节点 select-none,代价是对话、任务标题全都复制不了
              // (2026-08-12 用户反馈)。
              className="select-none"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', id);
                dragStartX.current = e.clientX;
                draggedDepth.current = f.depth;
                // 域口径高度(计隐藏的 done 子任务,主进程 subtreeHeight)→ 预算与校验一致
                draggedHeight.current = f.node.height;
                // 量几何必须赶在占位行开始移动之前(此刻 DOM 还是原始顺序)
                captureGeometry(id, e.clientY);
                dragActive.current = true;
                // Chromium:dragstart 同一任务内改动拖拽源的可见性会立刻取消拖拽
                // (React setState 在本事件任务内 flush,表现为完全拖不动)。
                // 延迟一个宏任务:拖拽图像已在 dragstart 时快照,会话建立后再重排安全。
                window.setTimeout(() => {
                  if (dragActive.current) setDraggedId(id);
                }, 0);
              }}
              onDragEnd={() => {
                dragActive.current = false;
                setDraggedId(null);
                setProjection(null);
              }}
            >
              {row}
            </div>
          </li>
        );
      })}
    </ul>
  );

  if (!reorderable) return list;

  return (
    <div
      ref={containerRef}
      className="relative"
      onDragOver={(e) => {
        if (!draggedId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setProjection(project(e.clientX, e.clientY));
      }}
      onDrop={(e) => {
        e.preventDefault();
        void onDrop();
      }}
    >
      {list}
      {projection && (
        <div
          className="pointer-events-none absolute right-2 z-10 h-0.5 rounded bg-acc"
          style={{
            top: projection.indicatorTop - 1,
            left: projection.depth * INDENT + BASE_PAD + ROW_LEAD,
          }}
        >
          <span className="absolute -top-1 -left-1 h-2 w-2 rounded-full bg-acc" />
        </div>
      )}
    </div>
  );
}
