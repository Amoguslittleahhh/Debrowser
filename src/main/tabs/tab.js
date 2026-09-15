'use strict';

/**
 * A single tab, and the machinery for moving it between resource tiers.
 *
 * A tab outlives its renderer. When the governor discards one, the
 * `WebContentsView` and its process are destroyed outright - the tab's memory
 * goes to approximately zero - but this object survives holding everything
 * needed to rebuild the page exactly as the user left it: its navigation
 * history, scroll offset and unsubmitted form input. Restoring is lazy and
 * happens on activation, so a discarded tab costs nothing until it is clicked.
 */

const path = require('path');
const fs = require('fs');
const { WebContentsView, app } = require('electron');
const { Tier, isStopped } = require('../config');
const { CdpSession } = require('../cdp');

const PROBE_PRELOAD = path.join(__dirname, '..', '..', 'preload', 'probe-preload.js');
// The browser's own pages need the command bridge the chrome uses; a web page
// must never get it. Which one a tab loads is decided by `internal` below.
const PAGE_PRELOAD = path.join(__dirname, '..', '..', 'preload', 'chrome-preload.js');
const pages = require('../pages');

let nextTabId = 1;

/** Matches the chrome's surface colour, so an unpainted view is not white. */
const SURFACE_COLOUR = '#16181d';

/**
 * Thumbnails are shown behind a loading page for a few hundred milliseconds, so
 * they are sized to be recognisable rather than readable. At this width a JPEG
 * is roughly 20-40KB, and it lives on disk - never decoded and held in memory,
 * which would defeat the point.
 */
const THUMB_WIDTH = 480;
const THUMB_QUALITY = 55;

/** Under the OS temp directory: see the privacy note on captureThumbnail. */
const thumbnailDir = () => path.join(app.getPath('temp'), 'debrowser-thumbs');

/**
 * Delete every thumbnail left behind by a previous run.
 *
 * A crash cannot be relied upon to run the per-tab cleanup, and page images
 * outliving the session they came from is exactly what the privacy rules are
 * there to prevent. Called once at startup.
 */
async function sweepThumbnails() {
  try {
    await fs.promises.rm(thumbnailDir(), { recursive: true, force: true });
  } catch { /* nothing there, or not ours to remove */ }
}

/**
 * The same sweep, synchronously, for `before-quit`.
 *
 * Quit does not wait for promises, so the async version would be abandoned
 * mid-unlink. Of everything this browser does on the way out, removing page
 * screenshots is the one that must not be best effort.
 */
function sweepThumbnailsSync() {
  try {
    fs.rmSync(thumbnailDir(), { recursive: true, force: true });
  } catch { /* nothing there, or not ours to remove */ }
}

class Tab {
  /**
   * @param {object} options
   * @param {Electron.Session} options.session
   * @param {string} options.url
   * @param {(tab: Tab, event: string, payload?: any) => void} options.onEvent
   * @param {(...args:any[]) => void} options.log
   */
  constructor({ session, url = 'about:blank', onEvent = () => {}, log = () => {} }) {
    this.id = nextTabId++;
    this.session = session;
    this.onEvent = onEvent;
    this.log = log;

    this.url = url;
    /**
     * One of the browser's own pages, served under `debrowser://`.
     *
     * Decided from the URL rather than passed in, so it survives a discard and
     * restore, and so nothing a page does can turn itself into one. It governs
     * two things that must never disagree: which preload the renderer gets, and
     * whether the governor is allowed to touch this tab.
     */
    this.internal = pages.isInternal(url);
    this.title = this.internal ? pages.titleFor(url) : url;
    this.favicon = null;
    this.pinned = false;

    /** @type {Electron.WebContentsView|null} */
    this.view = null;
    /** @type {Electron.WebContents|null} */
    this.wc = null;
    /** @type {CdpSession|null} */
    this.cdp = null;
    this.pid = null;

    this.tier = Tier.DISCARDED; // becomes ACTIVE/WARM once realised
    this.visible = false;
    this.audible = false;
    this.loading = false;
    this.crashed = false;

    // Measurement, written by the metrics module.
    this.rssMB = 0;
    this.privateMB = 0;
    this.cpu = 0;
    this.jsHeapMB = 0;
    this.sharesProcess = false;
    /** This page's own CPU, differenced from CDP TaskDuration. Null until sampled. */
    this.taskCpu = null;
    this.lastTaskSec = null;
    this.lastTaskAt = 0;

    /**
     * Heap state for the square-root heap limit rule (governor/heap-limit.js):
     * L, g and s in the paper's terms. All null until this tab has been
     * measured, which only happens if it is big enough to be worth it.
     */
    this.resetHeapState();

    // Activity, written by the probe and the boost controller.
    this.reportedDemand = 'idle';
    this.demand = 'idle';
    this.boosted = false;
    this.lastHeavyAt = 0;
    this.pendingSettleAt = 0;
    this.priority = 0;

    this.lastActiveAt = Date.now();
    this.createdAt = Date.now();

    /**
     * Whether the user has ever actually looked at this tab.
     *
     * A tab opened in the background and never viewed has nothing on screen to
     * lose, so the grace period that protects a tab you just left does not
     * apply to it. Without this distinction, opening twenty links in background
     * tabs created twenty renderers that were all immune from reclaim for a
     * full minute - the exact memory spike the governor exists to prevent.
     */
    this.everVisible = false;

    /**
     * Everything needed to resurrect the page after a discard.
     * @type {{entries: any[], index: number, state: any}|null}
     */
    this.suspendedState = null;
    this.hasDirtyInput = false;
    /**
     * Whether the page was last seen carrying a credential or payment field.
     * Set from the page-state snapshot, which reports the presence of such a
     * field without ever reading it. Used only to refuse to photograph the
     * page; see captureThumbnail.
     */
    this.hasSensitiveFields = false;

    /** Path to this tab's thumbnail on disk, or null. Never the image itself. */
    this.thumbPath = null;

    /**
     * When a speculative restore stops being excused. Non-zero only while this
     * tab holds a renderer built on a guess that the user was about to click
     * it; see TabManager#speculate and the idle ladder's expiry clause.
     */
    this.speculativeUntil = 0;

    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
  }

  get isLive() {
    return Boolean(this.wc && !this.wc.isDestroyed());
  }

  get isDiscarded() {
    return this.tier === Tier.DISCARDED;
  }

  /** Milliseconds since the user last had this tab in front of them. */
  idleMs(now = Date.now()) {
    return this.visible ? 0 : now - this.lastActiveAt;
  }

  /**
   * Keep a privileged page from becoming a privileged web page.
   *
   * An internal tab's renderer has the command bridge in its preload. If a link
   * in Settings could navigate that same renderer to a site, the site's own
   * JavaScript would inherit it - a complete escape from the sandbox this
   * browser otherwise keeps pages inside. So an internal tab is confined: any
   * navigation away from `debrowser://` is cancelled and handed to a normal tab
   * instead, which is also the behaviour a user wants from a link in Settings.
   */
  confineToInternalPages() {
    this.wc.on('will-navigate', (event, url) => {
      if (pages.isInternal(url)) return;
      event.preventDefault();
      this.onEvent(this, 'open-tab', { url });
    });
    this.wc.setWindowOpenHandler(({ url }) => {
      this.onEvent(this, 'open-tab', { url });
      return { action: 'deny' };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Realisation and teardown                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Create the renderer for this tab. Called on first open and again on every
   * restore-from-discard.
   */
  realise() {
    if (this.isLive) return;

    this.view = new WebContentsView({
      webPreferences: {
        session: this.session,
        preload: this.internal ? PAGE_PRELOAD : PROBE_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Chromium's own background throttling stays on; the governor layers
        // its harder tiers on top rather than replacing it.
        backgroundThrottling: true,
        transparent: false
      }
    });

    // Avoid a white flash on restore. The webPreferences above do not do this -
    // an earlier comment there claimed they did - because the flash comes from
    // the view compositing its own default white before the page paints, and
    // only the view's background colour governs that.
    this.view.setBackgroundColor(SURFACE_COLOUR);

    this.wc = this.view.webContents;
    this.cdp = new CdpSession(this.wc, this.log);
    this.crashed = false;

    if (this.internal) this.confineToInternalPages();

    this.wireEvents();

    const restored = this.restoreNavigation();
    if (!restored) {
      // A rejection here usually just means the navigation was superseded -
      // by our own error page, or by the user typing somewhere else - so it is
      // logged, briefly, rather than surfaced.
      this.wc.loadURL(this.url).catch((err) => this.log(`load failed: ${brief(err.message)}`));
    }

    this.tier = this.visible ? Tier.ACTIVE : Tier.WARM;
    this.emit('realised');
  }

  wireEvents() {
    const wc = this.wc;

    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      this.emit('updated');
    });

    wc.on('page-favicon-updated', (_e, icons) => {
      this.favicon = icons?.[0] || null;
      this.emit('updated');
    });

    wc.on('did-start-loading', () => { this.loading = true; this.emit('updated'); });
    wc.on('did-stop-loading', () => { this.loading = false; this.emit('updated'); });

    wc.on('did-navigate', (_e, url) => {
      this.url = url;
      // A new document means new load-time garbage, and the previous page's
      // heap estimates no longer describe anything.
      this.resetHeapState();
      this.emit('updated');
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) { this.url = url; this.emit('updated'); }
    });

    // Audible tabs are protected from freezing and discarding: silencing a
    // user's music to save memory is never the right call.
    wc.on('audio-state-changed', (_e, state) => {
      this.audible = typeof state === 'object' ? state.audible : state;
      this.emit('updated');
    });

    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // Only main-frame failures are the user's problem; a blocked tracker
      // iframe is not. `ERR_ABORTED` means a navigation was superseded by
      // another one, which is normal and must not replace the page.
      if (!isMainFrame || errorCode === -3) return;
      // Never render an error page for a failed error page.
      if (String(validatedURL).startsWith('data:')) return;
      this.showError(validatedURL, errorDescription || `error ${errorCode}`);
    });

    wc.on('render-process-gone', (_e, details) => {
      this.log(`tab ${this.id} renderer gone: ${details.reason} exitCode=${details.exitCode}`);
      this.pid = null;
      // An out-of-memory kill is not a crash the user should have to see: fall
      // back to the discard path, which restores cleanly on next activation.
      if (details.reason === 'oom' || details.reason === 'killed') {
        this.captureNavigation();
        this.teardownView();
        this.tier = Tier.DISCARDED;
      } else {
        this.crashed = true;
      }
      this.emit('updated');
    });

    wc.once('did-finish-load', () => {
      this.pid = safePid(wc);
      this.applySuspendedPageState();
      this.emit('updated');
    });

    // New windows open as tabs rather than popups.
    wc.setWindowOpenHandler(({ url }) => {
      this.emit('open-tab', { url });
      return { action: 'deny' };
    });
  }

  /**
   * Render a failed navigation in the tab itself.
   *
   * Loaded as a data URL so it needs no network, no file access and no
   * privileges: the error page is just a document, and gets no more trust than
   * any other. The failing URL is inserted as text content by script rather
   * than interpolated into the markup, so a hostile URL cannot inject into it.
   */
  showError(url, description) {
    this.title = 'Problem loading page';
    const payload = JSON.stringify({ url: String(url || ''), description: String(description || '') });
    const html = `<!doctype html><meta charset="utf-8">
<title>Problem loading page</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; display: grid; place-items: center; min-height: 100vh;
         background: #16181d; color: #e6e8ee;
         font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  @media (prefers-color-scheme: light) { body { background: #f2f3f6; color: #1a1d24; } }
  main { max-width: 27rem; padding: 1.5rem; text-align: center; }
  h1 { font-size: 1.1rem; margin: 0 0 .5rem; }
  p { margin: .35rem 0; color: #9aa1b1; }
  code { word-break: break-all; font-size: .85em; }
</style>
<main>
  <h1>This page could not be loaded</h1>
  <p id="d"></p>
  <p><code id="u"></code></p>
</main>
<script>
  var e = ${payload};
  document.getElementById('d').textContent = e.description;
  document.getElementById('u').textContent = e.url;
</script>`;

    this.wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => { /* nothing further we can do */ });
    this.emit('updated');
  }

  /**
   * Clear the heap state for the square-root heap limit rule
   * (governor/heap-limit.js): L, g and s in the paper's terms. All null until
   * this tab has been measured, which only happens if it is big enough to be
   * worth it.
   *
   * Called from the constructor and from every point where the heap these
   * estimates describe ceases to exist - a navigation, a renderer teardown.
   * Partially clearing them is worse than not clearing them at all: a stale
   * allocation rate paired with a fresh live set makes the rule compute a
   * limit for a heap that never existed.
   */
  resetHeapState() {
    /** Set once the load-time garbage has been collected for the current page. */
    this.heapBacklogCollected = false;
    this.liveHeapBytes = null;          // L: live set, read just after a collection
    this.heapTotalBytes = null;         // committed heap size, what M bounds
    this.allocRateBytesPerSec = null;   // g: smoothed allocation rate
    this.gcSpeedBytesPerSec = null;     // s: observed collection throughput
    this.lastHeapBytes = null;
    this.lastHeapAt = 0;
  }

  teardownView() {
    if (this.cdp) {
      this.cdp.detach();
      this.cdp = null;
    }
    if (this.view) {
      try {
        const wc = this.view.webContents;
        if (wc && !wc.isDestroyed()) wc.close();
      } catch { /* already gone */ }
    }
    this.view = null;
    this.wc = null;
    this.pid = null;
    this.rssMB = 0;
    this.cpu = 0;
    this.jsHeapMB = 0;
    this.taskCpu = null;
    this.lastTaskSec = null;
    this.lastTaskAt = 0;
    // A new renderer means a new heap; none of the rule's estimates carry over.
    this.resetHeapState();
    this.boosted = false;
    this.pendingSettleAt = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Session capture / restore                                         */
  /* ---------------------------------------------------------------- */

  /** Snapshot navigation history so a discarded tab keeps back/forward. */
  captureNavigation() {
    if (!this.isLive) return;
    const nav = this.wc.navigationHistory;
    let entries = null;
    let index = 0;
    try {
      if (nav && typeof nav.getAllEntries === 'function') {
        entries = nav.getAllEntries();
        index = nav.getActiveIndex();
      }
    } catch { entries = null; }

    this.suspendedState = {
      entries,
      index,
      url: this.url,
      state: this.suspendedState?.state || null
    };
  }

  /**
   * Ask the page for its scroll position and unsubmitted input.
   * Resolves with `null` if the renderer does not answer promptly - a page can
   * be blocked on its own script, and a discard must never hang on it.
   */
  capturePageState(ipcHub, timeoutMs = 400) {
    // Only a live, unfrozen renderer can answer. The governor snapshots the
    // moment a tab is hidden, before it can reach a state where it cannot.
    // A stopped page cannot run the script that answers, frozen or hibernated.
    if (!this.isLive || isStopped(this.tier)) return Promise.resolve(null);
    return ipcHub.request(this.wc, timeoutMs).then((state) => {
      if (state) {
        this.hasDirtyInput = Boolean(state.dirty);
        this.hasSensitiveFields = Boolean(state.sensitive);
        this.suspendedState = { ...(this.suspendedState || {}), state, url: this.url };
      }
      return state;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Thumbnails                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Photograph the page, so a later restore has something to show instead of a
   * blank view.
   *
   * Taken when the tab is hidden rather than when it is discarded, for the same
   * reason the page-state snapshot is: by discard time a tab is usually frozen,
   * and a frozen page cannot paint. A hidden view returns a stale frame at best.
   * The only moment the content is definitely on screen is as the user leaves.
   *
   * **Privacy.** A thumbnail is a picture of the page, and this browser already
   * refuses to read credentials and payment fields into its own session store.
   * A screenshot of a logged-in page left on disk would defeat that, so three
   * rules hold and all of them are load-bearing:
   *
   *   - never for a page carrying a password or payment field. The presence of
   *     one is reported by the page-state snapshot, which is the same signal
   *     that already exists for that purpose rather than a second detector.
   *   - written under the OS temp directory, not userData, so a kill -9 leaves
   *     nothing a normal session would not have cleaned up.
   *   - deleted when the tab closes, when the browser quits, and swept on
   *     startup - see `sweepThumbnails`.
   *
   * Never awaited by anything on the tab-switch path. A capture that is slow,
   * or fails, must cost the user nothing: the placeholder simply falls back to
   * the flat surface colour, which is still better than the white flash this
   * replaces.
   */
  async captureThumbnail() {
    if (!this.isLive || !this.visible) return null;

    if (this.hasSensitiveFields) {
      // Deliberately also clears any thumbnail taken before the page grew a
      // login form, so routing into a sign-in form removes the old picture.
      this.discardThumbnail();
      return null;
    }

    // Fail closed. `hasSensitiveFields` is only meaningful once the probe has
    // actually looked at this page; before that it is merely still false, which
    // is not the same as "checked, and safe". A page that has never reported
    // is not photographed - the cost is a missing placeholder on a fast switch,
    // against writing a picture of an unexamined page to disk.
    if (!this.lastProbeAt) return null;

    try {
      const image = await this.wc.capturePage();
      if (!image || image.isEmpty()) return null;

      // Downscaled hard. This is shown for a few hundred milliseconds behind a
      // loading page, so it needs to read as the right page, not to be legible.
      const buffer = image.resize({ width: THUMB_WIDTH }).toJPEG(THUMB_QUALITY);
      if (!buffer || !buffer.length) return null;

      const dir = thumbnailDir();
      await fs.promises.mkdir(dir, { recursive: true });
      const file = path.join(dir, `tab-${this.id}.jpg`);
      await fs.promises.writeFile(file, buffer);
      this.thumbPath = file;
      return file;
    } catch (err) {
      // A renderer that went away mid-capture, a full disk, a page that cannot
      // be photographed. None of these is worth telling the user about.
      this.log(`thumbnail failed for tab ${this.id}: ${brief(err.message)}`);
      return null;
    }
  }

  /** Forget and delete this tab's thumbnail. Safe to call repeatedly. */
  discardThumbnail() {
    const file = this.thumbPath;
    this.thumbPath = null;
    if (!file) return;
    fs.promises.unlink(file).catch(() => { /* already gone */ });
  }

  /** Replay stored navigation history into a freshly realised renderer. */
  restoreNavigation() {
    const saved = this.suspendedState;
    if (!saved) return false;

    const nav = this.wc.navigationHistory;
    if (saved.entries?.length && nav && typeof nav.restore === 'function') {
      try {
        nav.restore({ entries: saved.entries, index: saved.index });
        return true;
      } catch (err) {
        this.log(`history restore failed, falling back to URL: ${err.message}`);
      }
    }

    const url = saved.url || this.url;
    if (url && url !== 'about:blank') {
      this.wc.loadURL(url).catch((err) => this.log(`restore load failed: ${err.message}`));
      return true;
    }
    return false;
  }

  /** Push scroll/form state back into the page once it has loaded. */
  applySuspendedPageState() {
    const state = this.suspendedState?.state;
    if (!state || !this.isLive) return;
    this.sendToPage('debrowser:restore-state', state);
    // Consumed: keep navigation history, drop the one-shot page state.
    if (this.suspendedState) this.suspendedState.state = null;
    this.hasDirtyInput = false;
  }

  /* ---------------------------------------------------------------- */
  /* Visibility                                                        */
  /* ---------------------------------------------------------------- */

  setVisible(visible) {
    this.visible = visible;
    if (visible) {
      this.lastActiveAt = Date.now();
      this.everVisible = true;
    } else {
      // A hidden tab is idle by definition as far as boosting is concerned.
      // Clearing this here rather than waiting for the page to tell us keeps a
      // stale "heavy" report from holding a boost on a tab nobody can see.
      this.reportedDemand = 'idle';
      this.demand = 'idle';
    }
    if (this.view) this.view.setVisible(visible);
  }

  /**
   * Send a message to the page, but only when it is in a state to receive one.
   *
   * A frozen renderer has its task queues stopped, and delivering IPC to it
   * segfaults the process - which surfaces as a tab that dies the moment the
   * user clicks back to it. Every send to a page goes through here so that
   * cannot happen by accident.
   */
  sendToPage(channel, ...args) {
    if (!this.isLive) return false;
    // Rank, not equality. A hibernated renderer is every bit as stopped as a
    // frozen one, and IPC to a stopped renderer is the segfault this gate
    // exists to prevent - so a new tier below FROZEN must never slip past it.
    if (isStopped(this.tier)) return false;

    try {
      this.wc.send(channel, ...args);
      return true;
    } catch {
      return false; // frame disposed mid-send
    }
  }

  setBounds(bounds) {
    this.bounds = bounds;
    if (this.view) this.view.setBounds(bounds);
  }

  emit(event, payload) {
    this.onEvent(this, event, payload);
  }

  /** Serialisable view of the tab for the browser chrome UI. */
  toJSON() {
    return {
      id: this.id,
      url: this.url,
      title: this.title || this.url,
      favicon: this.favicon,
      tier: this.tier,
      visible: this.visible,
      everVisible: this.everVisible,
      audible: this.audible,
      loading: this.loading,
      crashed: this.crashed,
      pinned: this.pinned,
      boosted: this.boosted,
      demand: this.demand,
      rssMB: Math.round(this.rssMB),
      cpu: Math.round((this.cpu || 0) * 10) / 10,
      sharesProcess: this.sharesProcess,
      idleMs: this.idleMs(),
      hasDirtyInput: this.hasDirtyInput,
      // So the toolbar can grey out back/forward rather than offering buttons
      // that do nothing. A tab with no renderer has no live history to ask, and
      // reports both as unavailable - which is honest: it cannot navigate
      // anywhere until it is restored, and activating it is what restores it.
      canGoBack: this.isLive ? this.wc.navigationHistory.canGoBack() : false,
      canGoForward: this.isLive ? this.wc.navigationHistory.canGoForward() : false
    };
  }
}

/** Keep a data: URL from dumping its whole payload into the log. */
function brief(message, max = 120) {
  const text = String(message || '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safePid(wc) {
  try {
    return wc.getOSProcessId();
  } catch {
    return null;
  }
}

module.exports = { Tab, sweepThumbnails, sweepThumbnailsSync };
