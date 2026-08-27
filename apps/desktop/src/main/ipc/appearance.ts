import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, nativeTheme, shell } from 'electron';
import type { SettingsStore } from '@gtd/storage-sqlite';
import type { AppearanceVM } from '../../shared/appearance';
import { DEFAULT_APPEARANCE, THEMES, sanitizeAppearance } from '../../shared/appearance';

/**
 * 外观设置(M11-B/D-38)+ 错误日志面。
 *
 * 外观存 settings 表(key='appearance',与护栏/日历偏好同一张表);存取两侧都过
 * sanitizeAppearance —— 手改坏的值不该让窗口起不来,非法 token/颜色静默丢弃。
 *
 * 错误日志:主进程未捕获异常 + 渲染层 ErrorBoundary 上报,统一追加到
 * <userData>/logs/errors.log(JSONL)。**绝不因为记日志本身失败而崩**。
 */

const logsDir = (): string => join(app.getPath('userData'), 'logs');

export function logError(source: string, message: string): void {
  try {
    mkdirSync(logsDir(), { recursive: true });
    appendFileSync(
      join(logsDir(), 'errors.log'),
      `${JSON.stringify({ at: new Date().toISOString(), source, message })}\n`,
    );
  } catch {
    /* 记日志失败只能认 —— 不能让上报路径反过来把应用炸了 */
  }
}

/** 主进程全局异常兜底:落盘不退出(个人应用,带着伤继续跑比闪退强)。 */
export function installErrorLogging(): void {
  process.on('uncaughtException', (e) => {
    logError('main:uncaughtException', `${e.message}\n${e.stack ?? ''}`);
  });
  process.on('unhandledRejection', (reason) => {
    logError('main:unhandledRejection', String(reason));
  });
}

/**
 * 原生部分随主题:macOS 标题栏画的是**系统外观**,不设 themeSource 的话
 * 「浅色主题 + 系统深色模式」会顶着一条黑标题栏(2026-08-27 用户实测截图)。
 * 窗口底色同步成主区底色,resize 露底/启动首帧也不会闪错色。
 */
export function applyNativeAppearance(v: AppearanceVM): void {
  const theme = THEMES.find((t) => t.id === v.theme)!;
  nativeTheme.themeSource = theme.dark ? 'dark' : 'light';
  const o = v.overrides['--t-app'];
  const bg = o !== undefined && /^#[0-9a-fA-F]{6}$/.test(o) ? o : theme.appBg;
  for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(bg);
}

export function currentAppearance(settings: SettingsStore): AppearanceVM {
  const raw = settings.get('appearance');
  return raw === null ? DEFAULT_APPEARANCE : sanitizeAppearance(raw);
}

export function registerAppearanceIpc(settings: SettingsStore): void {
  ipcMain.handle('app:appearance.get', () => currentAppearance(settings));
  ipcMain.handle('app:appearance.set', (_e, v: unknown) => {
    const clean = sanitizeAppearance(v);
    settings.set('appearance', clean);
    applyNativeAppearance(clean);
  });
  ipcMain.handle('app:logs.open', async () => {
    mkdirSync(logsDir(), { recursive: true });
    await shell.openPath(logsDir());
  });
  ipcMain.handle('app:logs.error', (_e, p: { source: string; message: string }) => {
    logError(String(p.source).slice(0, 100), String(p.message).slice(0, 8000));
  });
}
