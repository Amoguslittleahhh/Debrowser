'use strict';

/**
 * A renderer warmed up while the pointer is still travelling to the button.
 *
 * Opening a new tab was not instant unless one was already open, and the reason
 * turned out to be the process rather than the page. Measured, with the
 * browser's own switches and partition:
 *
 *   cold new tab (no debrowser:// renderer alive)   79.3ms   pid 5013
 *   a second one while the first is alive           49.0ms   same pid
 *
 * Every page the browser serves itself - the new tab page, Settings, History -
 * is one site, so they share a renderer. The second one is fast because the
 * process is already there; the first pays to start it.
 *
 * So this starts it early. On a dwell over the + button or the menu, a
 * WebContentsView is created on the browsing partition and pointed at the new
 * tab page. It is never added to the window and never seen - measured, an
 * unattached view still spawns its renderer, and the tab created afterwards
 * opens in about half the time:
 *
 *   cold                                            79.3ms
 *   after a warmer created on hover                 46.1ms
 *
 * ## Not for the reason this comment used to give
 *
 * It said the real tab "lands in the same process" as the warmer, with two pids
 * quoted as evidence. Re-measured, it does not: a warmer on debrowser://newtab
 * gets pid 2092 and the tab that follows gets 2106, a process of its own - and
 * two views on the *same host* still do not share one, because Chromium's
 * default is a process per site *instance*, not per site. (With
 * `--process-per-site` they do share, which is what the economy profile turns
 * on and what made the original reading look like process reuse.)
 *
 * The saving is real and the figures above are reproducible; what buys it is
 * everything a first renderer pays for once and a second one does not - the
 * zygote fork path, the scheme and partition setup, V8's code cache for our own
 * scripts. Worth stating correctly, because "it reuses the process" invites the
 * wrong fix the next time this is slow.
 *
 * ## Why it expires
 *
 * A warm renderer is ~13MB, and this is a browser whose whole argument is that
 * a tab should not cost that when nobody is looking at it. So it is held for
 * seconds, not for the life of the window: hovering the + and walking away must
 * not leave a renderer behind. It also declines to do anything when one of the
 * browser's own pages is already live, because then the process it would create
 * already exists and this would be a second one for nothing.
 */

const { WebContentsView, session } = require('electron');
const pages = require('./pages');

/**
 * How long a warmed renderer is kept.
 *
 * Long enough to cover a pointer that pauses on the way to the button, short
 * enough that a hover the user did not follow through on costs a few seconds of
 * one renderer rather than the rest of the session.
 */
const TTL_MS = 12_000;

class Prewarm {
  /**
   * @param {object} deps
   * @param {string} deps.partition - the browsing partition, so the warmed
   *   renderer is the same one a real tab would get. A different session would
   *   warm a process no tab will ever join.
   * @param {string} deps.preload
   * @param {() => boolean} deps.hasLiveInternal - is one of our own pages
   *   already holding a renderer?
   * @param {() => boolean} deps.busy - true when the browser is under memory
   *   pressure or keeping out of an animation's way, in which case spending a
   *   renderer on a guess is the wrong trade.
   */
  constructor({ partition, preload, hasLiveInternal = () => false, busy = () => false,
                log = () => {}, enabled = true }) {
    this.partition = partition;
    this.preload = preload;
    this.hasLiveInternal = hasLiveInternal;
    this.busy = busy;
    this.log = log;
    this.enabled = enabled;

    /** @type {Electron.WebContentsView|null} */
    this.view = null;
    this.timer = null;
  }

  /** The pointer is heading for something that opens one of our pages. */
  warm() {
    if (!this.enabled) return false;
    // Already warm: just give it longer, since the user is evidently still here.
    if (this.view) { this.arm(); return true; }
    if (this.busy() || this.hasLiveInternal()) return false;

    try {
      this.view = new WebContentsView({
        webPreferences: {
          session: session.fromPartition(this.partition),
          preload: this.preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // Nothing is on screen to throttle, and the point is to get the
          // process up rather than to keep it running.
          backgroundThrottling: true
        }
      });
      // Caught, because `drop()` closes this mid-load on purpose - on the TTL,
      // at quit, and in the smoke test - and an aborted load rejects. Nothing
      // in this project installs an `unhandledRejection` handler, so the one
      // uncaught promise in the main process would be a crash.
      this.view.webContents.loadURL(pages.NEW_TAB_URL)
        .catch((err) => this.log(`prewarm load ended: ${err.message}`));
    } catch (err) {
      this.log(`prewarm failed: ${err.message}`);
      this.view = null;
      return false;
    }

    this.arm();
    return true;
  }

  arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.drop(), TTL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  drop() {
    clearTimeout(this.timer);
    this.timer = null;
    const view = this.view;
    this.view = null;
    if (!view) return;
    try {
      view.webContents.close();
    } catch { /* already gone */ }
  }
}

module.exports = { Prewarm, TTL_MS };
