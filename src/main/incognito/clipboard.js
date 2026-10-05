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

/** A fingerprint of what the clipboard holds, or null when it is empty. */
function signature() {
  try {
    const formats = clipboard.availableFormats();
    if (!formats.length) return null;
    const hash = crypto.createHash('sha256');
    hash.update(formats.join('\n'));
    hash.update('\0');
    hash.update(clipboard.readText());
    hash.update('\0');
    hash.update(clipboard.readHTML());
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
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

class ClipboardGuard {
  constructor({ read = signature, clear = () => clipboard.clear() } = {}) {
    this.read = read;
    this.clearClipboard = clear;
    this.atFocus = null;
    this.ours = null;
    this.focused = false;
  }

  /** Follow a window: what changed while it had the keyboard is the window's. */
  watch(win) {
    win.on('focus', () => {
      this.focused = true;
      this.atFocus = this.read();
    });
    win.on('blur', () => {
      this.mark();
      this.focused = false;
    });
    if (typeof win.isFocused === 'function' && win.isFocused()) {
      this.focused = true;
      this.atFocus = this.read();
    }
  }

  mark() {
    if (!this.focused) return;
    const now = this.read();
    if (now && now !== this.atFocus) this.ours = now;
    this.atFocus = now;
  }

  /** The window is going: clear the clipboard if it still holds the window's copy. */
  clearIfOurs() {
    this.mark();
    if (!this.ours) return false;
    const still = this.read() === this.ours;
    this.ours = null;
    if (still) this.clearClipboard();
    return still;
  }
}

module.exports = { ClipboardGuard, signature };
