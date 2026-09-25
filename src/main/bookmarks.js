'use strict';

/**
 * Bookmarks, on disk, and the importers that fill them from other browsers.
 *
 * Follows `prefs.js` for storage: `userData`, which an update does not touch,
 * atomic tmp-and-rename writes, and a file that has been hand-edited into
 * nonsense loads as empty rather than stopping the browser. It does *not*
 * follow `credentials.js` - a bookmark is not a secret, so it is plain JSON
 * that the user can read, diff and edit, which is a feature.
 *
 * ## Importing
 *
 * Every browser worth importing from can export the Netscape bookmark file:
 * the `<!DOCTYPE NETSCAPE-Bookmark-file-1>` HTML that Netscape Navigator wrote
 * in 1996 and that Chrome, Firefox, Edge, Safari, Arc, Zen, Vivaldi, Brave and
 * Opera have all matched ever since. Supporting that one format covers every
 * browser including the niche ones, which is the point: Zen needs no Zen-
 * specific code, because Zen exports the same file Firefox does.
 *
 * It is parsed with a tokeniser rather than a DOM, and the reason is not
 * performance. This is an *untrusted file* - an attacker-authored bookmarks
 * export is a plausible thing to be handed - and building a DOM from it in the
 * browser process would mean running a parser over hostile input next to
 * everything that matters. A regex tokeniser over a known-shaped file cannot
 * execute anything, and the only fields taken are the href and the text.
 *
 * Reading another browser's profile directly - Firefox's `places.sqlite`,
 * Chromium's `Bookmarks` JSON - is supported where it can be done *safely*.
 * The Chromium file is JSON and is read directly. `places.sqlite` is not: it
 * is a live SQLite database, often locked by a running Firefox, and parsing it
 * would mean shipping an SQLite reader to avoid asking the user to click
 * Export. `findProfiles` locates it and names it, so the user is told where
 * their bookmarks are and what to export, rather than being told "not
 * supported".
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const FILE = 'bookmarks.json';

/** A bookmark bar with more than this many entries is a file we should not trust. */
const MAX_BOOKMARKS = 50_000;

/** Longest title kept. Anything past this is decoration, and a megabyte of it is an attack. */
const MAX_TITLE = 400;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Schemes a bookmark may carry.
 *
 * `javascript:` is the reason this list exists. A "bookmarklet" in an imported
 * file is script that runs in whatever page is open when it is clicked, with
 * that page's origin - so importing someone else's bookmarks would be importing
 * their code. `file:` and `data:` are refused for the same class of reason.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'debrowser:']);

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

function cleanTitle(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  // Collapse whitespace so a title spanning lines in the source file does not
  // span lines in the strip.
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  return text || fallback;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

class Bookmarks {
  /**
   * @param {(...args: any[]) => void} [log]
   * @param {string} [dir] - override for tests
   */
  constructor(log = () => {}, dir = null) {
    this.log = log;
    this.dir = dir || app.getPath('userData');
    this.file = path.join(this.dir, FILE);
    /** @type {Array<{id:string, url:string, title:string, folder:string, addedAt:number}>} */
    this.items = [];

    /**
     * Bumped on every successful write.
     *
     * The bookmarks bar lives in the chrome, which learns about everything else
     * from the state broadcast - and that broadcast reaches three views on every
     * governor tick. Putting the list itself in it would send the user's whole
     * bookmark collection twice a second on the chance the bar is showing, which
     * is the thing this file's neighbours refuse to do with the credential list
     * for the same reason. A number is enough: the bar re-asks only when it
     * changes.
     */
    this.revision = 0;
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
      // Same posture as prefs: a corrupt file must not stop the browser. It is
      // kept rather than overwritten, because it is the user's data and a
      // failed parse here is more likely our bug than their editing.
      this.log(`bookmarks: ${this.file} is not valid JSON, starting empty (${err.message})`);
      return;
    }

    const list = Array.isArray(parsed) ? parsed : parsed && parsed.items;
    if (!Array.isArray(list)) return;

    this.items = list
      .map((entry) => this.normalise(entry))
      .filter(Boolean)
      .slice(0, MAX_BOOKMARKS);
  }

  /** One entry, validated. Returns null for anything that fails. */
  normalise(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const url = safeUrl(entry.url);
    if (!url) return null;
    return {
      id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 64) : newId(),
      url,
      title: cleanTitle(entry.title, url),
      folder: cleanTitle(entry.folder, '') || '',
      addedAt: Number.isFinite(entry.addedAt) ? entry.addedAt : Date.now()
    };
  }

  save() {
    // Incognito reads the normal profile's bookmarks and never writes them.
    if (this.readOnly) return;
    const tmp = `${this.file}.tmp`;
    const body = JSON.stringify({ version: 1, items: this.items }, null, 2);
    try {
      // Written and renamed rather than truncated in place: an interrupted
      // write would otherwise leave half a file, and half a JSON file is no
      // bookmarks at all.
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.revision += 1;
      // The bar and Settings learn of it now rather than at the next tick; the
      // star waited up to two seconds for its bookmark to appear.
      if (this.onChange) this.onChange();
      return true;
    } catch (err) {
      this.log(`bookmarks: could not save: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      return false;
    }
  }

  all() {
    return this.items.slice();
  }

  has(url) {
    const clean = safeUrl(url);
    return clean ? this.items.some((b) => b.url === clean) : false;
  }

  /**
   * Add one, or move it to the front if it is already there.
   * @returns {object|null} the stored entry, or null if the URL is not storable
   */
  add({ url, title, folder } = {}) {
    const entry = this.normalise({ url, title, folder, addedAt: Date.now() });
    if (!entry) return null;
    if (this.items.length >= MAX_BOOKMARKS) return null;

    const existing = this.items.findIndex((b) => b.url === entry.url);
    if (existing !== -1) {
      // Keep the id, so anything holding a reference to it still resolves -
      // and its place on the bar.
      entry.id = this.items[existing].id;
      this.items[existing] = entry;
    } else {
      // At the end of the bar, as in every browser. Added at the start, each
      // new bookmark pushed the ones already there towards the overflow.
      this.items.push(entry);
    }
    this.save();
    return entry;
  }

  /**
   * Edit one in place.
   *
   * Separate from `add`, which is the star's operation and moves an entry to
   * the front when it is saved again. An edit keeps the entry where it is:
   * correcting a title should not reorder the bar under the user's pointer.
   * The id and the date it was saved survive; everything else is re-validated,
   * so an edited URL is held to the same scheme rules as an imported one.
   *
   * @returns {object|null} the stored entry, or null if there is no such
   *   bookmark, or the new URL is one we will not store
   */
  update(id, { url, title, folder } = {}) {
    const index = this.items.findIndex((b) => b.id === id);
    if (index === -1) return null;
    const current = this.items[index];

    const entry = this.normalise({
      id: current.id,
      addedAt: current.addedAt,
      url: url === undefined ? current.url : url,
      title: title === undefined ? current.title : title,
      folder: folder === undefined ? current.folder : folder
    });
    if (!entry) return null;

    // Two bookmarks for one address is the state `add` already refuses, and an
    // edit is the other way of reaching it.
    if (this.items.some((b, i) => i !== index && b.url === entry.url)) return null;

    this.items[index] = entry;
    this.save();
    return entry;
  }

  remove(idOrUrl) {
    const before = this.items.length;
    const url = safeUrl(idOrUrl);
    this.items = this.items.filter((b) => b.id !== idOrUrl && (!url || b.url !== url));
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  /**
   * Merge in a list of parsed entries, skipping URLs already held.
   * @returns {{added:number, skipped:number}}
   */
  merge(entries) {
    let added = 0;
    let skipped = 0;
    const seen = new Set(this.items.map((b) => b.url));

    for (const raw of entries) {
      if (this.items.length >= MAX_BOOKMARKS) { skipped++; continue; }
      const entry = this.normalise(raw);
      if (!entry || seen.has(entry.url)) { skipped++; continue; }
      seen.add(entry.url);
      // Appended, not unshifted: an import of two thousand bookmarks should not
      // bury what the user saved by hand this morning.
      this.items.push(entry);
      added++;
    }

    if (added) this.save();
    return { added, skipped };
  }
}

let idCounter = 0;
function newId() {
  idCounter += 1;
  return `bm-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/* ------------------------------------------------------------------ */
/* Import: Netscape bookmark HTML                                      */
/* ------------------------------------------------------------------ */

/**
 * Parse the Netscape bookmark file every browser exports.
 *
 * Shape, after thirty years of everyone copying Netscape:
 *
 *     <DL><p>
 *       <DT><H3>Folder name</H3>
 *       <DL><p>
 *         <DT><A HREF="https://example.com" ADD_DATE="1700000000">Title</A>
 *       </DL><p>
 *     </DL><p>
 *
 * Tokenised rather than parsed into a DOM, deliberately - see this file's
 * header. Folder nesting is tracked with a depth counter over `<DL>`/`</DL>`
 * so an entry keeps the name of the folder it was in, which is the only part
 * of the hierarchy worth carrying into a flat list.
 *
 * @param {string} html
 * @returns {Array<{url:string, title:string, folder:string, addedAt:number}>}
 */
function parseNetscape(html) {
  if (typeof html !== 'string') return [];

  const out = [];
  const folders = [];
  // One pass, one expression: folder openers, list open/close, and anchors.
  // `[^]` rather than `.` so a title broken across lines still matches.
  const token = /<DL[^>]*>|<\/DL>|<H3[^>]*>([^]*?)<\/H3>|<A\s+([^>]*)>([^]*?)<\/A>/gi;

  let match;
  let pendingFolder = null;
  while ((match = token.exec(html)) !== null) {
    const [text, h3, attrs, label] = match;

    if (/^<DL/i.test(text)) {
      // A <DL> immediately after an <H3> is that heading's contents.
      folders.push(pendingFolder || '');
      pendingFolder = null;
      continue;
    }
    if (/^<\/DL/i.test(text)) {
      folders.pop();
      continue;
    }
    if (h3 !== undefined) {
      pendingFolder = decodeEntities(stripTags(h3));
      continue;
    }

    const href = /HREF\s*=\s*"([^"]*)"/i.exec(attrs || '')
      || /HREF\s*=\s*'([^']*)'/i.exec(attrs || '');
    if (!href) continue;

    const added = /ADD_DATE\s*=\s*"?(\d+)"?/i.exec(attrs || '');
    out.push({
      url: decodeEntities(href[1]),
      title: decodeEntities(stripTags(label || '')),
      folder: folders.filter(Boolean).join(' / '),
      // Netscape writes seconds; some exporters write milliseconds. Anything
      // past the year 3000 in seconds is milliseconds being mislabelled.
      addedAt: added ? normaliseDate(Number(added[1])) : Date.now()
    });

    if (out.length >= MAX_BOOKMARKS) break;
  }

  return out;
}

function stripTags(text) {
  return text.replace(/<[^>]*>/g, '');
}

/**
 * The five entities that actually appear in these files.
 *
 * Numeric forms are handled too, because exporters differ. Deliberately not a
 * general HTML entity table: this runs over untrusted input and a smaller
 * surface is the point.
 */
function decodeEntities(text) {
  return text
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    // Ampersand last, or "&amp;lt;" would decode twice and turn into "<".
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function normaliseDate(value) {
  if (!Number.isFinite(value) || value <= 0) return Date.now();
  // Seconds if it looks like seconds, milliseconds if it looks like
  // milliseconds. 1e11 seconds is the year 5138; 1e11 ms is 1973.
  const ms = value > 1e11 ? value : value * 1000;
  return ms > 0 && ms < 4102444800000 ? ms : Date.now();
}

/* ------------------------------------------------------------------ */
/* Import: Chromium's Bookmarks file                                   */
/* ------------------------------------------------------------------ */

/**
 * Parse a Chromium-family `Bookmarks` file (Chrome, Edge, Brave, Vivaldi,
 * Opera, Arc). It is plain JSON with a `roots` object of nested nodes.
 *
 * @param {string} json
 * @returns {Array<{url:string, title:string, folder:string, addedAt:number}>}
 */
function parseChromium(json) {
  let doc;
  try {
    doc = JSON.parse(json);
  } catch {
    return [];
  }
  const roots = doc && doc.roots;
  if (!roots || typeof roots !== 'object') return [];

  const out = [];
  const walk = (node, trail) => {
    if (!node || typeof node !== 'object' || out.length >= MAX_BOOKMARKS) return;
    if (node.type === 'url' && typeof node.url === 'string') {
      out.push({
        url: node.url,
        title: typeof node.name === 'string' ? node.name : node.url,
        folder: trail.filter(Boolean).join(' / '),
        addedAt: chromeTime(node.date_added)
      });
      return;
    }
    if (Array.isArray(node.children)) {
      const next = node.name ? trail.concat(node.name) : trail;
      for (const child of node.children) walk(child, next);
    }
  };

  for (const key of Object.keys(roots)) walk(roots[key], []);
  return out;
}

/**
 * Chromium timestamps are microseconds since 1601-01-01, not the Unix epoch.
 * Read as Unix seconds they land in 1970 and every imported bookmark claims to
 * be older than the web.
 */
const CHROME_EPOCH_OFFSET_MS = 11644473600000;
function chromeTime(value) {
  const micro = Number(value);
  if (!Number.isFinite(micro) || micro <= 0) return Date.now();
  const ms = micro / 1000 - CHROME_EPOCH_OFFSET_MS;
  return ms > 0 && ms < 4102444800000 ? ms : Date.now();
}

/* ------------------------------------------------------------------ */
/* Finding other browsers' profiles                                    */
/* ------------------------------------------------------------------ */

/**
 * Where the browsers on this machine keep their bookmarks.
 *
 * Covers the niche ones on purpose. Zen, Floorp, Waterfox and LibreWolf are
 * Firefox forks and keep a `profiles.ini` beside `places.sqlite` in exactly
 * Firefox's layout; Arc, Brave, Vivaldi and Opera are Chromium forks with
 * Chromium's `Bookmarks` file. Neither list needs per-browser parsing - only
 * per-browser *paths*.
 *
 * @returns {Array<{browser:string, kind:'chromium'|'firefox', path:string}>}
 */
function findProfiles() {
  const home = os.homedir();
  const found = [];

  const chromiumRoots = {
    win32: {
      Chrome: ['AppData', 'Local', 'Google', 'Chrome', 'User Data'],
      Edge: ['AppData', 'Local', 'Microsoft', 'Edge', 'User Data'],
      Brave: ['AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'],
      Vivaldi: ['AppData', 'Local', 'Vivaldi', 'User Data'],
      Opera: ['AppData', 'Roaming', 'Opera Software', 'Opera Stable'],
      Arc: ['AppData', 'Local', 'Packages', 'TheBrowserCompany.Arc', 'LocalCache', 'Local', 'Arc', 'User Data']
    },
    darwin: {
      Chrome: ['Library', 'Application Support', 'Google', 'Chrome'],
      Edge: ['Library', 'Application Support', 'Microsoft Edge'],
      Brave: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'],
      Vivaldi: ['Library', 'Application Support', 'Vivaldi'],
      Arc: ['Library', 'Application Support', 'Arc', 'User Data']
    },
    linux: {
      Chrome: ['.config', 'google-chrome'],
      Chromium: ['.config', 'chromium'],
      Brave: ['.config', 'BraveSoftware', 'Brave-Browser'],
      Vivaldi: ['.config', 'vivaldi'],
      Edge: ['.config', 'microsoft-edge']
    }
  }[process.platform] || {};

  for (const [browser, parts] of Object.entries(chromiumRoots)) {
    const root = path.join(home, ...parts);
    // Chromium keeps one Bookmarks file per profile directory, and the profile
    // someone actually uses is often not Default.
    for (const profile of ['Default', 'Profile 1', 'Profile 2', 'Profile 3', '']) {
      const file = profile ? path.join(root, profile, 'Bookmarks') : path.join(root, 'Bookmarks');
      if (exists(file)) {
        found.push({ browser: profile ? `${browser} (${profile})` : browser, kind: 'chromium', path: file });
      }
    }
  }

  const firefoxRoots = {
    win32: {
      Firefox: ['AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'],
      Zen: ['AppData', 'Roaming', 'zen', 'Profiles'],
      Floorp: ['AppData', 'Roaming', 'Floorp', 'Profiles'],
      Waterfox: ['AppData', 'Roaming', 'Waterfox', 'Profiles'],
      LibreWolf: ['AppData', 'Roaming', 'librewolf', 'Profiles']
    },
    darwin: {
      Firefox: ['Library', 'Application Support', 'Firefox', 'Profiles'],
      Zen: ['Library', 'Application Support', 'zen', 'Profiles'],
      LibreWolf: ['Library', 'Application Support', 'librewolf', 'Profiles']
    },
    linux: {
      Firefox: ['.mozilla', 'firefox'],
      Zen: ['.zen'],
      Floorp: ['.floorp'],
      LibreWolf: ['.librewolf']
    }
  }[process.platform] || {};

  for (const [browser, parts] of Object.entries(firefoxRoots)) {
    const root = path.join(home, ...parts);
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'places.sqlite');
      if (exists(file)) found.push({ browser: `${browser} (${entry.name})`, kind: 'firefox', path: file });
    }
  }

  return found;
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Read one of the files `findProfiles` located.
 *
 * Firefox-family profiles are found and named but not read: `places.sqlite` is
 * a live SQLite database, usually locked while the browser is running, and
 * reading it would mean shipping an SQLite parser to save the user one Export
 * click. The refusal names the browser and the file, so the answer is "export
 * from Zen and open the file" rather than "unsupported".
 *
 * @returns {{ok:boolean, entries?:Array<object>, reason?:string}}
 */
function readProfile(profile) {
  if (!profile || typeof profile.path !== 'string') {
    return { ok: false, reason: 'no profile given' };
  }
  if (profile.kind === 'firefox') {
    return {
      ok: false,
      reason: `${profile.browser} stores bookmarks in a SQLite database that is locked while it ` +
              'is running. Export them from that browser (Bookmarks → Manage → Export to HTML) ' +
              'and open the file here.'
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(profile.path, 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not read ${profile.path}: ${err.message}` };
  }
  return { ok: true, entries: parseChromium(raw) };
}

/** Parse an exported file by looking at it, rather than trusting its extension. */
function parseExport(text) {
  if (typeof text !== 'string') return [];
  const head = text.slice(0, 4096);
  if (/NETSCAPE-Bookmark-file|<DT>|<A\s+HREF/i.test(head)) return parseNetscape(text);
  if (/^\s*\{/.test(head)) return parseChromium(text);
  // Neither marker, but a file full of anchors is still a bookmark file.
  return parseNetscape(text);
}

module.exports = {
  Bookmarks,
  parseNetscape,
  parseChromium,
  parseExport,
  findProfiles,
  readProfile,
  safeUrl,
  SAFE_SCHEMES
};
