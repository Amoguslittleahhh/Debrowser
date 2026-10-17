'use strict';

/**
 * Which sites may use the camera, the microphone, the user's location and
 * notifications - asked once, then remembered.
 *
 * These four used to be refused outright, which kept everyone safe and made
 * every video call, map and chat app in the browser quietly broken, with
 * nothing on screen to say why. Now a site asks, the user answers in a small
 * panel under the padlock, and the answer holds for that site until they
 * change it there.
 *
 * Keyed by origin - scheme, host and port - never by host alone: allowing
 * the camera for https://example.com must not also allow it for the plain
 * http:// page on the same host, which anyone on the network could have
 * written.
 *
 * Never used in a private window. There, all four stay refused without
 * asking: a camera or a location is identifying in a way no amount of Tor
 * can hide.
 */

const fs = require('fs');
const { readJson } = require('./data/store-file');
const { setAside } = require('./set-aside');
const path = require('path');
const { originOf } = require('./data/credentials');

const FILE = 'site-permissions.json';

/** What the user is asked about, and how each reads in a sentence. */
const KINDS = {
  camera: 'Use your camera',
  microphone: 'Use your microphone',
  location: 'Know your location',
  notifications: 'Show notifications'
};

/** A site with more entries than this is a file we should not trust. */
const MAX_SITES = 5000;

/**
 * The kinds a Chromium permission request is about, or null when it is not
 * one of these four - the caller's own policy then decides it.
 */
function kindsFor(permission, details = {}) {
  if (permission === 'media') {
    const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const kinds = [];
    if (types.includes('video')) kinds.push('camera');
    if (types.includes('audio')) kinds.push('microphone');
    // A request naming neither is a check for both.
    return kinds.length ? kinds : ['camera', 'microphone'];
  }
  if (permission === 'geolocation') return ['location'];
  if (permission === 'notifications') return ['notifications'];
  return null;
}

class SitePermissions {
  /**
   * @param {(...args: any[]) => void} [log]
   * @param {string|null} dir - where the file lives; null keeps it in memory
   */
  constructor(log = () => {}, dir = null) {
    this.log = log;
    this.file = dir ? path.join(dir, FILE) : null;
    /** origin -> { kind: 'allow' | 'block' } */
    this.sites = new Map();
    /** origin -> when an allowed permission was last used (auto-revoke, below) */
    this.usedAt = new Map();
    /** What the last expiry took away, for the safety check to report. */
    this.revoked = [];
    this.load();
  }

  load() {
    if (!this.file) return;
    let parsed;
    try {
      parsed = readJson(this.file);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log(`site permissions: ${this.file} unreadable, starting empty (${err.message})`);
        if (err instanceof SyntaxError) setAside(this.file, this.log);
      }
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    for (const [origin, entry] of Object.entries(parsed).slice(0, MAX_SITES)) {
      // Only what this file could have written: a website's origin, one of the
      // four kinds, one of the two answers.
      if (originOf(origin) !== origin || !entry || typeof entry !== 'object') continue;
      const clean = {};
      for (const [kind, value] of Object.entries(entry)) {
        if (Object.hasOwn(KINDS, kind) && (value === 'allow' || value === 'block')) clean[kind] = value;
      }
      if (Object.keys(clean).length) this.sites.set(origin, clean);
      if (Number.isFinite(entry.usedAt)) this.usedAt.set(origin, entry.usedAt);
    }
  }

  save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    try {
      const out = {};
      for (const [origin, entry] of this.sites) {
        out[origin] = this.usedAt.has(origin) ? { ...entry, usedAt: this.usedAt.get(origin) } : entry;
      }
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log(`site permissions: could not save (${err.message})`);
    }
  }

  /** 'allow', 'block', or undefined for a question not yet answered. */
  get(origin, kind) {
    return this.sites.get(origin)?.[kind];
  }

  /** Everything decided for one site. */
  forOrigin(origin) {
    return { ...(this.sites.get(origin) || {}) };
  }

  /** Remember an answer; `null` forgets it, so the site asks again. */
  set(origin, kind, value) {
    if (!originOf(origin) || !Object.hasOwn(KINDS, kind)) return;
    const entry = { ...(this.sites.get(origin) || {}) };
    if (value === 'allow' || value === 'block') entry[kind] = value;
    else delete entry[kind];
    if (Object.keys(entry).length) this.sites.set(origin, entry);
    else this.sites.delete(origin);
    this.save();
  }

  /**
   * What the stored answers say about a request for `kinds`: 'allow' when
   * every one is allowed, 'block' when any is blocked, otherwise 'ask'.
   */
  decide(origin, kinds) {
    const answers = kinds.map((kind) => this.get(origin, kind));
    if (answers.some((a) => a === 'block')) return 'block';
    if (answers.every((a) => a === 'allow')) {
      this.markUsed(origin);
      return 'allow';
    }
    return 'ask';
  }

  /** An allowed permission was used. Written at most once a day per site. */
  markUsed(origin, now = Date.now()) {
    const last = this.usedAt.get(origin) || 0;
    this.usedAt.set(origin, now);
    if (now - last > 86_400_000) this.save();
  }

  /**
   * Chrome's safety check, done by itself: a site that has not used what it
   * was allowed for three months loses it, and asks again next time. A
   * refusal stays - nothing is gained by forgetting that. A site with no
   * record of use (from before this was kept) starts its three months now.
   * @returns {Array<{origin: string, kinds: string[]}>} what was taken away
   */
  expire(now = Date.now(), maxAgeMs = 90 * 86_400_000) {
    const revoked = [];
    let changed = false;
    for (const [origin, entry] of this.sites) {
      const allowed = Object.keys(entry).filter((kind) => entry[kind] === 'allow');
      if (!allowed.length) continue;
      if (!this.usedAt.has(origin)) { this.usedAt.set(origin, now); changed = true; continue; }
      if (now - this.usedAt.get(origin) < maxAgeMs) continue;
      const kept = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== 'allow'));
      if (Object.keys(kept).length) this.sites.set(origin, kept);
      else this.sites.delete(origin);
      this.usedAt.delete(origin);
      revoked.push({ origin, kinds: allowed });
      changed = true;
    }
    if (changed) this.save();
    if (revoked.length) this.revoked = revoked;
    return revoked;
  }

  /** Every site with a decision, for the safety check. */
  all() {
    return [...this.sites].map(([origin, entry]) => ({ origin, ...entry, usedAt: this.usedAt.get(origin) || null }));
  }
}

/**
 * The questions waiting for an answer, one queue per tab.
 *
 * A page asks, and the answer arrives later from the site panel - or never,
 * if the user closes it, switches away or leaves the page. Every question
 * ends in exactly one call to its callback: allowed, refused, or refused
 * because nobody answered.
 *
 * Closing the panel without answering refuses for now and remembers nothing,
 * but the same page cannot ask the same thing again until it navigates: a
 * site that re-asks the moment it is dismissed would otherwise hold the panel
 * open for as long as the user stays.
 */
class PermissionAsks {
  /**
   * @param {SitePermissions} store
   * @param {object} hooks
   * @param {(wc: object) => object|null} hooks.tabFor - the tab a webContents belongs to
   * @param {(tab: object) => boolean} hooks.isActive
   * @param {(tab: object) => void} hooks.show - put the question on screen
   * @param {(id: number) => object|null} [hooks.tabById]
   * @param {(tab: object) => void} [hooks.withdrawn] - the question on screen is void
   */
  constructor(store, { tabFor, tabById = () => null, isActive, show, withdrawn = () => {} }) {
    this.store = store;
    this.tabFor = tabFor;
    this.tabById = tabById;
    this.isActive = isActive;
    this.show = show;
    this.withdrawn = withdrawn;
    /** tab id -> [{origin, kinds, key, callbacks}] */
    this.pending = new Map();
    /** tab id -> Set of questions dismissed on the current page */
    this.dismissed = new Map();
    /** The question the panel is showing now, if any. */
    this.shown = null;
  }

  request(wc, kinds, details, callback) {
    const origin = originOf(details?.requestingUrl);
    const tab = this.tabFor(wc);
    // Only the site in the address bar may ask. A frame from somewhere else
    // would be borrowing the trust the user gives that site.
    if (!origin || !tab || originOf(tab.url) !== origin) { callback(false); return; }
    // A tab given the camera or microphone may be recording or in a call with
    // nobody speaking - not audible, and still not to be discarded. Marked
    // until it navigates away (tab.js), for the governor's protections.
    if ([...kinds].some((k) => k === 'camera' || k === 'microphone')) {
      const answer = callback;
      callback = (ok) => { if (ok) tab.capturing = true; answer(ok); };
    }

    const decision = this.store.decide(origin, kinds);
    if (decision !== 'ask') { callback(decision === 'allow'); return; }

    const key = `${origin} ${[...kinds].sort().join(',')}`;
    if (this.dismissed.get(tab.id)?.has(key)) { callback(false); return; }

    const queue = this.pending.get(tab.id) || [];
    // The same question twice while the first is waiting - a page calling
    // getUserMedia from two places - is answered once, for both.
    const same = queue.find((q) => q.key === key);
    if (same) { same.callbacks.push(callback); return; }
    queue.push({ origin, kinds, key, callbacks: [callback] });
    this.pending.set(tab.id, queue);
    if (queue.length === 1 && this.isActive(tab)) this.show(tab);
  }

  /** The question at the head of this tab's queue, as the panel draws it. */
  current(tab) {
    const head = tab && this.pending.get(tab.id)?.[0];
    return head ? { origin: head.origin, kinds: head.kinds } : null;
  }

  /** The panel drew this tab's question; closing it now would dismiss that. */
  markShown(tab) {
    const head = tab && this.pending.get(tab.id)?.[0];
    this.shown = head ? { tabId: tab.id, entry: head } : null;
  }

  /**
   * The user chose. Remembered for the site, and every waiting ask it settles
   * is answered.
   *
   * Only for the question the panel drew. The head of the queue is not good
   * enough: a page that navigated and asked again while the panel was up has
   * a new head, for another site, and the Allow pressed was for the old one.
   *
   * @returns {boolean} whether it answered anything
   */
  answer(tab, allow) {
    const shown = this.shown;
    const head = tab && this.pending.get(tab.id)?.[0];
    if (!head || !shown || shown.tabId !== tab.id || shown.entry !== head) return false;
    for (const kind of head.kinds) this.store.set(head.origin, kind, allow ? 'allow' : 'block');
    this.settle(tab);
    return true;
  }

  /** The panel closed without an answer. Refused for now; not asked again on this page. */
  dismissShown() {
    const shown = this.shown;
    this.shown = null;
    if (!shown) return;
    const queue = this.pending.get(shown.tabId);
    if (!queue || queue[0] !== shown.entry) return;      // already answered
    queue.shift();
    for (const callback of shown.entry.callbacks) callback(false);
    if (!this.dismissed.has(shown.tabId)) this.dismissed.set(shown.tabId, new Set());
    this.dismissed.get(shown.tabId).add(shown.entry.key);
    if (!queue.length) { this.pending.delete(shown.tabId); return; }
    // The next question, if the page asked more than one: left unshown it
    // waited, and the page's call with it, until the page was left.
    const tab = this.tabById(shown.tabId);
    if (tab && this.isActive(tab)) this.show(tab);
  }

  /** Answer everything in this tab's queue the stored answers now decide. */
  settle(tab) {
    const queue = this.pending.get(tab.id) || [];
    const left = [];
    for (const q of queue) {
      const decision = this.store.decide(q.origin, q.kinds);
      if (decision === 'ask') left.push(q);
      else for (const callback of q.callbacks) callback(decision === 'allow');
    }
    if (this.shown?.tabId === tab.id && !left.includes(this.shown.entry)) this.shown = null;
    if (left.length) this.pending.set(tab.id, left);
    else this.pending.delete(tab.id);
  }

  /** The page went away - navigated or closed. Nothing it asked is still a question. */
  forget(tab) {
    for (const q of this.pending.get(tab.id) || []) for (const callback of q.callbacks) callback(false);
    this.pending.delete(tab.id);
    this.dismissed.delete(tab.id);
    if (this.shown?.tabId === tab.id) {
      this.shown = null;
      this.withdrawn(tab);
    }
  }

  /** Whether this tab has a question waiting. */
  has(tab) {
    return Boolean(tab && this.pending.get(tab.id)?.length);
  }
}

module.exports = { SitePermissions, PermissionAsks, KINDS, kindsFor };
