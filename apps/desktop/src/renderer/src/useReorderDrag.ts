import { useCallback, useState } from 'react';

/**
 * 列表内拖拽重排的通用手势(D-39/D-40:项目侧栏 / My Projects / Today 共用一份)。
 *
 * 为什么抽出来:三处都要"拖起某行 → 悬停时在落点画线 → 松手落到某行之前",各写一遍
 * 迟早在指示线位置、半高判定、无变化判定上分叉。这里只管手势与落点计算,**落库交给
 * 调用方的 onReorder**(仍然是 domain usecase 说了算)。
 *
 * 落点语义与 domain 的 reorder* 一致:`beforeId` = 插到该 id 之前;`undefined` = 末尾。
 *
 * **关键:落点换算与"这一下会不会真的改变顺序"只有一份实现(`resolve`)**,hint 与 onDrop
 * 共用 —— 否则会出现"画了插入线、松手却什么都没发生"(拖 A 到紧邻下一行的上半区就是原位)。
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
  /** 该行当前要画哪条落点线;null = 不画(落在这儿不会改变顺序) */
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

  /**
   * 悬停在 `overId` 的上/下半区 → 落点。返回 null = 这一下不会改变顺序(不画线、不落库)。
   * 无变化的三种形态:落到自己头上、落到自己原来的位置、把自己插到"紧跟着自己的那一行"之前。
   */
  const resolve = useCallback(
    (overId: string, after: boolean): { beforeId: string | undefined } | null => {
      if (dragId === null) return null;
      const from = ids.indexOf(dragId);
      if (from < 0) return { beforeId: undefined }; // 拖的不是本列表成员(如 Today 的定时行)
      const at = ids.indexOf(overId);
      // 落在不属于本列表的行上 → 钳到末尾(调用方可用它做兜底落点)
      const beforeId = at < 0 ? undefined : after ? ids[at + 1] : overId;
      if (beforeId === dragId) return null;
      const to = beforeId === undefined ? ids.length : ids.indexOf(beforeId);
      if (to === from || to === from + 1) return null; // 原位
      return { beforeId };
    },
    [dragId, ids],
  );

  const rowProps = useCallback(
    (id: string, droppable = true): ReorderRowProps => ({
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
        const target = resolve(id, e.clientY > r.top + r.height / 2);
        const moving = dragId;
        reset();
        if (target !== null) onReorder(moving, target.beforeId);
      },
      onDragEnd: reset,
    }),
    [dragId, kind, onReorder, reset, resolve],
  );

  const hint = useCallback(
    (id: string): 'before' | 'after' | null => {
      if (over === null || over.id !== id) return null;
      return resolve(id, over.after) === null ? null : over.after ? 'after' : 'before';
    },
    [over, resolve],
  );

  return { dragId, reset, hint, rowProps };
}
