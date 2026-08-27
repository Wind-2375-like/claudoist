import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * 渲染层错误边界。
 *
 * 由来:2026-08-11 开发工具参考页时,preload 少暴露了一个方法,组件里一句
 * `window.agent.toolManual()` 抛错 → 整棵树卸载 → **整窗白屏,没有任何信息**。
 * 白屏是最糟的失败形态:看不出是哪崩的,也看不出还能不能用。
 *
 * 有了边界之后,坏掉的只是那一块,其余界面照常工作,而且错误直接摆在脸上。
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] 组件崩溃', this.props.label ?? '', error, info.componentStack);
    // M11-B:落主进程错误日志(<userData>/logs/errors.log),设置页有入口
    window.appearance?.logError(
      `renderer:${this.props.label ?? 'ErrorBoundary'}`,
      `${error.message}\n${error.stack ?? ''}\n${info.componentStack ?? ''}`,
    );
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="m-3 rounded-lg border border-danger bg-danger-soft p-3 text-xs text-danger-ink">
        <p className="font-medium">{this.props.label ?? '这一块'}出错了 —— 其余功能不受影响。</p>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-danger-ink">
          {error.message}
        </pre>
        <button
          type="button"
          className="mt-2 rounded border border-danger px-2 py-0.5 hover:bg-danger-soft"
          onClick={() => this.setState({ error: null })}
        >
          重试
        </button>
      </div>
    );
  }
}
