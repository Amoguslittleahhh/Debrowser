// Draw the app icon: build/icon.png (1024 px, which electron-builder turns
// into the macOS .icns and the Linux sizes) and build/icon.ico (Windows, with
// its small sizes drawn for their size rather than scaled down). And the
// private window's own, build/icon-private.{png,svg,ico}.
//
// The private icon is the same frame on a violet-black tile, and the dot is a
// ring: the tab with nothing kept in it. Violet is the private window's colour
// everywhere else (--private in theme.css), so the taskbar says which window
// is which before either is looked at.
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
const NORMAL = { tile: '#16171A', frame: '#F4F1EA', dot: '#F2B27A', ring: false };
const PRIVATE = { tile: '#2C2050', frame: '#F4F1EA', dot: '#B9A0FF', ring: true };

/** The icon as SVG at `size` px. */
function svg(size, windows = false, look = NORMAL) {
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
  // A ring keeps the dot's outer size; its stroke is what stays legible at 16 px.
  const mark = look.ring
    ? `<circle cx="26" cy="26" r="${dot - (small ? 2.4 : 1.7)}" fill="none" stroke="${look.dot}" stroke-width="${small ? 4.8 : 3.4}"/>`
    : `<circle cx="26" cy="26" r="${dot}" fill="${look.dot}"/>`;
  const scale = (tile * (small ? 0.82 : windows ? 0.76 : 0.66)) / 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${radius}" fill="${look.tile}"/>
  <g transform="translate(${size / 2} ${size / 2}) scale(${scale}) translate(-32 -32)">
    <rect x="10" y="10" width="44" height="44" rx="13" fill="none" stroke="${look.frame}" stroke-width="${stroke}"/>
    ${mark}
  </g>
</svg>`;
}

async function render(win, size, windows = false, look = NORMAL) {
  const html = `<!doctype html><html style="background:transparent;overflow:hidden"><body style="margin:0;background:transparent;overflow:hidden">${svg(size, windows, look).replace('<svg ', '<svg style="display:block" ')}</body></html>`;
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
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  for (const [name, look] of [['icon', NORMAL], ['icon-private', PRIVATE]]) {
    fs.writeFileSync(path.join(OUT, `${name}.png`), await render(win, 1024, false, look));
    fs.writeFileSync(path.join(OUT, `${name}.svg`), svg(1024, false, look));
    const images = [];
    for (const size of sizes) images.push({ size, png: await render(win, size, true, look) });
    fs.writeFileSync(path.join(OUT, `${name}.ico`), ico(images));
    console.log(`wrote build/${name}.png, .svg, .ico (${sizes.join(', ')})`);
  }
  app.exit(0);
});
