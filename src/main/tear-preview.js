'use strict';

/**
 * A picture of the tab being dragged out of the strip, following the pointer.
 *
 * The strip is a view inside its window, so the tab it draws cannot leave it:
 * pulled down past the toolbar or out over the desktop, it would vanish while
 * the drag went on. This is a small window of its own instead - the tab's
 * title over the page as it looked, at a fraction of its size - which goes
 * wherever the pointer does. It never takes the focus, never appears in the
 * taskbar, and is built once and kept hidden between drags.
 *
 * Its page is fixed markup with no script of the page's and no bridge; the
 * title and the picture are handed to it as data, never written into markup.
 */

const { BaseWindow, WebContentsView, nativeImage } = require('electron');

const WIDTH = 260;
const TITLE_HEIGHT = 34;
const PICTURE_HEIGHT = 150;
/** Below and right of the pointer, so the drop lands on what is under it, not on this. */
const OFFSET = 14;

const PAGE = `<!doctype html><meta charset="utf-8"><style>
  :root { color-scheme: light dark; --bg: #f6f7f5; --fg: #1f2421; --line: #d9ddd8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #24272a; --fg: #e9ecea; --line: #3a3f43; } }
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--fg);
    font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { border: 1px solid var(--line); box-sizing: border-box; }
  .title { height: ${TITLE_HEIGHT}px; box-sizing: border-box; padding: 0 12px; display: flex; align-items: center;
    border-bottom: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .title span { overflow: hidden; text-overflow: ellipsis; }
  img { display: block; width: 100%; height: ${PICTURE_HEIGHT}px; object-fit: cover; object-position: top; }
  img[hidden] { display: none; }
</style><div class="title"><span id="t"></span></div><img id="p" alt="" hidden>
<script>
  window.render = (d) => {
    document.getElementById('t').textContent = d.title;
    const p = document.getElementById('p');
    if (d.picture) { p.src = d.picture; p.hidden = false; } else { p.hidden = true; p.removeAttribute('src'); }
  };
</script>`;

class TearPreview {
  constructor() {
    this.window = null;
    this.view = null;
    this.ready = null;
    this.tabId = null;
  }

  /** Show it for `tab` (if not already) at a point on the screen. */
  async show(tab, point) {
    if (!this.window || this.window.isDestroyed()) this.build();
    if (this.tabId !== tab.id) {
      this.tabId = tab.id;
      const image = await picture(tab);
      await this.ready;
      // Moved on, or let go, while the picture was taken.
      if (this.tabId !== tab.id || !this.window || this.window.isDestroyed()) return;
      const hasPicture = Boolean(image && !image.isEmpty());
      const height = TITLE_HEIGHT + (hasPicture ? PICTURE_HEIGHT : 0);
      this.window.setBounds({ x: Math.round(point.x + OFFSET), y: Math.round(point.y + OFFSET), width: WIDTH, height });
      this.view.setBounds({ x: 0, y: 0, width: WIDTH, height });
      const data = {
        title: String(tab.title || tab.url || 'New tab').slice(0, 200),
        picture: hasPicture ? image.resize({ width: WIDTH * 2, quality: 'good' }).toDataURL() : null
      };
      await this.view.webContents.executeJavaScript(`window.render(${JSON.stringify(data)})`).catch(() => {});
    }
    this.move(point);
    if (this.tabId === tab.id && !this.window.isVisible()) this.window.showInactive();
  }

  move(point) {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.setPosition(Math.round(point.x + OFFSET), Math.round(point.y + OFFSET));
  }

  hide() {
    this.tabId = null;
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) this.window.hide();
  }

  build() {
    this.window = new BaseWindow({
      width: WIDTH,
      height: TITLE_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true
    });
    // Seen through a little where the system can (Windows and macOS).
    try { this.window.setOpacity(0.92); } catch { /* not on this system */ }
    // Never in the way of the pointer, where the system allows it.
    try { this.window.setIgnoreMouseEvents(true); } catch { /* not on this system */ }
    this.view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true }
    });
    this.window.contentView.addChildView(this.view);
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.view.webContents.on('will-navigate', (event) => event.preventDefault());
    this.ready = this.view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch(() => {});
  }

  destroy() {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.view = null;
  }
}

/**
 * The page as it looks: drawn now, if it is on screen; otherwise the picture
 * taken when it was last left - a tab in the background has no fresh frame.
 */
async function picture(tab) {
  try {
    if (tab.isLive && tab.visible) return await tab.wc.capturePage();
  } catch { /* fall back to the kept one */ }
  try {
    if (tab.thumbPath) return nativeImage.createFromPath(tab.thumbPath);
  } catch { /* none */ }
  return null;
}

module.exports = { TearPreview };
