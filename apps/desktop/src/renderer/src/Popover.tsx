import { useEffect, useRef } from 'react';

/**
 * 面板内的弹出层(底栏的模型 / 权限 / 命令菜单,顶栏的历史与书签)。
 *
 * 不走 portal:它们都落在 agent 面板自己的盒子里,祖先没有裁剪,`absolute` 即可;
 * 位置由调用方用 className 给(`bottom-full` 往上开、`top-full` 往下开)。
 * 点外面或按 Esc 关闭。打开它的那颗按钮要带 `data-popover-toggle` —— 否则按下按钮的
 * mousedown 先把弹层关掉,紧接着的 click 又把它打开,看起来就是"点了没反应"。
 */
export function Popover({
  open,
  onClose,
  className = '',
  children,
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Element | null;
      if (t !== null && (ref.current?.contains(t) === true || t.closest('[data-popover-toggle]'))) {
        return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      className={`absolute z-30 overflow-hidden rounded-lg border border-line bg-raised text-ink shadow-xl ${className}`}
    >
      {children}
    </div>
  );
}

/** 顶栏 / 底栏的图标按钮:统一尺寸与 hover,`toggle` 时带上 data-popover-toggle */
export function IconButton({
  title,
  onClick,
  toggle = false,
  active = false,
  disabled = false,
  className = '',
  children,
}: {
  title: string;
  onClick: () => void;
  toggle?: boolean;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      {...(toggle ? { 'data-popover-toggle': '' } : {})}
      className={`flex h-7 min-w-6 items-center justify-center gap-1 rounded-md px-1 text-mut hover:bg-hov hover:text-ink disabled:opacity-30 ${
        active ? 'bg-hov text-ink' : ''
      } ${className}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
