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
const errorPage = require('../error-page');
const palette = require('../palette');
const { INCOGNITO } = require('../incognito/mode');
const fingerprint = require('../incognito/fingerprint');

/**
 * How much larger Settings opens than the rest of the browser.
 *
 * A value from the zoom ladder in main.js rather than a number of its own, so
 * the first press of ctrl+minus lands on a step the ladder knows and not
 * somewhere between two of them.
 */
const SETTINGS_ZOOM = 1.1;

let nextTabId = 1;

/**
 * Failures that mean "this site does not do https here": a TLS handshake that
 * could not happen, or nothing listening on 443. Not certificate errors - a
 * site that answers https with a bad certificate is exactly what must not be
 * quietly retried in the clear.
 */
const HTTPS_ONLY_FAILURES = new Set([
  -107, // SSL_PROTOCOL_ERROR
  -113, // SSL_VERSION_OR_CIPHER_MISMATCH
  -102, // CONNECTION_REFUSED
  -100, // CONNECTION_CLOSED
  -101, // CONNECTION_RESET
  -118  // CONNECTION_TIMED_OUT
]);


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
   * @param {(wc: Electron.WebContents) => void} options.applyZoom - sets a new
   *   document's zoom; see zoom.js
   * @param {(...args:any[]) => void} options.log
   */
  constructor({ session, url = 'about:blank', onEvent = () => {}, applyZoom = () => {},
                log = () => {} }) {
    this.id = nextTabId++;
    this.session = session;
    this.onEvent = onEvent;
    this.applyZoom = applyZoom;
    this.log = log;
    /** Set by the manager once the tab has left the strip for good. */
    this.closed = false;

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
    /**
     * Which page this renderer was *built* for.
     *
     * Distinct from `internal`, which follows the current URL. A tab that
     * started on the new tab page and was then navigated to a site keeps the
     * preload it was realised with until the renderer is rebuilt - so privilege
     * must never be decided from this. It exists so the governor and the UI can
     * tell what a renderer is carrying.
     */
    this.realisedInternal = this.internal;

    /**
     * The webContents hosting this tab's inspector, when the browser is showing
     * it in a view of its own rather than letting Chromium put it in a window.
     * Set and cleared by BrowserShell; see `devToolsOpen` below.
     * @type {Electron.WebContents|null}
     */
    this.devToolsHost = null;
    this.title = this.internal ? pages.titleFor(url) : url;
    this.favicon = null;
    this.pinned = false;
    /** The tab a link opened this one from, so its siblings can queue up beside it. */
    this.openerId = null;

    /** @type {Electron.WebContentsView|null} */
    this.view = null;
    /** @type {Electron.WebContents|null} */
    this.wc = null;
    /** @type {CdpSession|null} */
    this.cdp = null;

    this.tier = Tier.DISCARDED; // becomes ACTIVE/WARM once realised
    this.visible = false;
    this.audible = false;
    /**
     * Silenced by the user.
     *
     * Kept on the tab rather than only on the renderer, because a discarded tab
     * has no renderer to hold it: mute a noisy tab, leave it long enough to be
     * reclaimed, come back, and it would start talking again. Re-applied on
     * every realisation for that reason.
     */
    this.muted = false;
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

  /**
   * The process this tab's page is in *right now*.
   *
   * Read live rather than cached, because a cached one goes stale in the most
   * ordinary way there is: with site isolation on, navigating from one site to
   * another moves the page into a different renderer. This used to be assigned
   * in a `once('did-finish-load')`, so it held whichever process the tab was
   * realised in - and every tab that had navigated anywhere attributed its
   * memory to a process it no longer used.
   *
   * What that looked like: in a six-tab session, only the browser's own pages
   * reported any memory at all, because they are the only tabs that never leave
   * the process they started in. Every website read 0 MB, including the one in
   * front of the user.
   *
   * `getOSProcessId()` is a plain accessor, so this is cheap enough for the
   * governor to ask once per tab per tick.
   */
  get pid() {
    return this.isLive ? safePid(this.wc) : null;
  }

  get isDiscarded() {
    return this.tier === Tier.DISCARDED;
  }

  /**
   * Whether an inspector is attached to this page.
   *
   * Asked of the renderer rather than tracked as a flag here, because DevTools
   * can be closed from its own window - by its close button, or by the user
   * closing it as a window - and nothing tells us when that happens. A flag
   * would go stale in the direction that matters: a tab held out of the reclaim
   * ladder forever by tools that are no longer open.
   */
  get devToolsOpen() {
    if (!this.isLive) return false;
    // An inspector hosted in one of the browser's own views does not count as
    // opened by this measure - `isDevToolsOpened()` returns false for exactly
    // that arrangement, measured - so the host is the only signal there is.
    // It is still not a flag anyone sets by hand: the shell clears it from
    // `devtools-closed`, which is what the inspector's own close button fires.
    if (this.devToolsHost && !this.devToolsHost.isDestroyed()) return true;
    try {
      return this.wc.isDevToolsOpened();
    } catch {
      return false;
    }
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
      // Only while this tab is actually showing one of our pages.
      //
      // The handler is installed once, when the renderer is realised, and every
      // tab is realised on the new tab page - so without this test it went on
      // cancelling navigations for the rest of the tab's life. Every link click
      // and every GET form submission on every website was hijacked into a new
      // tab. It survived the tests because they navigate with `loadURL`, which
      // does not fire `will-navigate` at all.
      if (!this.internal) return;
      if (pages.isInternal(url)) return;
      event.preventDefault();
      this.onEvent(this, 'open-tab', { url });
    });
    // New windows are already opened as tabs by the handler `wireEvents`
    // installs, for every tab; a second one here was replaced by it unseen.
  }

  /* ---------------------------------------------------------------- */
  /* Realisation and teardown                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Load `url` in a new renderer built for it.
   *
   * For a tab whose renderer was made for one of our pages - every tab starts
   * on the new tab page - and is now asked for a website. The preload is fixed
   * when a renderer is built, so loading the site into the same one left the
   * page bridge in it: `window.debrowser` visible to the site (its commands
   * refused, since privilege is decided from the live URL, but there), and
   * the page probe that makes Ctrl+wheel zoom work missing. The new tab page
   * has no history worth keeping, so nothing is lost by starting clean.
   */
  rebuildFor(url) {
    this.emit('rebuild');
    this.teardownView();
    this.suspendedState = null;
    this.url = url;
    this.internal = pages.isInternal(url);
    this.realise();
  }

  /**
   * Create the renderer for this tab. Called on first open and again on every
   * restore-from-discard.
   */
  realise() {
    if (this.isLive) return;
    this.realisedInternal = this.internal;

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
        transparent: false,
        // A new spellchecker fetches its dictionary on its own; in incognito
        // that is a request no page asked for.
        spellcheck: !INCOGNITO,
        // WebGL hands a page the graphics card's name and quirks; a private
        // window gives it none. See incognito/fingerprint.js for WebGPU.
        webgl: !INCOGNITO,
        // Tells the page preload it is in a private window: see the end of
        // probe-preload.js, where dropped and pasted files are cleaned.
        additionalArguments: INCOGNITO ? ['--debrowser-private'] : []
        // No `zoomFactor` here: Chromium records it against the site the page
        // loads, so a default applied this way pinned every site. The zoom is
        // set per document instead, below - see zoom.js.
      }
    });

    // What shows before the page paints, and wherever it paints nothing: the
    // view's own background, which the webPreferences above do not govern -
    // an earlier comment there claimed they did. See palette.surfaceFor.
    this.view.setBackgroundColor(palette.surfaceFor(this.url));

    this.wc = this.view.webContents;
    // WebRTC gathers ICE candidates over UDP, which does not go through a SOCKS
    // proxy - so it would reveal this machine's addresses to any page that asks.
    // Set per view as well as by the command-line switch in incognito.
    if (INCOGNITO) this.wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    this.cdp = new CdpSession(this.wc, this.log);
    this.crashed = false;

    if (this.internal) this.confineToInternalPages();

    this.wireEvents();

    // Captured now: in a private window a blank page loads first (see below),
    // and the tab's own navigation tracking would record it as the address.
    const target = this.url;
    const load = () => {
      this.url = target;
      const restored = this.restoreNavigation();
      if (!restored) {
        // A rejection here usually just means the navigation was superseded -
        // by our own error page, or by the user typing somewhere else - so it
        // is logged, briefly, rather than surfaced.
        this.wc.loadURL(target)
          .then(() => {
            // The blank page the overrides went on is not somewhere Back
            // should go. Cleared once the real page has committed.
            if (INCOGNITO && this.wc && !this.wc.isDestroyed()) this.wc.navigationHistory.clear();
          })
          .catch((err) => this.log(`load failed: ${brief(err.message)}`));
      }
    };
    // A private tab loads nothing until the page cannot read the real
    // timezone, locale, core count or screen. See incognito/fingerprint.js.
    // The browser's own pages too: the self-check is one of them, and a page
    // that reads the real values would report a problem that is not there.
    if (INCOGNITO) {
      if (this.bounds) fingerprint.setScreen(this, this.bounds);
      fingerprint.shield(this, load).catch((err) => this.log(`fingerprint shield failed: ${err.message}`));
    } else {
      load();
    }

    this.tier = this.visible ? Tier.ACTIVE : Tier.WARM;
    this.emit('realised');
  }

  wireEvents() {
    const wc = this.wc;

    // What the page says about itself, as one event.
    //
    // Separate from 'updated', which also fires for loading and audio changes.
    // The history store answers this one by searching its list for the URL, and
    // doing that on every state change would be a scan of ten thousand entries
    // several times per page load.
    const described = () => this.emit('described', {
      url: this.url, title: this.title, favicon: this.favicon
    });

    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      described();
      this.emit('updated');
    });

    wc.on('page-favicon-updated', (_e, icons) => {
      this.favicon = icons?.[0] || null;
      described();
      this.emit('updated');
    });

    // A new document has not been probed yet, so nothing is known about it.
    //
    // `hasSensitiveFields` is the gate that stops a page with a password field
    // being photographed, and it was left at the previous document's answer
    // until the new one's first probe arrived. Navigating from a safe page to a
    // sign-in page and switching tabs inside that window wrote a thumbnail of
    // the login page to disk - the exact thing the gate exists to prevent.
    // Assumed sensitive until a probe says otherwise, because the failure has
    // to be a missing thumbnail rather than a leaked one.
    wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      // White behind a website, our surface behind our own pages.
      try { this.view?.setBackgroundColor(palette.surfaceFor(url)); } catch { /* view going away */ }
      this.hasSensitiveFields = true;
      this.lastProbeAt = 0;
    });
    wc.on('did-start-loading', () => {
      this.loading = true;
      // A crashed renderer that is loading again has been brought back, by a
      // reload or anything else - whether or not the page then loads.
      this.crashed = false;
      this.emit('updated');
    });
    wc.on('did-stop-loading', () => {
      this.loading = false;
      // What is actually showing. A navigation that was stopped, or refused by
      // the page's "Leave this page?", never commits - and the address it was
      // going to stayed in the bar, where the star and the site panel acted on
      // a page that was not there.
      this.reconcileUrl();
      // A reload keeps the entry's title, so Chromium never reports it again,
      // and the reset at commit (below) would leave the address standing in
      // for it. Taken back here - unless what the engine has is itself only
      // the address, which is what it answers for a page with no <title>.
      const title = wc.getTitle();
      if (this.title === this.url && title && title !== this.url && !this.url.endsWith(title)) this.title = title;
      this.emit('updated');
    });

    wc.on('did-navigate', (_e, url) => {
      this.url = url;
      this.httpFallback = null;
      this.failed = false;
      // At commit, before the new document paints.
      try { this.applyZoom(wc); } catch { /* the view is going away */ }
      /*
       * A new document does not inherit the last one's name or its icon.
       *
       * Both were left standing until the new page announced its own, which is
       * some hundreds of milliseconds later at best - and the history entry is
       * written *here*, from `visited`, so a row was recorded under the title
       * of the page the user came from. The icon was worse: the store keeps an
       * address only when it differs from the default, so the previous site's
       * custom icon looked exactly like a custom icon for this one and was
       * persisted as such.
       *
       * Cleared at commit rather than at `did-start-navigation`, so the strip
       * keeps showing the old page while the new one is still loading - which
       * is what every browser does, and the reason the reset belongs on this
       * event and not the earlier one.
       */
      // The browser's own pages get their name rather than their address.
      //
      // Clearing to the raw URL is right for a website - it is what the strip
      // shows until the page announces a title - but `debrowser://newtab/` is
      // not a title anybody wants to read, and the new tab page's own <title>
      // may never arrive before the user looks. The constructor already uses
      // `titleFor` for exactly this; the reset had to as well, or navigating to
      // the new tab page left its address in the strip and in the task manager.
      this.title = pages.isInternal(url) ? pages.titleFor(url) : url;
      this.favicon = null;
      // `internal` follows the *current* URL, always.
      //
      // Every tab now opens on debrowser://newtab, and typing in its search box
      // navigates that same tab to a website. Deciding this once in the
      // constructor left every tab in the browser permanently marked internal -
      // exempt from the governor, so nothing was ever frozen or discarded, and
      // treated as privileged for the rest of its life. Privilege is never
      // decided from this field either; see the sender checks in main.js, which
      // read the live URL.
      this.internal = pages.isInternal(url);
      // A new document means new load-time garbage, and the previous page's
      // heap estimates no longer describe anything.
      this.resetHeapState();
      this.emit('visited', { url });
      this.emit('updated');
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      // Recorded like any other navigation. A single-page application changes
      // the address bar and the document without a load, and a history that
      // held only the entry point would have one row for a site the user spent
      // an hour moving around inside.
      if (isMainFrame) { this.url = url; this.emit('visited', { url }); this.emit('updated'); }
    });

    // Audible tabs are protected from freezing and discarding: silencing a
    // user's music to save memory is never the right call.
    // Asked of the webContents rather than read off the event: the event's
    // shape changed under us (Electron 44 passes only the event, with
    // `audible` on it), and reading the old second argument left every tab
    // silent - no speaker mark, and a playing tab left open to discarding.
    wc.on('audio-state-changed', () => {
      this.audible = !wc.isDestroyed() && wc.isCurrentlyAudible();
      this.emit('updated');
    });

    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // Only main-frame failures are the user's problem; a blocked tracker
      // iframe is not. `ERR_ABORTED` means a navigation was superseded by
      // another one, which is normal and must not replace the page.
      if (!isMainFrame || errorCode === -3) return;
      // Incognito upgraded this from plain HTTP and the secure version is not
      // there. Say so, and let the user decide, rather than fail blankly or
      // quietly fall back to a page an exit relay can read.
      if (INCOGNITO) {
        const plain = require('../incognito/policy').upgradeFailed(validatedURL, errorCode);
        if (plain) {
          this.wc.loadURL(`${pages.INSECURE_URL}?url=${encodeURIComponent(plain)}`).catch(() => {});
          return;
        }
      }
      // An https address the browser guessed, on a site that has none: the
      // same address over http, once, instead of an error page.
      const guessed = this.httpFallback;
      this.httpFallback = null;
      if (guessed && HTTPS_ONLY_FAILURES.has(errorCode) &&
          String(validatedURL).replace(/\/$/, '') === guessed.replace(/\/$/, '')) {
        this.wc.loadURL(guessed.replace(/^https:/, 'http:')).catch(() => {});
        return;
      }
      // The error entry sits at the address that failed, and no `did-navigate`
      // reports it: without this the bar keeps the previous page's address.
      this.url = validatedURL;
      this.showError(validatedURL, errorCode, errorDescription);
    });

    wc.on('render-process-gone', (_e, details) => {
      this.log(`tab ${this.id} renderer gone: ${details.reason} exitCode=${details.exitCode}`);
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
      this.applySuspendedPageState();
      this.emit('updated');
    });

    /*
     * Settings opens a notch larger than everything else.
     *
     * It is the one page here that is read rather than glanced at - rows of
     * labels with a hint under each - and it is where somebody goes when
     * something is hard to see, which is a poor moment to be squinting. The
     * rest of the browser's pages stay at 1.0, because the new tab page and the
     * tab strip beside it should not disagree about how big text is.
     *
     * After the document exists, not before the load: a zoom factor set on a
     * view that has not navigated yet is discarded by the navigation. Measured -
     * it read 1x - and it is why this is not three lines up in `realise`.
     *
     * `once`, so a zoom the user sets themselves survives whatever the page
     * does next, and set on the view rather than as a stylesheet scale, so
     * ctrl+wheel and the zoom shortcuts move from here rather than fighting it.
     */
    // A muted tab stays muted through a discard and its rebuild.
    if (this.muted) {
      try { wc.setAudioMuted(true); } catch { /* the view is going away */ }
    }

    wc.once('dom-ready', () => {
      if (pages.pageName(this.url) !== 'settings') return;
      try { wc.setZoomFactor(SETTINGS_ZOOM); } catch { /* the view is going away */ }
    });

    // Every load, not just the first. `once` above restores suspended state,
    // which must happen exactly once per renderer; this is the opposite - it
    // fires for each document, which is what anything reacting to "a page
    // finished loading" needs. A saved sign-in is never on a renderer's first
    // document, so hanging the fill off the `once` meant it never ran at all.
    wc.on('did-finish-load', () => this.emit('loaded'));

    // New windows open as tabs rather than popups.
    wc.setWindowOpenHandler(({ url }) => {
      this.emit('open-tab', { url });
      return { action: 'deny' };
    });
  }

  /**
   * Say, in the tab, why the page did not load. See error-page.js: drawn into
   * the error entry Chromium committed at the failed address, so the address
   * bar, Reload and Back all keep meaning what they did.
   */
  /** Bring `url` back to the committed address, if a navigation left it elsewhere. */
  reconcileUrl() {
    if (!this.isLive) return;
    const committed = this.wc.getURL();
    if (committed && committed !== this.url) {
      this.url = committed;
      this.emit('updated');
    }
  }

  showError(url, code, description) {
    this.failed = true;
    // The last page's icon is not this one's.
    this.favicon = null;
    errorPage.show(this.wc, { url, code, description }).then(() => this.emit('updated'));
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
    if (INCOGNITO && this.wc) fingerprint.release(this.wc);
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
    // `pid` needs no clearing: it is read from the webContents, which has just
    // gone, so it already answers null.
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
    // Incognito writes nothing to disk, and a thumbnail is a picture of a page.
    if (INCOGNITO) return null;
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

      // Asked again after the awaits. The tab may have closed meanwhile - its
      // `discardThumbnail` already ran, so a path recorded now would never be
      // deleted - or the page may have reported a password field, whose
      // picture must not stay on disk. Either way the file just written goes.
      // Closed, not merely discarded: a discarded tab is what the picture is
      // for, shown while it comes back.
      if (this.closed || this.hasSensitiveFields) {
        this.discardThumbnail();
        return null;
      }
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

  /**
   * Silence this tab, or let it speak again.
   *
   * Applied to the renderer when there is one and remembered either way, so the
   * answer survives the tab being discarded and rebuilt.
   */
  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.isLive) {
      try { this.wc.setAudioMuted(this.muted); } catch { /* gone */ }
    }
    return this.muted;
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
    // The screen a private page reports is its own letterboxed size.
    if (INCOGNITO && this.wc) fingerprint.setScreen(this, bounds);
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
      muted: this.muted,
      loading: this.loading,
      crashed: this.crashed,
      // The page did not load: no padlock, whatever the scheme says.
      failed: Boolean(this.failed),
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
      canGoForward: this.isLive ? this.wc.navigationHistory.canGoForward() : false,
      // For the badge in the address bar, which shows when a site is not at
      // the default size.
      zoom: this.isLive ? Math.round(this.wc.getZoomFactor() * 100) : 100
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
