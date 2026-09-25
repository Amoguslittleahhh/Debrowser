'use strict';

/**
 * A new tab page, ready before it is asked for.
 *
 * ## What this is now
 *
 * It used to warm a renderer and throw it away, so the tab that followed only
 * paid less to start its own. Now the warmed view *is* the next new tab: a
 * view built exactly as a tab builds one (createTabView), with the new tab page
 * already loaded and drawn, which the tab takes over (Tab#adopt). Measured:
 * shown, it draws its next frame in about 6 ms, where a new tab page built on
 * Ctrl+T took about 55 ms to first paint. Clicking the + or pressing Ctrl+T
 * both get it.
 *
 * It is kept only while it costs next to nothing. Our pages share a renderer,
 * so while one of them is open - a new tab page, Settings, History - a spare
 * beside it measured 0.3 MB. When the last one goes, the spare would be a
 * renderer of its own (~13 MB), so it is kept for TTL_MS in case another
 * new tab is on its way - the common Ctrl+T, type, Ctrl+T again - and then
 * dropped. A dwell on the + or the menu makes one as before, for as long.
 * Never under memory pressure or an animation, never in a private window.
 *
 * ## How the renderer-warming half was measured
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
 * A renderer of its own is ~13MB, and this is a browser whose whole argument
 * is that a tab should not cost that when nobody is looking at it. So when the
 * spare would be the only one of our pages alive, it is held for seconds, not
 * for the life of the window: a new tab page left for a website, or a hover
 * over the + that went nowhere, costs half a minute of one renderer at most.
 */

const pages = require('./pages');
const { createTabView } = require('./tabs/tab');

/**
 * How long a warmed renderer is kept when nothing else of ours is open.
 *
 * Long enough to cover a pointer that pauses on the way to the button, or a
 * new tab opened again shortly after the last one was left; short enough that
 * it costs seconds of one renderer rather than the rest of the session.
 */
const TTL_MS = 30_000;

class Prewarm {
  /**
   * @param {object} deps
   * @param {() => Electron.Session} deps.session - the browsing session
   * @param {() => boolean} deps.hasLiveInternal - is one of our own pages
   *   already holding a renderer? Then a spare costs next to nothing.
   * @param {() => boolean} deps.busy - memory pressure, or an animation to keep
   *   out of the way of: no spare then.
   */
  constructor({ session, hasLiveInternal = () => false, busy = () => false,
                log = () => {}, enabled = true }) {
    this.session = session;
    this.hasLiveInternal = hasLiveInternal;
    this.busy = busy;
    this.log = log;
    this.enabled = enabled;

    /** @type {Electron.WebContentsView|null} */
    this.view = null;
    this.loaded = false;
    this.timer = null;
    this.held = false;
  }

  /**
   * No spare until `until` settles. At startup a spare is a second renderer
   * starting beside the first tab's, on the same cores and the same browser
   * thread, and the first tab is the one being waited for.
   */
  holdUntil(until) {
    this.held = true;
    Promise.resolve(until).catch(() => {}).then(() => {
      this.held = false;
      this.refresh();
    });
  }

  /** The pointer is heading for something that opens a new tab page. */
  warm() {
    if (!this.make()) return false;
    this.arm();
    return true;
  }

  /**
   * Keep a spare while it is cheap, and start its clock when it is not. Called
   * as tabs come and go; cheap to call often.
   */
  refresh() {
    if (!this.enabled) return;
    if (this.hasLiveInternal()) {
      clearTimeout(this.timer);
      this.timer = null;
      this.make();
    } else if (this.view && !this.timer) {
      this.arm();
    }
  }

  /**
   * The spare, for a new tab to take, if one is loaded and waiting. The next
   * one is made on the following tick - cheaply, since the tab that took this
   * one now holds the renderer.
   */
  take() {
    const view = this.view;
    if (!view || !this.loaded || view.webContents.isDestroyed() || this.busy()) return null;
    clearTimeout(this.timer);
    this.timer = null;
    this.view = null;
    this.loaded = false;
    setImmediate(() => this.refresh());
    return view;
  }

  make() {
    if (!this.enabled || this.held || this.busy()) return false;
    if (this.view) return true;
    try {
      const view = createTabView({ session: this.session(), url: pages.NEW_TAB_URL });
      this.view = view;
      this.loaded = false;
      view.webContents.once('did-finish-load', () => { if (this.view === view) this.loaded = true; });
      // Caught, because `drop()` closes this mid-load on purpose - on the TTL,
      // at quit, and in the smoke test - and an aborted load rejects. Nothing
      // in this project installs an `unhandledRejection` handler, so the one
      // uncaught promise in the main process would be a crash.
      view.webContents.loadURL(pages.NEW_TAB_URL)
        .catch((err) => this.log(`spare new tab load ended: ${err.message}`));
      return true;
    } catch (err) {
      this.log(`spare new tab failed: ${err.message}`);
      this.view = null;
      return false;
    }
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
    this.loaded = false;
    if (!view) return;
    try {
      view.webContents.close();
    } catch { /* already gone */ }
  }
}

module.exports = { Prewarm, TTL_MS };
