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

class TabManager {
  /**
   * @param {object} options - { partition, onEvent, log }
   */
  constructor({
    partition = 'persist:debrowser',
    onEvent = () => {},
    onPresent = async () => {},
    log = () => {}
  } = {}) {
    this.session = electronSession.fromPartition(partition);
    this.onEvent = onEvent;
    /**
     * Called with a tab that is about to be shown, and awaited before it is.
     * The governor uses it to promote the tab out of whatever tier it was in -
     * crucially, to unfreeze it - while it is still off screen.
     */
    this.onPresent = onPresent;
    this.log = log;

    /** @type {Tab[]} - ordered as shown in the tab strip */
    this.tabs = [];
    this.activeId = null;

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
      onEvent: this.onEvent,
      log: this.log
    });

    if (index == null) this.tabs.push(tab);
    else this.tabs.splice(index, 0, tab);

    if (realise) tab.realise();
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
    if (previous && previous.id !== id) {
      previous.setVisible(false);
    }

    this.activeId = id;
    if (!tab.isLive) tab.realise();

    try {
      await this.onPresent(tab);
    } catch (err) {
      this.log(`present failed for tab ${tab.id}: ${err.message}`);
    }

    // The user may have switched away again while we were promoting.
    if (this.activeId !== id) return tab;

    tab.setVisible(true);
    this.onEvent(tab, 'activated');
    return tab;
  }

  close(id) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return false;

    const [tab] = this.tabs.splice(index, 1);
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
    this.activeId = null;
  }
}

module.exports = { TabManager };
