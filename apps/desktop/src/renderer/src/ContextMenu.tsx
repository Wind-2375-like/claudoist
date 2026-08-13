import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 右键菜单。
 *
 * ## 为什么必须用 portal
 *
 * 2026-08-12 用户反馈:「右键菜单被中间栏遮挡」。
 *
 * 原因不是层叠顺序,是**裁剪**:菜单原来是 `position: absolute` 的兄弟节点,而它的祖先
 * ——左栏 / 中间栏都是 `overflow-y-auto`。**只要祖先的 overflow 不是 visible,
 * absolute 定位的后代就会被那个盒子裁掉**,菜单宽度一旦超出栏宽,超出的部分直接不见。
 * `z-50` 对此毫无作用(z-index 管的是谁盖谁,不管裁剪),所以当初加 z-index 没能修好。
 *
 * 唯一干净的解法是把菜单**渲染到 `document.body`**(portal)并用 `position: fixed` +
 * 视口坐标定位 —— 这样它不在任何 overflow 盒子里,谁也裁不到它。
 *
 * ## 顺带解决的两件事
 *
 * - **贴边翻转**:菜单在窗口右/下边缘会溢出屏幕。挂载后量一次真实尺寸,越界就翻到
 *   反方向(往左/往上展开)。所以位置要在 `useLayoutEffect` 里定,不能在渲染时拍。
 * - **Esc 关闭**、点遮罩关闭、滚动时关闭(fixed 定位不跟随滚动,不关就会浮在错误的位置)。
 */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  /** 视口坐标(直接用事件的 clientX/clientY) */
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    // 贴右边/下边时往反方向展开,而不是被切掉
    const left = x + width + pad > window.innerWidth ? Math.max(pad, x - width) : x;
    const top = y + height + pad > window.innerHeight ? Math.max(pad, y - height) : y;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    // fixed 定位不跟着容器滚动 —— 滚了就关掉,免得菜单浮在一个已经不相关的位置上
    const onScroll = (): void => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  return createPortal(
    <>
      {/* 遮罩吃掉外部点击。用 mousedown 而不是 click:右键菜单常见的用法是
          按下左键就该关,等到 click 才关会让菜单在按下的瞬间还挡着下面的东西 */}
      <div className="fixed inset-0 z-[70]" onMouseDown={onClose} onContextMenu={onClose} />
      <div
        ref={ref}
        className="fixed z-[71] min-w-32 rounded-lg border border-neutral-200 bg-white py-1 shadow-xl"
        style={{ left: pos.left, top: pos.top }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/** 菜单项。`danger` 用于破坏性操作(删除),视觉上必须与其它项区分开。 */
export function ContextMenuItem({
  onClick,
  danger = false,
  disabled = false,
  title,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  /** 不可用时**灰掉并给出理由**,而不是让菜单项消失 —— 消失了用户只会以为功能坏了 */
  disabled?: boolean;
  title?: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      className={`block w-full px-3 py-1.5 text-left text-sm whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? 'text-red-600 hover:bg-red-50' : 'hover:bg-neutral-50'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
