import { app, BrowserWindow, ipcMain } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
// spike 仅保留 --spike-test 打包冒烟通道(M1);正式会话在 agent/sessionManager.ts
import { runSpikeTurn, type SpikeImage } from './agent/spike';
import { initStore, settingsStore } from './db';
import { systemClock } from './clock';
import { watchDbForExternalWrites } from './dbWatch';
import { broadcastChanged, createGtdViews, registerGtdIpc } from './ipc/gtd';
import { inspectAppCalendar, registerGoogleIpc } from './ipc/google';
import { registerAgentIpc } from './ipc/agent';
import {
  applyNativeAppearance,
  currentAppearance,
  installErrorLogging,
  registerAppearanceIpc,
} from './ipc/appearance';
import { runAgentSmoke } from './agent/smoke';

// dev/prod 数据完全隔离(docs/DESIGN.md §9.2):必须在 app ready 之前设置。
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

// dev 验证通道:--spike-test(M1)、--dump=views、--screenshot=<path>(M4)
const spikeArg = process.argv.find((a) => a.startsWith('--spike-test='));
// M8 冒烟:验证 skill 真被子进程加载、只读工具面真注册、一次真实往返
const agentSmokeArg = process.argv.find((a) => a.startsWith('--agent-smoke'));
const dumpArg = process.argv.find((a) => a.startsWith('--dump='));
const screenshotArg = process.argv.find((a) => a.startsWith('--screenshot='));
// 截图前依次点这些选择器(可重复传;拍需要先导航再展开的界面)
const screenshotClickArgs = process.argv.filter((a) => a.startsWith('--screenshot-click='));
// 点开之后往当前焦点输入框敲一段文字(命令面板/表单类界面)
const screenshotTypeArg = process.argv.find((a) => a.startsWith('--screenshot-type='));
// 敲完字按回车提交(agent composer / 各种表单)
const screenshotSubmit = process.argv.includes('--screenshot-submit');
// 拍摄前额外等待,用于等异步界面(agent 一次往返十几秒)
const screenshotDelayArg = process.argv.find((a) => a.startsWith('--screenshot-delay='));
// 在渲染层求值并打印结果(dev 专用)。用来验那些**没法单测的 DOM 行为** ——
// 比如"选中一段渲染后的 Markdown、复制出来的是不是原文"。
const screenshotEvalArg = process.argv.find((a) => a.startsWith('--screenshot-eval='));
// 滚动某个容器再拍(长面板的下半截):--screenshot-scroll=<选择器>|<top px>
const screenshotScrollArg = process.argv.find((a) => a.startsWith('--screenshot-scroll='));
// 等待之后再点(用来点异步才出现的东西,比如审批弹窗上的按钮)
const screenshotThenClickArgs = process.argv.filter((a) =>
  a.startsWith('--screenshot-then-click='),
);

function createWindow(): BrowserWindow {
  const widthArg = process.argv.find((a) => a.startsWith('--win-width='));
  const win = new BrowserWindow({
    width: widthArg ? Number(widthArg.slice('--win-width='.length)) : 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Claudoist',
    // 原生标题栏只有系统深/浅两档,吃不了主题色(2026-08-27 用户圈图)——
    // 藏掉它,三栏内容画到窗口顶端,红绿灯浮在侧栏左上,顶部 36px 是拖拽区(App.tsx)
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  userData: app.getPath('userData'),
  packaged: app.isPackaged,
}));

async function runSpikeTest(arg: string): Promise<void> {
  const text = arg.slice('--spike-test='.length) || 'Reply with exactly: SPIKE_OK';
  const imageArg = process.argv.find((a) => a.startsWith('--spike-image='));
  const images: SpikeImage[] = [];
  if (imageArg) {
    const p = imageArg.slice('--spike-image='.length);
    const mediaType = extname(p) === '.jpg' || extname(p) === '.jpeg' ? 'image/jpeg' : 'image/png';
    images.push({ data: readFileSync(p).toString('base64'), mediaType });
  }
  let failed = false;
  await runSpikeTurn(text, images, (msg) => {
    if (msg.type === 'stream_event') {
      const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } })
        .event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        process.stdout.write(ev.delta.text);
      }
    } else if (msg.type === 'result') {
      const r = msg as unknown as Record<string, unknown>;
      process.stdout.write(
        `\n[SPIKE_RESULT] ${JSON.stringify({
          subtype: r['subtype'],
          is_error: r['is_error'],
          session_id: r['session_id'],
          total_cost_usd: r['total_cost_usd'],
          usage: r['usage'],
          duration_ms: r['duration_ms'],
        })}\n`,
      );
      failed = r['is_error'] === true;
    } else if (msg.type === 'spike_error') {
      process.stdout.write(`\n[SPIKE_ERROR] ${msg.message}\n`);
      failed = true;
    }
  });
  app.exit(failed ? 1 : 0);
}

const gotLock = app.requestSingleInstanceLock();
if (agentSmokeArg) {
  void app.whenReady().then(() => runAgentSmoke(initStore(), systemClock, agentSmokeArg));
} else if (spikeArg) {
  void app.whenReady().then(() => runSpikeTest(spikeArg));
} else if (dumpArg === '--dump=google') {
  // 无头复查专用日历的真实内容:本地指针无法证明 Google 侧已清干净
  void app.whenReady().then(async () => {
    initStore();
    try {
      process.stdout.write(`[GOOGLE_DUMP] ${JSON.stringify(await inspectAppCalendar())}\n`);
      app.exit(0);
    } catch (e) {
      process.stdout.write(`[GOOGLE_DUMP] ${JSON.stringify({ error: String(e) })}\n`);
      app.exit(1);
    }
  });
} else if (dumpArg) {
  // 无头输出视图 JSON(与 IPC handler 同一代码路径),供自动验收对拍
  void app.whenReady().then(() => {
    const views = createGtdViews(initStore(), systemClock);
    const projects = views.projectsList();
    process.stdout.write(
      `[VIEWS_DUMP] ${JSON.stringify({
        inbox: views.inbox(),
        projects,
        projectViews: projects.map((p) => views.projectView(p.id)),
        today: views.today(),
        calendar: views.calendarRange(systemClock.today(), 3),
        labels: views.labels(),
        bucketCounts: views.bucketCounts(),
      })}\n`,
    );
    app.exit(0);
  });
} else if (!gotLock) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    installErrorLogging();
    const store = initStore();
    registerAppearanceIpc(settingsStore());
    const views = createGtdViews(store, systemClock);
    registerGtdIpc(views, store, {
      clock: systemClock,
      idGen: { next: () => crypto.randomUUID() },
    });
    registerGoogleIpc(
      store,
      { clock: systemClock, idGen: { next: () => crypto.randomUUID() } },
      () => broadcastChanged('agent'),
    );
    registerAgentIpc(store, systemClock);
    watchDbForExternalWrites(() => broadcastChanged('agent'));
    const win = createWindow();
    applyNativeAppearance(currentAppearance(settingsStore()));
    // dev 的 dock 图标(打包版由 bundle icns 提供;isPackaged 时别覆盖,免得干扰角标)
    if (!app.isPackaged && process.platform === 'darwin') {
      app.dock?.setIcon(join(__dirname, '../../build/icon.png'));
    }
    if (screenshotArg) {
      const path = screenshotArg.slice('--screenshot='.length);
      win.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          void (async () => {
            for (const arg of screenshotClickArgs) {
              const sel = arg.slice('--screenshot-click='.length);
              // 先 focus 再 click:`click()` 不会让 textarea 成为 activeElement,
              // 而后面的 --screenshot-type 正是往 activeElement 里敲字
              const hit: boolean = await win.webContents.executeJavaScript(`(() => {
                const el = document.querySelector(${JSON.stringify(sel)});
                if (!el) return false;
                el.focus?.();
                el.click();
                return true;
              })()`);
              if (!hit) process.stdout.write(`[SCREENSHOT] 选择器无匹配:${sel}\n`);
              await new Promise((r) => setTimeout(r, 600));
            }
            if (screenshotTypeArg) {
              const text = screenshotTypeArg.slice('--screenshot-type='.length);
              // 受控组件必须走原生 setter + input 事件,直接赋值 React 收不到
              await win.webContents.executeJavaScript(`(() => {
                const el = document.activeElement;
                if (!el || !('value' in el)) return false;
                const proto = el instanceof HTMLTextAreaElement
                  ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              })()`);
              await new Promise((r) => setTimeout(r, 900));
            }
            // 敲回车提交(agent composer 就是靠 Enter 发送);React 的 onKeyDown 收原生事件
            if (screenshotSubmit) {
              await win.webContents.executeJavaScript(`(() => {
                const el = document.activeElement;
                if (!el) return false;
                el.dispatchEvent(new KeyboardEvent('keydown',
                  { key: 'Enter', bubbles: true, cancelable: true }));
                return true;
              })()`);
            }
            // agent 往返要十几秒 —— 要拍审批弹窗之类的异步界面就得等
            if (screenshotDelayArg) {
              const ms = Number(screenshotDelayArg.slice('--screenshot-delay='.length));
              await new Promise((r) => setTimeout(r, Number.isFinite(ms) ? ms : 0));
            }
            for (const arg of screenshotThenClickArgs) {
              const sel = arg.slice('--screenshot-then-click='.length);
              const hit: boolean = await win.webContents.executeJavaScript(`(() => {
                const el = document.querySelector(${JSON.stringify(sel)});
                if (!el) return false;
                el.click();
                return true;
              })()`);
              if (!hit) process.stdout.write(`[SCREENSHOT] 延后点击无匹配:${sel}\n`);
              await new Promise((r) => setTimeout(r, 3000));
            }
            if (screenshotScrollArg) {
              const [sel, top] = screenshotScrollArg
                .slice('--screenshot-scroll='.length)
                .split('|');
              await win.webContents.executeJavaScript(`(() => {
                const el = document.querySelector(${JSON.stringify(sel ?? '')});
                if (!el) return false;
                el.scrollTop = ${JSON.stringify(Number(top ?? 0))};
                return true;
              })()`);
              await new Promise((r) => setTimeout(r, 400));
            }
            if (screenshotEvalArg) {
              const js = screenshotEvalArg.slice('--screenshot-eval='.length);
              try {
                const out: unknown = await win.webContents.executeJavaScript(js);
                process.stdout.write(`[EVAL] ${JSON.stringify(out)}\n`);
              } catch (e) {
                process.stdout.write(`[EVAL_ERROR] ${String(e)}\n`);
              }
            }
            const img = await win.webContents.capturePage();
            writeFileSync(path, img.toPNG());
            process.stdout.write(`[SCREENSHOT] ${path}\n`);
            app.exit(0);
          })();
        }, 1800);
      });
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
