'use strict';

/**
 * What a private window copied does not outlive it.
 *
 * The clipboard is the system's, not the window's: text copied from a private
 * page stayed there after the window closed, for the next program - or the
 * next person at the keyboard - to paste, and in a clipboard manager's history
 * after that. So when the private window goes, the clipboard is cleared if what
 * is on it was put there while the window had the keyboard: by a page, by the
 * address bar, by a Copy in a menu. Something copied in another program since
 * is left alone.
 *
 * Nothing is kept but a hash of what was there: what the clipboard holds is
 * read on focus and blur, compared, and forgotten.
 *
 * Windows' clipboard history (Win+V) and cloud clipboard take their own copy
 * the moment something is copied, which clearing cannot reach; the private
 * page says so.
 */

const crypto = require('crypto');
const { clipboard } = require('electron');

/**
 * A fingerprint of what the clipboard holds, or null when it is empty.
 *
 * Awaited throughout, and built from what this Electron's clipboard still
 * offers: it answers with promises, and has only `has`, `readText` and
 * `read` - no `availableFormats`, `readHTML` or `readImage`. Written for that
 * older API, every call threw, and the guard below never once saw a copy, so
 * a private window's copies outlived it. A build that still has the older
 * calls gets the finer fingerprint.
 */
async function signature() {
  try {
    const has = async (type) => (typeof clipboard.has === 'function' ? Boolean(await clipboard.has(type)) : false);
    const text = String(await clipboard.readText() ?? '');
    const kinds = ['text/plain', 'text/html', 'image/png'];
    const present = [];
    for (const kind of kinds) if (await has(kind)) present.push(kind);
    if (typeof clipboard.availableFormats === 'function') present.push(...(await clipboard.availableFormats()));
    if (!text && !present.length) return null;
    const hash = crypto.createHash('sha256');
    hash.update(present.join('\n'));
    hash.update('\0');
    hash.update(text);
    if (typeof clipboard.readHTML === 'function') {
      hash.update('\0');
      hash.update(String(await clipboard.readHTML() ?? ''));
    }
    const image = typeof clipboard.readImage === 'function' ? await clipboard.readImage() : null;
    if (image && !image.isEmpty()) {
      // A corner and the size: enough to tell two pictures apart, without
      // turning a whole screenshot into a bitmap on every focus change.
      const { width, height } = image.getSize();
      hash.update(`${width}x${height}`);
      hash.update(image.crop({ x: 0, y: 0, width: Math.min(64, width), height: Math.min(64, height) }).toBitmap());
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * What a private window copied, cleared when it closes - and nothing it did
 * not copy. Each look at the clipboard waits for the one before, so focus,
 * blur and close are judged in the order they happened.
 */
class ClipboardGuard {
  constructor({ read = signature, clear = () => clipboard.clear() } = {}) {
    this.read = read;
    this.clearClipboard = clear;
    this.atFocus = null;
    this.ours = null;
    this.focused = false;
    this.queue = Promise.resolve();
  }

  /** Run after everything already asked of the guard. */
  then(step) {
    this.queue = this.queue.then(step, step).catch(() => {});
    return this.queue;
  }

  /** Resolves once every look already asked for has been taken. */
  idle() { return this.queue; }

  /** Follow a window: what changed while it had the keyboard is the window's. */
  watch(win) {
    const focus = () => {
      this.focused = true;
      return this.then(async () => { this.atFocus = await this.read(); });
    };
    win.on('focus', focus);
    win.on('blur', () => {
      this.mark();
      this.then(() => { this.focused = false; });
    });
    if (typeof win.isFocused === 'function' && win.isFocused()) focus();
  }

  mark() {
    return this.then(async () => {
      if (!this.focused) return;
      const now = await this.read();
      if (now && now !== this.atFocus) this.ours = now;
      this.atFocus = now;
    });
  }

  /** The window is going: clear the clipboard if it still holds the window's copy. Resolves to whether it did. */
  async clearIfOurs() {
    this.mark();
    let cleared = false;
    await this.then(async () => {
      if (!this.ours) return;
      const still = (await this.read()) === this.ours;
      this.ours = null;
      if (still) { await this.clearClipboard(); cleared = true; }
    });
    return cleared;
  }
}

module.exports = { ClipboardGuard, signature };
