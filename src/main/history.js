'use strict';

/**
 * Browsing history: what has been visited, and when.
 *
 * Storage follows `bookmarks.js`, which follows `prefs.js`: plain JSON under
 * `userData`, atomic tmp-and-rename writes, and a file hand-edited into
 * nonsense loads as empty rather than stopping the browser. It is deliberately
 * readable - history is the user's own record of their browsing and encrypting
 * it here would only hide it from them, since anything with access to the file
 * also has access to the key.
 *
 * Two departures from the bookmark store, both because this one is written by
 * the browser rather than by the user:
 *
 * **One row per URL, not one per visit.** A visit log is unbounded in exactly
 * the workload this browser is for - thirty tabs reloading through a day - and
 * this process is the one whose memory the whole project is about. So a repeat
 * visit moves the existing row to the front and increments a counter, which
 * keeps the store proportional to the number of distinct pages seen rather
 * than to the number of times they were seen. What is lost is being able to
 * ask "when did I read that, the first time"; what is kept is every page,
 * which is what the question "where was I yesterday" actually needs.
 *
 * **Writes are debounced.** Navigation fires far more often than a bookmark is
 * saved, and serialising a ten-thousand-entry file synchronously on each one
 * would put a disk write on the navigation path. Changes are held for a few
 * seconds and flushed together; `flush()` exists so quitting does not lose the
 * tail.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = 'history.json';

/**
 * How many distinct pages are remembered.
 *
 * Chrome keeps ninety days and prunes by age. This prunes by count instead,
 * because a count is what bounds the memory this process holds: the whole list
 * is resident while the browser runs. Ten thousand entries is roughly 1.5MB of
 * JSON, which is a fair price for a history that goes back months.
 */
const MAX_ENTRIES = 10_000;

/** Longest title kept; past this it is not a title. */
const MAX_TITLE = 400;

/** How long changes are held before the file is written. */
const SAVE_DELAY_MS = 4000;

/**
 * Schemes worth remembering.
 *
 * `debrowser:` is left out on purpose: a history full of "Settings" and "New
 * tab" is noise, and the pages are one keystroke away anyway. `javascript:`
 * and `data:` are refused for the reason the bookmark store refuses them - a
 * row in this list is one click from being navigated to.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'file:']);

function safeUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!SAFE_SCHEMES.has(parsed.protocol)) return null;
  return parsed.href;
}

/**
 * The icon address worth storing for a page, or null when it can be derived.
 *
 * `null` for anything that is the default `<origin>/favicon.ico`, for a
 * non-http(s) icon, or for anything unparseable - the history page falls back
 * to the derived address and then to the site's initial, so the cost of
 * returning null here is never a broken row.
 */
function customIcon(pageUrl, iconUrl) {
  if (typeof iconUrl !== 'string' || !iconUrl) return null;
  let icon, page;
  try {
    icon = new URL(iconUrl);
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  if (icon.protocol !== 'http:' && icon.protocol !== 'https:') return null;
  if (icon.href === `${page.origin}/favicon.ico`) return null;
  return icon.href.slice(0, 2048);
}

function cleanTitle(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  return text || fallback;
}

class History {
  /**
   * @param {(...args: any[]) => void} [log]
   * @param {{dir?: string, enabled?: () => boolean}} [options]
   */
  constructor(log = () => {}, { dir = null, enabled = () => true } = {}) {
    this.log = log;
    this.dir = dir || app.getPath('userData');
    this.file = path.join(this.dir, FILE);
    /** @type {() => boolean} read live, so turning recording off takes effect at once */
    this.enabled = enabled;
    /** @type {Array<{id:string, url:string, title:string, visitedAt:number, visits:number}>} */
    this.items = [];
    this.saveTimer = null;
    /** Whether anything has changed since the last write. See flush. */
    this.dirty = false;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;                       // no file yet is the normal first run
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.log(`history: ${this.file} is not valid JSON, starting empty (${err.message})`);
      return;
    }

    const list = Array.isArray(parsed) ? parsed : parsed && parsed.items;
    if (!Array.isArray(list)) return;

    this.items = list
      .map((entry) => this.normalise(entry))
      .filter(Boolean)
      .slice(0, MAX_ENTRIES);
  }

  normalise(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const url = safeUrl(entry.url);
    if (!url) return null;
    return {
      id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 64) : newId(),
      url,
      title: cleanTitle(entry.title, url),
      visitedAt: Number.isFinite(entry.visitedAt) ? entry.visitedAt : Date.now(),
      visits: Number.isFinite(entry.visits) && entry.visits > 0 ? Math.min(entry.visits, 1e6) : 1,
      // Present only for a site whose icon is somewhere other than the default
      // address; see `describe`. `undefined` rather than null, so it does not
      // appear in the file at all for the common case.
      ...(customIcon(url, entry.icon) ? { icon: customIcon(url, entry.icon) } : {})
    };
  }

  /**
   * Note a visit. Returns the stored entry, or null if this URL is not one we
   * keep - which is the normal answer for the browser's own pages.
   */
  record({ url, title } = {}) {
    if (!this.enabled()) return null;
    const clean = safeUrl(url);
    if (!clean) return null;

    const index = this.items.findIndex((e) => e.url === clean);
    if (index !== -1) {
      const [existing] = this.items.splice(index, 1);
      existing.visitedAt = Date.now();
      existing.visits += 1;
      // A later visit usually has the better title: the first one is often the
      // URL, recorded before the document announced its own name.
      existing.title = cleanTitle(title, existing.title);
      this.items.unshift(existing);
      this.queueSave();
      return existing;
    }

    const entry = this.normalise({ url: clean, title, visitedAt: Date.now(), visits: 1 });
    if (!entry) return null;
    this.items.unshift(entry);
    if (this.items.length > MAX_ENTRIES) this.items.length = MAX_ENTRIES;
    this.queueSave();
    return entry;
  }

  /**
   * Record what the page has since said about itself: its title, and where its
   * icon is.
   *
   * Both arrive after the navigation that created the entry - a document
   * announces its name and its icon once it has parsed - so without this every
   * row would read as its own address with no logo.
   *
   * The icon is stored only when it is *not* the one that could be worked out
   * from the address. Measured: Chromium reports `<origin>/favicon.ico` for
   * every page that declares nothing, which is the large majority, and storing
   * a string the history page can derive for itself would be tens of kilobytes
   * of duplicated address across a full store. A custom path is kept, because
   * that one cannot be guessed.
   */
  describe(url, { title, favicon } = {}) {
    const clean = safeUrl(url);
    if (!clean) return false;
    const entry = this.items.find((e) => e.url === clean);
    if (!entry) return false;

    let changed = false;

    if (typeof title === 'string' && title.trim()) {
      const next = cleanTitle(title, entry.title);
      if (next !== entry.title) { entry.title = next; changed = true; }
    }

    const icon = customIcon(clean, favicon);
    if (icon !== (entry.icon || null)) {
      if (icon) entry.icon = icon;
      else delete entry.icon;
      changed = true;
    }

    if (changed) this.queueSave();
    return changed;
  }

  /** Newest first, optionally filtered. `query` matches title or URL. */
  search(query = '', limit = 300) {
    const needle = String(query || '').trim().toLowerCase();
    const max = Math.min(Math.max(1, Number(limit) || 300), MAX_ENTRIES);
    const out = [];
    for (const entry of this.items) {
      if (needle &&
          !entry.title.toLowerCase().includes(needle) &&
          !entry.url.toLowerCase().includes(needle)) continue;
      out.push(entry);
      if (out.length >= max) break;
    }
    return out;
  }

  all() {
    return this.items.slice();
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((e) => e.id !== id);
    if (this.items.length === before) return false;
    this.queueSave();
    return true;
  }

  /** Forget everything, and write that immediately rather than in four seconds. */
  clear() {
    const removed = this.items.length;
    this.items = [];
    this.dirty = true;
    this.flush();
    return removed;
  }

  /* ---------------------------------------------------------------- */

  queueSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    // Never a reason to keep the process alive; the quit path flushes.
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  /** Write now, if anything is pending. Synchronous, so `before-quit` can use it. */
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    // Nothing to write is not a write. `before-quit` calls this on every exit,
    // and rewriting the file with its own contents on a session where nothing
    // was visited is pure risk: a crash mid-rename for no gain.
    if (!this.dirty) return true;
    this.dirty = false;

    const tmp = `${this.file}.tmp`;
    const body = JSON.stringify({ version: 1, items: this.items });
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      // Still unwritten, so still dirty: a full disk now must not mean the
      // next flush decides there is nothing to do.
      this.dirty = true;
      this.log(`history: could not save: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      return false;
    }
  }
}

let idCounter = 0;
function newId() {
  idCounter += 1;
  return `h-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

module.exports = { History, MAX_ENTRIES, safeUrl, customIcon };
