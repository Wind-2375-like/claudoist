import { useCallback, useState } from 'react';

/**
 * 列表内拖拽重排的通用手势(D-39:项目侧栏 / My Projects / Today 共用一份)。
 *
 * 为什么抽出来:三处都要"拖起某行 → 悬停时在落点画线 → 松手落到某行之前",各写一遍
 * 迟早在指示线位置、半高判定、清理时机上分叉。这里只管手势与落点计算,**落库交给
 * 调用方的 onReorder**(仍然是 domain usecase 说了算)。
 *
 * 落点语义与 domain 的 reorder* 一致:`beforeId` = 插到该 id 之前;`undefined` = 末尾。
 * 判定用行的上下半区:悬在上半 → 落到它前面;下半 → 落到它后面(= 下一行之前)。
 *
 * `kind` 用来给 dataTransfer 打类型标记 —— Today 同时还有"拖到底部推迟"的投放区,
 * 两者必须能区分,否则从别处拖来的东西会被当成重排。
 */
/** 摊到每一行的 DOM props(调用方 {...drag} 展开即可) */
export interface ReorderRowProps {
  draggable: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

export interface ReorderDrag {
  /** 正在被拖的行 id(拖动中把它画淡) */
  dragId: string | null;
  /** 手势收尾(拖拽结束/取消);调用方要在自己的 onDragEnd 里叠加清理时用得上 */
  reset: () => void;
  /** 该行当前要画哪条落点线;null = 不画 */
  hint: (id: string) => 'before' | 'after' | null;
  /** droppable=false:只当拖源不当落点(Today 的定时行 —— 能拖去推迟,但不接受插入) */
  rowProps: (id: string, droppable?: boolean) => ReorderRowProps;
}

export function useReorderDrag(
  kind: string,
  /** 当前显示序的 id 列表 —— 落点换算成 beforeId 要靠它 */
  ids: string[],
  onReorder: (id: string, beforeId: string | undefined) => void,
): ReorderDrag {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);

  const reset = useCallback(() => {
    setDragId(null);
    setOver(null);
  }, []);

  const rowProps = useCallback(
    (id: string, droppable = true) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent): void => {
        e.dataTransfer.effectAllowed = 'move';
        // 两条数据:kind 标记给投放区辨认,text/plain 给外部/兜底
        e.dataTransfer.setData(`application/x-claudoist-${kind}`, id);
        e.dataTransfer.setData('text/plain', id);
        setDragId(id);
      },
      onDragOver: (e: React.DragEvent): void => {
        if (dragId === null || !droppable) return; // 非本列表发起 / 该行不收落点
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect();
        setOver({ id, after: e.clientY > r.top + r.height / 2 });
      },
      onDragLeave: (): void => {
        setOver((prev) => (prev?.id === id ? null : prev));
      },
      onDrop: (e: React.DragEvent): void => {
        if (dragId === null || !droppable) return;
        e.preventDefault();
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        const moving = dragId;
        reset();
        if (moving === id && !after) return; // 拖回自己上方 = 原地
        // 落到 id 之后 = 落到"下一行"之前;下一行不存在 → 末尾(undefined)
        const at = ids.indexOf(id);
        const beforeId = after ? ids[at + 1] : id;
        if (beforeId === moving) return; // 落在自己原位,零动作
        onReorder(moving, beforeId);
      },
      onDragEnd: reset,
    }),
    [dragId, ids, onReorder, reset, kind],
  );

  const hint = useCallback(
    (id: string): 'before' | 'after' | null => {
      if (over === null || over.id !== id || dragId === null) return null;
      // 落点就是被拖行自己的原位 → 不画线(避免"拖了个寂寞"还显示可落)
      const at = ids.indexOf(id);
      if (over.after && ids[at + 1] === dragId) return null;
      if (!over.after && id === dragId) return null;
      if (over.after && id === dragId) return null;
      return over.after ? 'after' : 'before';
    },
    [over, dragId, ids],
  );

  return { dragId, reset, hint, rowProps };
}
