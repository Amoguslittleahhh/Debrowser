// Draw the app icon: build/icon.png (1024 px, which electron-builder turns
// into the macOS .icns and the Linux sizes) and build/icon.ico (Windows, with
// its small sizes drawn for their size rather than scaled down).
//
//   node_modules/.bin/electron tools/make-icon.js
//
// The mark is the one on the new tab page: a frame - one tab - with a dot in
// its corner, the one awake. On the icon it sits on a dark tile, the frame in
// cream and the dot in apricot. Below 64 px the frame gets heavier and the dot
// bigger, or a 16 px taskbar icon is a smudge with a speck in it.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build');
const TILE = '#16171A';
const FRAME = '#F4F1EA';
const DOT = '#F2B27A';

/** The icon as SVG at `size` px. */
function svg(size, windows = false) {
  const small = size <= 48;
  // Tile inset, its corner, and the mark's weight. The macOS grid leaves ~10%
  // round a 1024 icon; Windows draws taskbar and desktop icons edge to edge,
  // and the same margin there read as a noticeably smaller icon than its
  // neighbours, so every Windows size uses nearly all of its pixels.
  const full = small || windows;
  const inset = full ? size * 0.03 : size * 0.098;
  const tile = size - inset * 2;
  const radius = tile * (small ? 0.2 : 0.225);
  const stroke = small ? 8 : 5;
  const dot = small ? 8.5 : 6.5;
  const scale = (tile * (small ? 0.82 : windows ? 0.76 : 0.66)) / 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${radius}" fill="${TILE}"/>
  <g transform="translate(${size / 2} ${size / 2}) scale(${scale}) translate(-32 -32)">
    <rect x="10" y="10" width="44" height="44" rx="13" fill="none" stroke="${FRAME}" stroke-width="${stroke}"/>
    <circle cx="26" cy="26" r="${dot}" fill="${DOT}"/>
  </g>
</svg>`;
}

async function render(win, size, windows = false) {
  const html = `<!doctype html><html style="background:transparent;overflow:hidden"><body style="margin:0;background:transparent;overflow:hidden">${svg(size, windows).replace('<svg ', '<svg style="display:block" ')}</body></html>`;
  win.setContentSize(size, size);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 120));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return image.resize({ width: size, height: size }).toPNG();
}

/** An .ico holding PNG images, which every Windows since Vista reads. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, transparent: true, frame: false, useContentSize: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  });
  fs.writeFileSync(path.join(OUT, 'icon.png'), await render(win, 1024));
  fs.writeFileSync(path.join(OUT, 'icon.svg'), svg(1024));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes) images.push({ size, png: await render(win, size, true) });
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(images));
  console.log(`wrote build/icon.png, build/icon.svg, build/icon.ico (${sizes.join(', ')})`);
  app.exit(0);
});
