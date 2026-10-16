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
 * One image in a native view, not a page: the strip draws the title bar on a
 * canvas, in the interface's own face and colours (`titleCard` in chrome.js),
 * and it is put over the page's picture here. It was a page of its own, which
 * meant a renderer process held for good after the first drag - 76 MB, measured
 * - and a window shown before that page had painted, so the first drag of a
 * session began with a blank white box where the picture should have been.
 */

const { BaseWindow, ImageView, nativeImage } = require('electron');

const WIDTH = 260;
const TITLE_HEIGHT = 34;
const PICTURE_HEIGHT = 150;
/** Below and right of the pointer, so the drop lands on what is under it, not on this. */
const OFFSET = 14;

class TearPreview {
  constructor() {
    this.window = null;
    this.view = null;
    this.tabId = null;
  }

  /**
   * Show it for `tab` (if not already) at a point on the screen. `card` is the
   * title bar as the strip drew it, a PNG data URL `scale` times the size in
   * pixels; it comes with the first point of a drag.
   */
  async show(tab, point, { card = null, scale = 1 } = {}) {
    if (!this.window || this.window.isDestroyed()) this.build();
    if (this.tabId !== tab.id) {
      this.tabId = tab.id;
      const shot = await picture(tab);
      // Moved on, or let go, while the picture was taken.
      if (this.tabId !== tab.id || !this.window || this.window.isDestroyed()) return;
      const image = compose(card, shot, scale);
      const { width, height } = image.getSize();
      this.view.setImage(image);
      this.view.setBounds({ x: 0, y: 0, width, height });
      this.window.setBounds({ x: Math.round(point.x + OFFSET), y: Math.round(point.y + OFFSET), width, height });
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
      hasShadow: true,
      // What shows for the moment before the image is drawn: dark, as most of
      // the browser is, rather than the system's white.
      backgroundColor: '#24272a'
    });
    // Seen through a little where the system can (Windows and macOS).
    try { this.window.setOpacity(0.92); } catch { /* not on this system */ }
    // Never in the way of the pointer, where the system allows it.
    try { this.window.setIgnoreMouseEvents(true); } catch { /* not on this system */ }
    this.view = new ImageView();
    this.window.contentView.addChildView(this.view);
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.view = null;
  }
}

/**
 * The title bar over the page's picture, as one image: `scale` device pixels
 * to the point, so it is sharp on a high-density screen. Without a title bar
 * from the strip, a plain one in the dark theme's colour stands in.
 */
function compose(card, shot, scale) {
  const s = Math.max(1, Math.min(4, Number(scale) || 1));
  const w = Math.round(WIDTH * s);
  const th = Math.round(TITLE_HEIGHT * s);
  let title = card ? nativeImage.createFromDataURL(String(card)) : null;
  if (!title || title.isEmpty()) title = solid(w, th, [0x2a, 0x27, 0x24, 0xff]);
  const tsize = title.getSize();
  if (tsize.width !== w || tsize.height !== th) title = title.resize({ width: w, height: th, quality: 'good' });
  const top = title.toBitmap();
  // The title bar's own background and edge, in the bitmap's own byte order.
  const bg = top.subarray(((th >> 1) * w + (w >> 1)) * 4, ((th >> 1) * w + (w >> 1)) * 4 + 4);
  const edge = top.subarray(0, 4);

  const parts = [top];
  if (shot && !shot.isEmpty()) {
    const ph = Math.round(PICTURE_HEIGHT * s);
    // Width to the card's, then the top of it: object-fit: cover, from the top.
    const fitted = shot.resize({ width: w, quality: 'good' });
    const fh = Math.min(ph, fitted.getSize().height);
    const body = Buffer.alloc(w * ph * 4);
    fitted.crop({ x: 0, y: 0, width: w, height: fh }).toBitmap().copy(body, 0, 0, w * fh * 4);
    for (let i = w * fh * 4; i < body.length; i += 4) bg.copy(body, i);
    // The card's edge down both sides and along the bottom.
    for (let y = 0; y < ph; y++) { edge.copy(body, y * w * 4); edge.copy(body, (y * w + w - 1) * 4); }
    for (let x = 0; x < w; x++) edge.copy(body, ((ph - 1) * w + x) * 4);
    parts.push(body);
  }
  const bitmap = Buffer.concat(parts);
  return nativeImage.createFromBitmap(bitmap, { width: w, height: bitmap.length / (w * 4), scaleFactor: s });
}

/** A plain image: `bgra` is one pixel, in the order bitmaps here are kept in. */
function solid(width, height, bgra) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) buf.set(bgra, i);
  return nativeImage.createFromBitmap(buf, { width, height });
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

module.exports = { TearPreview, compose, WIDTH, TITLE_HEIGHT, PICTURE_HEIGHT };
