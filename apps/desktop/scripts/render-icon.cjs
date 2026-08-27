// SVG → 透明 PNG(Electron 离屏渲染)。用法:electron render-icon.cjs <svg> <out.png> <size>
// 为什么不用 qlmanage/ImageMagick:前者把透明边距垫成白底,后者不支持渐变/描边(均实测)。
// 为什么用临时 HTML 而不是 data: URL:data:text/html 里嵌 data:image/svg+xml 会双重
// 编码,SVG 里的 # 颜色被当 URL fragment 截断,页面空白(实测)。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const [svgPath, outPath, sizeArg] = process.argv.slice(2);
const size = Number(sizeArg ?? 1024);
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    width: size,
    height: size,
    webPreferences: { offscreen: true },
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-render-'));
  const html = path.join(tmp, 'render.html');
  fs.copyFileSync(svgPath, path.join(tmp, 'icon.svg'));
  fs.writeFileSync(
    html,
    `<!doctype html><body style="margin:0;background:transparent"><img style="display:block" width="${size}" height="${size}" src="./icon.svg"></body>`,
  );
  await win.loadFile(html);
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(outPath, img.toPNG());
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});
