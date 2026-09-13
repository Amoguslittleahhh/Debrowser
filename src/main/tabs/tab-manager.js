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
const { Tier } = require('../config');
const { LatencyTracker } = require('../latency');

class TabManager {
  /**
   * @param {object} options - { partition, onEvent, log }
   */
  constructor({
    cfg,
    partition = 'persist:debrowser',
    onEvent = () => {},
    onPresent = async () => {},
    onCover = () => false,
    onUncover = () => {},
    log = () => {}
  } = {}) {
    this.cfg = cfg;
    this.session = electronSession.fromPartition(partition);
    this.onEvent = onEvent;
    /**
     * Called with a tab that is about to be shown, and awaited before it is.
     * The governor uses it to promote the tab out of whatever tier it was in -
     * crucially, to unfreeze it - while it is still off screen.
     */
    this.onPresent = onPresent;
    /**
     * Show / take away the restore placeholder. The shell owns the view; the
     * tab manager owns the moment, because only it knows a restore is starting.
     * `onCover` reports whether a placeholder actually went up.
     */
    this.onCover = onCover;
    this.onUncover = onUncover;
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

    /**
     * What reclaim costs the user. Read by the governor's snapshot and asserted
     * in the smoke suite; see ../latency.js for why this is measured at all.
     */
    this.latency = new LatencyTracker();

    this.configureSession();
  }

  configureSession() {
    this.session.setPermissionRequestHandler((_wc, permission, callback) => {
      // Grant only what a page needs to function without user-visible prompts
      // this prototype has no UI for; everything sensitive is denied.
      const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
      callback(allowed.has(permission));
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
  create({ url = 'about:blank', activate = true, realise = activate, index = null } = {}) {
    const tab = new Tab({
      session: this.session,
      url,
      onEvent: (t, event, payload) => {
        // Finishing a load frees an admission slot for whatever is queued.
        if (event === 'updated' && !t.loading) this.pumpLoadQueue();
        this.onEvent(t, event, payload);
      },
      log: this.log
    });

    if (index == null) this.tabs.push(tab);
    else this.tabs.splice(index, 0, tab);

    if (realise) this.admit(tab);
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
    if (this.activeId !== id) {
      stop(wasLive ? 'switch' : 'restore');
      return tab;
    }

    tab.setVisible(true);
    stop(wasLive ? 'switch' : 'restore');
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
      if (this.activeId === id) this.onUncover();
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
      this.latency.record('content', ceilingMs);
      stop();  // consumed, so the listener below cannot also record
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
    // A picture of the page must not outlive the tab it was taken from.
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

module.exports = { TabManager };
