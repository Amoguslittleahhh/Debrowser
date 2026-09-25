'use strict';

/**
 * Owns the tab collection, activation order, and the shared browsing session.
 *
 * Two decisions here have a direct memory cost, so they live together:
 *
 *  - Every tab shares one `Electron.Session`, which means one HTTP cache, one
 *    cookie jar and one code cache across the whole browser instead of a set
 *    per partition. Chromium's disk and memory caches are sized per session,
 *    so partitioning tabs would multiply the most expensive shared structure
 *    in the browser for no benefit here.
 *
 *  - Tabs are created lazily where possible. A tab restored from a previous
 *    window, or one opened in the background, is left unrealised - no
 *    renderer, no process, no memory - until it is first shown.
 */

const { session: electronSession } = require('electron');
const { Tab } = require('./tab');
const pages = require('../pages');
const { Tier, isStopped } = require('../config');
const { LatencyTracker } = require('../latency');
const { kindsFor } = require('../site-permissions');

/**
 * How long a speculatively restored tab is allowed to stay resident before the
 * idle ladder takes it back. Long enough to cover a pointer that pauses, reads
 * the title and then clicks; short enough that a guess which did not pay off
 * costs one renderer for a few seconds rather than for the session.
 */
const SPECULATION_TTL_MS = 10_000;

/**
 * The one partition every tab runs in.
 *
 * Exported because `protocol.handle` registers per session: main has to give
 * the same string to pages.serve, and a second literal that drifted from this
 * one would silently reintroduce internal pages failing inside tabs while
 * working everywhere else.
 *
 * Incognito's has no `persist:` prefix, which is what keeps it in memory: a
 * persistent partition writes its cache, cookies and storage under the
 * profile, and the leak test found exactly that - a disk cache of every page
 * visited, sitting in the private profile until it was wiped.
 */
const BROWSING_PARTITION = require('../incognito/mode').INCOGNITO
  ? 'debrowser-incognito'
  : 'persist:debrowser';

class TabManager {
  /**
   * @param {object} options - { partition, onEvent, log }
   */
  constructor({
    cfg,
    partition = BROWSING_PARTITION,
    onEvent = () => {},
    onPresent = async () => {},
    onCover = () => false,
    onUncover = () => {},
    canSpeculate = () => true,
    applyZoom = () => {},
    // Incognito gives each tab a session of its own (see incognito/circuits.js);
    // everywhere else every tab shares the browsing partition.
    sessionFor = null,
    // Told about each session the first time a tab uses it, so what is
    // registered per session - our pages, downloads - reaches it.
    onNewSession = () => {},
    log = () => {}
  } = {}) {
    this.cfg = cfg;
    this.session = electronSession.fromPartition(partition);
    this.sessionFor = sessionFor;
    this.onNewSession = onNewSession;
    /** Sessions already given the permission policy. */
    this.configured = new WeakSet([this.session]);
    this.onEvent = onEvent;
    /**
     * Called with a tab that is about to be shown, and awaited before it is.
     * The governor uses it to promote the tab out of whatever tier it was in -
     * crucially, to unfreeze it - while it is still off screen.
     */
    this.onPresent = onPresent;
    /** Hands over a spare new tab page view, or null; set by main.js (prewarm.js). */
    this.takeSpare = null;
    /**
     * Show / take away the restore placeholder. The shell owns the view; the
     * tab manager owns the moment, because only it knows a restore is starting.
     * `onCover` reports whether a placeholder actually went up.
     */
    this.onCover = onCover;
    this.onUncover = onUncover;
    /**
     * Whether a speculative restore is affordable right now. Answered by the
     * governor, which owns pressure and the animation quiesce; see `speculate`.
     */
    this.canSpeculate = canSpeculate;
    /** Sets each new document's zoom; see zoom.js. */
    this.applyZoom = applyZoom;
    this.log = log;

    /** @type {Tab[]} - ordered as shown in the tab strip */
    this.tabs = [];
    this.activeId = null;

    /**
     * Tabs created with a renderer requested, but held back because too many
     * were already loading. See `admit`.
     * @type {Tab[]}
     */
    this.loadQueue = [];

    /** At most one speculative restore in flight. See `speculate`. */
    this.speculatingId = null;

    /**
     * What reclaim costs the user. Read by the governor's snapshot and asserted
     * in the smoke suite; see ../latency.js for why this is measured at all.
     */
    this.latency = new LatencyTracker();

    this.configureSession();
  }

  configureSession(ses = this.session) {
    /** The last few refusals, newest last - so a test can see one happened. */
    if (!this.deniedPermissions) this.deniedPermissions = [];
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      // Camera, microphone, location and notifications: asked of the user,
      // and remembered per site (site-permissions.js). Only in the ordinary
      // browser - a private window never sets `askPermission`, so there these
      // fall through to the refusal below with everything else.
      const kinds = kindsFor(permission, details);
      if (kinds && this.askPermission) {
        this.askPermission(wc, kinds, details, callback);
        return;
      }
      // Grant only what a page needs to function without user-visible prompts
      // this browser has no UI for; everything sensitive is denied. That
      // includes `openExternal`: a `mailto:` or `zoommtg:` link would start
      // another program, which in a private window means a connection that
      // does not go through Tor.
      const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
      const ok = allowed.has(permission);
      if (!ok) {
        this.deniedPermissions.push(permission);
        if (this.deniedPermissions.length > 20) this.deniedPermissions.shift();
      }
      callback(ok);
    });

    // What a page is told when it only asks whether it has a permission.
    // Electron's default says "granted" to everything, so a site read yes and
    // then had its request refused. For the four above, the truth: granted
    // only where the user allowed it. Chromium still sends the request when a
    // check says no, so this never stops a site from asking. Anything else
    // keeps the default.
    ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
      const kinds = kindsFor(permission, details?.mediaType ? { mediaTypes: [details.mediaType] } : {});
      if (!kinds) return true;
      return Boolean(this.permissionGranted && this.permissionGranted(origin, kinds));
    });
  }

  /* ---------------------------------------------------------------- */

  all() {
    return this.tabs;
  }

  byId(id) {
    return this.tabs.find((tab) => tab.id === id) || null;
  }

  activeTab() {
    return this.byId(this.activeId);
  }

  /**
   * Create a tab. `realise: false` leaves it as a placeholder holding no
   * renderer at all - the same state the governor discards a tab into - so
   * background and restored tabs cost nothing until they are first shown.
   */
  /**
   * The session a new tab runs in: its opener's, so a link opened from a
   * signed-in page is still signed in; or a new one where each tab gets its
   * own; or the shared browsing partition.
   */
  sessionForNew(opener) {
    const ses = (opener && opener.session) || (this.sessionFor ? this.sessionFor() : this.session);
    if (!this.configured.has(ses)) {
      this.configured.add(ses);
      this.configureSession(ses);
      this.onNewSession(ses);
    }
    return ses;
  }

  create({ url = 'about:blank', activate = true, realise = activate, index = null, opener = null } = {}) {
    const tab = new Tab({
      session: this.sessionForNew(opener),
      url,
      onEvent: (t, event, payload) => {
        // Finishing a load frees an admission slot for whatever is queued.
        if (event === 'updated' && !t.loading) this.pumpLoadQueue();
        this.onEvent(t, event, payload);
      },
      applyZoom: this.applyZoom,
      log: this.log
    });

    if (index == null) this.tabs.push(tab);
    else this.tabs.splice(index, 0, tab);

    // A new tab page takes the spare one if there is one waiting, already
    // loaded and drawn (prewarm.js); otherwise it is built as any tab is.
    const spare = realise && pages.pageName(url) === 'newtab' && this.takeSpare ? this.takeSpare() : null;
    if (spare) tab.adopt(spare);
    else if (realise) this.admit(tab);
    else tab.tier = Tier.DISCARDED;

    this.onEvent(tab, 'created');
    if (activate) {
      this.activate(tab.id).catch((err) => this.log(`activate failed: ${err.message}`));
    }
    return tab;
  }

  /**
   * Show a tab, realising it first if it was discarded.
   *
   * The order here matters and is the reason this is async. A frozen page has
   * its task queues stopped: it cannot run script, service a resize, or
   * repaint. Presenting it before it is unfrozen shows the user a stale frame
   * and resumes a compositor for a document that is still stopped. So the tab
   * is promoted to ACTIVE *while it is still off screen*, and only then made
   * visible.
   */
  async activate(id) {
    const tab = this.byId(id);
    if (!tab) return null;
    if (this.activeId === id && tab.isLive && tab.visible) return tab;

    const previous = this.activeTab();

    // Photograph the tab being left *before* hiding it. This is the only moment
    // its content is definitely on screen: a hidden view returns a stale frame
    // and a frozen one cannot paint at all, so a capture taken any later - at
    // discard time, say - would be of nothing worth showing.
    //
    // Issued but never awaited. The frame request is made against the view as
    // it stands now, and waiting for the encode would put disk I/O on the
    // tab-switch path, which is the one path in this browser that must stay
    // immediate.
    if (previous && previous.id !== id && previous.isLive) {
      previous.captureThumbnail().catch(() => {});
    }

    if (previous && previous.id !== id) {
      previous.setVisible(false);
    }

    // Timed from here rather than from the renderer being built, because this
    // is when the user asked. Which series the sample belongs to is decided at
    // the end: a restore and a switch are the same code path and differ only in
    // whether there was a renderer to begin with.
    const wasLive = tab.isLive;
    // A frozen tab is live, and promoting it costs a real CDP round trip to
    // restart its task queues. Counting that as a "switch" made one series out
    // of two different operations: switching to a running tab, which should be
    // immediate because there is nothing to do, and thawing one, which has
    // unavoidable work in it. The combined p95 was then whichever thaw happened
    // to be slowest, and said nothing about whether a switch blocks.
    const wasStopped = wasLive && isStopped(tab.tier);
    const stop = this.latency.start('switch');

    this.activeId = id;
    // Bypass the admission queue: the user is waiting on this one.
    const queued = this.loadQueue.indexOf(tab);
    if (queued !== -1) this.loadQueue.splice(queued, 1);
    if (!tab.isLive) {
      // Cover the gap before the renderer exists, not after: this is the whole
      // point, and a placeholder raised after realise() would already be late.
      const covered = this.onCover(tab);
      this.latency.record(covered ? 'placeholder' : 'uncovered', 0.1);
      tab.realise();
      this.timeToContent(tab, id);
      this.uncoverWhenReady(tab, id);
    }

    try {
      await this.onPresent(tab);
    } catch (err) {
      this.log(`present failed for tab ${tab.id}: ${err.message}`);
    }

    // The user may have switched away again while we were promoting. The sample
    // is still recorded: the work was done and the time was spent, and dropping
    // it would quietly exclude exactly the slow restores a user gave up on.
    const series = !wasLive ? 'restore' : (wasStopped ? 'thaw' : 'switch');

    if (this.activeId !== id) {
      stop(series);
      return tab;
    }

    tab.setVisible(true);
    stop(series);
    this.clearSpeculation(tab);
    this.onEvent(tab, 'activated');
    return tab;
  }

  /**
   * Take the placeholder away once the restored page has something to show.
   *
   * `did-stop-loading` rather than a true first-paint signal. Paint can lag it
   * slightly, so the theoretical worst case is a brief flash of the view's
   * background - which is now the chrome's surface colour rather than white, so
   * it reads as the browser rather than as a broken page. A double-rAF signal
   * from the probe preload would be exact; it is not worth an IPC round trip on
   * the tab-switch path until this proves visible.
   *
   * The shell's own ceiling is the backstop: every path that raises a
   * placeholder is guaranteed to lower it, including the ones here that never
   * fire because the renderer died first.
   */
  uncoverWhenReady(tab, id) {
    const wc = tab.wc;
    if (!wc) {
      this.onUncover();
      return;
    }
    const done = () => {
      // If the user has already moved on, the placeholder belongs to whatever
      // they moved to; leave it to that activation to clear.
      //
      // Except that only holds when the tab they moved to raised one of its
      // own. `activate` shows a placeholder only for a tab with no renderer, so
      // switching from a still-restoring tab to a live one left the previous
      // tab's screenshot sitting over a perfectly good page until the 1500ms
      // ceiling in window.js expired. Clearing it whenever the tab that is now
      // active is live costs nothing: a live tab has real content behind the
      // placeholder by definition.
      if (this.activeId === id) { this.onUncover(); return; }
      const current = this.byId(this.activeId);
      if (current && current.isLive) this.onUncover();
    };
    wc.once('did-stop-loading', done);
    wc.once('did-fail-load', done);
    wc.once('render-process-gone', done);
  }

  /**
   * Time a restore from activation until the page has finished loading.
   *
   * Separate from the `restore` series, which stops when the tab is on screen.
   * The gap between the two is the window a placeholder has to cover, so both
   * numbers are needed to know whether one is worth showing.
   *
   * Bounded by a timeout: a page that never finishes loading must not leave a
   * timer holding a reference to the tab, and must not be silently omitted
   * from the series either - it is recorded at the ceiling, which is the
   * honest reading of "the user never saw this load finish".
   */
  timeToContent(tab, id, ceilingMs = 10_000) {
    const stop = this.latency.start('content');
    const wc = tab.wc;
    if (!wc) return;

    const timer = setTimeout(() => {
      wc.removeListener('did-stop-loading', done);
      // `stop()` records and *then* becomes a no-op, so recording the ceiling
      // explicitly beside it put two samples in the series for one load, and
      // every timed-out load counted twice in the percentiles. Elapsed time at
      // the moment this timer fires is the ceiling, so stopping is all that
      // was ever needed - and it still consumes the stop, which is what keeps
      // the listener below from recording a third.
      stop();
    }, ceilingMs);
    if (typeof timer.unref === 'function') timer.unref();

    const done = () => {
      clearTimeout(timer);
      // Only counts while this is still the tab the user asked for; a restore
      // they navigated away from is not a measurement of restore latency.
      if (this.activeId === id) stop();
    };
    wc.once('did-stop-loading', done);
  }

  /**
   * Start restoring a discarded tab before the user has clicked it.
   *
   * A restore is measured at ~5ms to put the tab on screen but 40-110ms before
   * its content arrives - and that is against localhost fixtures. The pointer
   * resting on a tab is a good enough signal that the click is coming to spend
   * that window early, so the page is already loading by the time it lands.
   *
   * This is the one feature here that can *increase* memory, which is the
   * opposite of the point, so it is deliberately timid. Left ungoverned, a
   * pointer dragged across a strip of thirty tabs would rebuild renderers
   * faster than the governor reclaims them - so:
   *
   *   - at most one speculation is ever in flight;
   *   - it goes through `admit`, so the concurrent-load limit still applies;
   *   - the governor can refuse outright, under memory pressure or while
   *     anything is animating - a speculative page load must never be the
   *     reason a frame is dropped;
   *   - and it expires. A tab realised on a guess that the user never acted on
   *     is discarded again by the idle ladder, so a swept pointer cannot
   *     quietly leave a dozen resident renderers behind.
   */
  speculate(id) {
    const tab = this.byId(id);
    if (!tab || tab.isLive) return false;
    if (this.speculatingId !== null) return false;
    if (!this.canSpeculate()) return false;

    tab.speculativeUntil = Date.now() + SPECULATION_TTL_MS;
    this.speculatingId = id;
    this.admit(tab);
    this.latency.record('speculation', 0.1);
    return true;
  }

  /**
   * Called when a tab is activated for real, so a speculation that paid off
   * stops being treated as one - otherwise the idle ladder would discard the
   * tab the user is now looking at.
   */
  clearSpeculation(tab) {
    if (tab) tab.speculativeUntil = 0;
    this.speculatingId = null;
  }

  /** How many tabs are mid-load right now. */
  loadingCount() {
    return this.tabs.reduce((n, tab) => n + (tab.isLive && tab.loading ? 1 : 0), 0);
  }

  /**
   * Give a tab a renderer, or queue it if too many are already loading.
   *
   * Peak memory is a loading-time phenomenon: a page mid-load holds its parser,
   * its network buffers and its pre-compaction heap simultaneously, so ten tabs
   * opened together peak far above the same ten once settled. Admitting them a
   * few at a time flattens that peak, and costs nothing in total time - the
   * machine was never going to parse ten pages in parallel anyway.
   *
   * Activation always bypasses this: if the user is looking at the tab, it
   * loads now.
   */
  admit(tab) {
    if (tab.isLive) return;
    const limit = this.cfg.maxConcurrentLoads;
    if (limit && this.loadingCount() >= limit && !tab.visible) {
      if (!this.loadQueue.includes(tab)) this.loadQueue.push(tab);
      tab.tier = Tier.DISCARDED; // no renderer yet; indistinguishable from discarded
      return;
    }
    tab.realise();
  }

  /** Admit as many queued tabs as there is now room for. */
  pumpLoadQueue() {
    const limit = this.cfg.maxConcurrentLoads;
    while (this.loadQueue.length) {
      if (limit && this.loadingCount() >= limit) break;
      const tab = this.loadQueue.shift();
      // Skip tabs closed or already realised while they waited.
      if (!this.tabs.includes(tab) || tab.isLive) continue;
      tab.realise();
    }
  }

  close(id) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return false;

    const [tab] = this.tabs.splice(index, 1);
    const queued = this.loadQueue.indexOf(tab);
    if (queued !== -1) this.loadQueue.splice(queued, 1);
    // The governor's expiry clause only walks tabs that still exist, so a tab
    // closed while it was being speculated on left `speculatingId` set for the
    // rest of the session, and every later speculative restore was refused with
    // nothing in the log to say why. Only when it is *this* tab: closing any
    // other one used to free the slot while the speculated tab stayed resident.
    if (this.speculatingId === tab.id) this.clearSpeculation(tab);
    // A picture of the page must not outlive the tab it was taken from.
    tab.closed = true;
    tab.discardThumbnail();
    tab.teardownView();

    if (this.activeId === id) {
      const next = this.tabs[index] || this.tabs[index - 1] || null;
      this.activeId = null;
      if (next) this.activate(next.id).catch((err) => this.log(`activate failed: ${err.message}`));
    }

    this.onEvent(tab, 'closed');
    return true;
  }

  /**
   * Put a tab at `index` in the strip, as dragging it there does. Returns
   * whether anything moved.
   */
  move(id, index) {
    const from = this.tabs.findIndex((tab) => tab.id === id);
    if (from === -1 || !Number.isInteger(index)) return false;
    // Pinned tabs are a group at the start of the strip, and each kind stays
    // on its own side of the line.
    const pinnedOthers = this.tabs.filter((t) => t.pinned && t.id !== id).length;
    const lo = this.tabs[from].pinned ? 0 : pinnedOthers;
    const hi = this.tabs[from].pinned ? pinnedOthers : this.tabs.length - 1;
    const to = Math.max(lo, Math.min(index, hi));
    if (to === from) return false;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this.onEvent(tab, 'moved');
    return true;
  }

  /** Pin or unpin a tab, moving it to the edge of the pinned group. */
  setPinned(id, pinned) {
    const tab = this.byId(id);
    if (!tab) return;
    tab.pinned = Boolean(pinned);
    const edge = this.tabs.filter((t) => t.pinned && t !== tab).length;
    if (!this.move(id, edge)) this.onEvent(tab, 'updated');
  }

  /** Every live renderer, deduplicated by process. */
  rendererPids() {
    const pids = new Set();
    for (const tab of this.tabs) if (tab.pid) pids.add(tab.pid);
    return pids;
  }

  closeAll() {
    for (const tab of this.tabs) tab.teardownView();
    this.tabs = [];
    this.loadQueue = [];
    this.activeId = null;
  }
}

module.exports = { BROWSING_PARTITION, TabManager };
