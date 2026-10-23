// Renders src/renderer/logo.svg into the window/installer icons (assets/icon.png and assets/icon.ico).
// Run with: npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'assets');
const svg = fs.readFileSync(path.join(root, 'src', 'renderer', 'logo.svg'));
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

// ICO container holding PNG-compressed images (supported since Windows Vista).
function toIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = header.length + images.length * 16;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });

  const html = `<body style="margin:0;background:transparent"><img width="512" height="512" src="data:image/svg+xml;base64,${svg.toString('base64')}"></body>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // A static page stops painting once loaded, so request a fresh frame and take that one.
  const painted = new Promise((resolve) => win.webContents.once('paint', (_event, _dirty, image) => resolve(image)));
  win.webContents.invalidate();

  const image = (await painted).resize({ width: 512, height: 512, quality: 'best' });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'icon.png'), image.toPNG());
  const icoImages = ICO_SIZES.map((size) => ({ size, png: image.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  fs.writeFileSync(path.join(outDir, 'icon.ico'), toIco(icoImages));

  console.log(`Ícones gerados em ${outDir}`);
  app.quit();
});
