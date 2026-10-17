'use strict';

/**
 * One Tor circuit per private tab.
 *
 * Each tab gets an in-memory partition of its own - its own cookies, cache and
 * storage - bound to one of Tor's SOCKS ports. Tor never lets streams from two
 * ports share a circuit, so two tabs never leave Tor from the same exit at the
 * same time, and a site that sees both cannot link them by address. Links a
 * tab opens share its partition and its circuit, so signing in and then
 * opening a link in a new tab keeps you signed in.
 *
 * A tab that goes to another site goes over another circuit too, as Tor
 * Browser gives each site its own: the exit that carried one site never sees
 * the next. The request for the new site waits until the tab is on its new
 * circuit, so nothing of it leaves on the old one.
 *
 * The limit, said plainly: while a tab has pages open that it opened - a
 * sign-in popup, say - they share one partition and so one circuit, and the
 * tab keeps it whatever site it goes to. Moving them would cut the other
 * page's connections mid-use, and they share cookies anyway.
 */

const { session, webContents } = require('electron');
const mode = require('./mode');
const policy = require('./policy');

/**
 * Slot 0 is the fallback for contexts not set up here. Slot 1 carried site
 * icons until each icon went over its own tab's circuit (main.js); it is kept
 * out of the rotation, so anything arriving on it is something gone astray.
 */
const FIRST_TAB_SLOT = 2;
/** Fresh circuits one blocked page gets before the user is told instead. */
const MAX_ROTATIONS = 3;
/** Enough of a page to find a challenge marker in; block pages are short. */
const READ_PAGE = 'String(document.title + "\\n" + (document.body ? document.body.innerText : "")).slice(0, 8000)';

class Circuits {
  constructor(ctx) {
    this.ctx = ctx;
    /** When each slot was last handed out; the oldest is reused first. */
    this.handedOut = new Map();
    this.count = 0;
    this.clock = 0;
    /** Per tab id: the address being retried and how many circuits it has had. */
    this.tries = new Map();
    /** Tabs whose page was still refused after every retry. */
    this.gaveUp = new Set();
    this.watched = new WeakSet();
    /** Per partition: the site its circuit has carried. */
    this.siteOn = new WeakMap();
    policy.onTopLevel((ses, details) => this.forSite(ses, details.url));
  }

  /** The site a top-level address belongs to, for circuits; null for non-network ones. */
  static siteKey(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (!/^(https?|wss?):$/.test(parsed.protocol)) return null;
    return policy.isOnion(url) ? parsed.hostname : policy.siteOf(parsed.hostname);
  }

  /**
   * A top-level request is about to leave a partition. If it is for another
   * site than the partition's circuit has carried, and nothing else is open
   * in the partition, the partition moves to a fresh circuit first.
   * Resolves to whether it moved.
   */
  async forSite(ses, url) {
    const site = Circuits.siteKey(url);
    if (!site) return false;
    const before = this.siteOn.get(ses);
    this.siteOn.set(ses, site);
    if (!before || before === site) return false;
    const open = webContents.getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && wc.session === ses && wc.getType() !== 'remote');
    if (open.length > 1) return false;
    await mode.setSlot(ses, this.ctx, this.nextSlot());
    try { ses.closeAllConnections(); } catch { /* older Electron */ }
    return true;
  }

  /**
   * The slot handed out longest ago, or never - among those no open page is
   * on. Reusing the oldest regardless put a long-lived tab (webmail, say) on
   * the same circuit as whatever site another tab moved to some twenty sites
   * later. Only with every slot held by an open page is one shared.
   */
  nextSlot() {
    const held = new Set();
    for (const wc of webContents.getAllWebContents()) {
      try {
        if (!wc.isDestroyed()) held.add(mode.slotOf(wc.session));
      } catch { /* gone */ }
    }
    let best = FIRST_TAB_SLOT;
    let bestAt = Infinity;
    for (const free of [true, false]) {
      for (let slot = FIRST_TAB_SLOT; slot < mode.POOL_SIZE; slot++) {
        if (free && held.has(slot)) continue;
        const at = this.handedOut.get(slot) ?? -1;
        if (at < bestAt) { best = slot; bestAt = at; }
      }
      if (bestAt !== Infinity) break;
    }
    this.handedOut.set(best, ++this.clock);
    return best;
  }

  /** A fresh partition on a fresh circuit, for a tab nothing opened. */
  newTabSession() {
    return mode.sessionWithSlot(session, `incognito-tab-${++this.count}`, this.nextSlot());
  }

  /**
   * Move a tab's partition to another circuit. Open connections are closed,
   * or keep-alive would carry the next request over the old one.
   */
  newCircuit(ses) {
    const slot = this.nextSlot();
    mode.configureSession(ses, this.ctx, slot);
    try { ses.closeAllConnections(); } catch { /* older Electron */ }
    return slot;
  }

  /**
   * A tab finished loading. If the site answered with what looks like a
   * refusal of Tor - a 403, 429 or 503 carrying a challenge or block page -
   * the tab moves to another circuit, and so another exit, and loads again.
   * At most MAX_ROTATIONS times for one address; after that the tab is
   * marked, so the window can say the site refuses Tor rather than loop.
   *
   * Resolves to 'ok', 'rotated' or 'gave-up'.
   */
  async checkBlocked(tab) {
    if (!tab.isLive) return 'ok';
    const wc = tab.wc;
    const id = wc.id;
    if (!this.watched.has(wc)) {
      this.watched.add(wc);
      wc.once('destroyed', () => policy.forget(id));
    }
    const url = wc.getURL();
    const status = policy.statusFor(id);
    let blocked = false;
    // The page is only read when the status already says "refused": most
    // loads never reach the renderer round trip.
    if (policy.BLOCK_STATUSES.has(status)) {
      const text = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: READ_PAGE }]).catch(() => '');
      blocked = !wc.isDestroyed() && wc.getURL() === url && policy.looksBlocked(status, text);
    }
    const tries = this.tries.get(tab.id);
    if (!blocked) {
      this.forgetTab(tab.id);
      return 'ok';
    }
    const n = tries && tries.url === url ? tries.n : 0;
    if (n >= MAX_ROTATIONS) {
      this.gaveUp.add(tab.id);
      return 'gave-up';
    }
    this.tries.set(tab.id, { url, n: n + 1 });
    this.gaveUp.delete(tab.id);
    this.newCircuit(tab.session);
    wc.reload();
    return 'rotated';
  }

  /** Whether this tab's page refused every circuit it was given. */
  refused(tabId) {
    return this.gaveUp.has(tabId);
  }

  forgetTab(tabId) {
    this.tries.delete(tabId);
    this.gaveUp.delete(tabId);
  }
}

module.exports = { Circuits, FIRST_TAB_SLOT, MAX_ROTATIONS };
