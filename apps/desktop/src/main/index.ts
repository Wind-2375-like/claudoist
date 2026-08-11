import { app, BrowserWindow, ipcMain } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { runSpikeTurn, spikeInterrupt, type SpikeImage } from './agent/spike';
import { initStore } from './db';
import { systemClock } from './clock';
import { watchDbForExternalWrites } from './dbWatch';
import { broadcastChanged, createGtdViews, registerGtdIpc } from './ipc/gtd';
import { registerGoogleIpc } from './ipc/google';

// dev/prod 数据完全隔离(docs/DESIGN.md §9.2):必须在 app ready 之前设置。
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

// dev 验证通道:--spike-test(M1)、--dump=views、--screenshot=<path>(M4)
const spikeArg = process.argv.find((a) => a.startsWith('--spike-test='));
const dumpArg = process.argv.find((a) => a.startsWith('--dump='));
const screenshotArg = process.argv.find((a) => a.startsWith('--screenshot='));
// 截图前先点一个选择器(拍弹窗/面板用,如 Focus、周回顾向导、⌘K)
const screenshotClickArg = process.argv.find((a) => a.startsWith('--screenshot-click='));

function createWindow(): BrowserWindow {
  const widthArg = process.argv.find((a) => a.startsWith('--win-width='));
  const win = new BrowserWindow({
    width: widthArg ? Number(widthArg.slice('--win-width='.length)) : 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Claudoist',
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

ipcMain.handle('agent:send', (event, payload: { text: string; images: SpikeImage[] }) => {
  const contents = event.sender;
  void runSpikeTurn(payload.text, payload.images ?? [], (msg) => {
    if (!contents.isDestroyed()) contents.send('agent:stream', msg);
  });
});

ipcMain.handle('agent:interrupt', () => spikeInterrupt());

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
if (spikeArg) {
  void app.whenReady().then(() => runSpikeTest(spikeArg));
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
        contexts: views.contexts(),
        bucketCounts: views.bucketCounts(),
      })}\n`,
    );
    app.exit(0);
  });
} else if (!gotLock) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    const store = initStore();
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
    watchDbForExternalWrites(() => broadcastChanged('agent'));
    const win = createWindow();
    if (screenshotArg) {
      const path = screenshotArg.slice('--screenshot='.length);
      win.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          void (async () => {
            if (screenshotClickArg) {
              const sel = screenshotClickArg.slice('--screenshot-click='.length);
              const hit: boolean = await win.webContents.executeJavaScript(
                `!!document.querySelector(${JSON.stringify(sel)})?.click() || !!document.querySelector(${JSON.stringify(sel)})`,
              );
              if (!hit) process.stdout.write(`[SCREENSHOT] 选择器无匹配:${sel}\n`);
              await new Promise((r) => setTimeout(r, 600));
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
