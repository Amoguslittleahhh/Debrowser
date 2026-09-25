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
const path = require('path');
const { originOf } = require('./credentials');

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
    this.load();
  }

  load() {
    if (!this.file) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`site permissions: ${this.file} unreadable, starting empty (${err.message})`);
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    for (const [origin, entry] of Object.entries(parsed).slice(0, MAX_SITES)) {
      // Only what this file could have written: a website's origin, one of the
      // four kinds, one of the two answers.
      if (originOf(origin) !== origin || !entry || typeof entry !== 'object') continue;
      const clean = {};
      for (const [kind, value] of Object.entries(entry)) {
        if (kind in KINDS && (value === 'allow' || value === 'block')) clean[kind] = value;
      }
      if (Object.keys(clean).length) this.sites.set(origin, clean);
    }
  }

  save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sites), null, 2), { mode: 0o600 });
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
    if (!originOf(origin) || !(kind in KINDS)) return;
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
    if (answers.every((a) => a === 'allow')) return 'allow';
    return 'ask';
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
