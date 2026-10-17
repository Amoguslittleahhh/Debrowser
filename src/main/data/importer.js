'use strict';

/**
 * Bringing things over from the browser someone is leaving.
 *
 *   history    from a Chromium-family profile's `History` or a Firefox-family
 *              `places.sqlite` - the pages they have been to, so the address
 *              bar knows their sites on the first day rather than the tenth
 *   bookmarks  from a Firefox-family `places.sqlite`, or Safari's
 *              `Bookmarks.plist` (Chromium-family ones are JSON, and
 *              bookmarks.js reads those itself)
 *   passwords  from the CSV file every browser and password manager exports
 *
 * The databases are read from a copy. The browser that owns them is often
 * running, holding them locked and writing to them; a copy taken first is a
 * consistent file nobody else is using, and the original is never opened.
 * Node's own SQLite (node:sqlite) reads it - nothing extra shipped.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_HISTORY = 5000;
const MAX_BOOKMARKS = 20000;
const MAX_LOGINS = 5000;

/*
 * Chromium stores microseconds since 1601; Firefox, microseconds since 1970.
 * Divided to milliseconds in the query itself: Chromium's figure is past the
 * largest integer a JavaScript number holds, and node:sqlite refuses to read it.
 */
const CHROME_EPOCH_OFFSET_MS = 11644473600000;
const fromChrome = (ms) => Number(ms) - CHROME_EPOCH_OFFSET_MS;
const fromFirefox = (ms) => Number(ms);
/* Safari: seconds since 2001 (Core Data's reference date). */
const SAFARI_EPOCH_OFFSET_MS = 978307200000;
const fromSafari = (seconds) => Number(seconds) * 1000 + SAFARI_EPOCH_OFFSET_MS;
const sane = (ms) => (Number.isFinite(ms) && ms > 0 && ms < Date.now() + 86_400_000 ? ms : null);

/**
 * Open a copy of a SQLite file (and its write-ahead log, if the owner has one
 * open) and hand it to `read`. The copy is deleted afterwards, whatever happens.
 */
function withCopy(file, read) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-import-'));
  const copy = path.join(dir, 'db.sqlite');
  let db = null;
  try {
    fs.copyFileSync(file, copy);
    for (const suffix of ['-wal', '-journal']) {
      if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, copy + suffix);
    }
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(copy, { readOnly: true });
    return read(db);
  } finally {
    try { db?.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The database a profile keeps its history in, from the file findProfiles located. */
function historyFile(profile) {
  if (profile.kind === 'firefox') return profile.path;                   // places.sqlite
  if (profile.kind === 'safari') return path.join(path.dirname(profile.path), 'History.db');
  return path.join(path.dirname(profile.path), 'History');             // beside Bookmarks
}

/**
 * The pages a profile has visited, newest first.
 * @returns {{ok: boolean, entries?: Array<{url, title, visits, visitedAt}>, reason?: string}}
 */
function readHistory(profile) {
  const file = historyFile(profile);
  if (!fs.existsSync(file)) return { ok: false, reason: `${profile.browser} has no history to bring over` };
  try {
    const queries = {
      firefox: `SELECT url, title, visit_count AS visits, last_visit_date / 1000 AS at FROM moz_places
                WHERE visit_count > 0 AND hidden = 0 AND last_visit_date IS NOT NULL
                ORDER BY last_visit_date DESC LIMIT ${MAX_HISTORY}`,
      safari: `SELECT i.url AS url, v.title AS title, i.visit_count AS visits, MAX(v.visit_time) AS at
               FROM history_items i JOIN history_visits v ON v.history_item = i.id
               GROUP BY i.id ORDER BY at DESC LIMIT ${MAX_HISTORY}`,
      chromium: `SELECT url, title, visit_count AS visits, last_visit_time / 1000 AS at FROM urls
                 WHERE hidden = 0 AND last_visit_time > 0
                 ORDER BY last_visit_time DESC LIMIT ${MAX_HISTORY}`
    };
    const rows = withCopy(file, (db) => db.prepare(queries[profile.kind] || queries.chromium).all());
    const time = { firefox: fromFirefox, safari: fromSafari }[profile.kind] || fromChrome;
    const entries = [];
    for (const r of rows) {
      if (!/^https?:/i.test(r.url || '')) continue;
      const visitedAt = sane(time(r.at));
      if (!visitedAt) continue;
      entries.push({ url: r.url, title: r.title || '', visits: Math.max(1, Number(r.visits) || 1), visitedAt });
    }
    return { ok: true, entries };
  } catch (err) {
    if (profile.kind === 'safari' && (err.code === 'EPERM' || err.code === 'EACCES')) return { ok: false, reason: SAFARI_LOCKED };
    return { ok: false, reason: `could not read ${profile.browser}'s history (${err.message})` };
  }
}

/** A Firefox-family profile's bookmarks, with the folder each is in. */
function readFirefoxBookmarks(profile) {
  try {
    const rows = withCopy(profile.path, (db) => db.prepare(
      `SELECT p.url AS url, b.title AS title, f.title AS folder, b.dateAdded / 1000 AS added
       FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk LEFT JOIN moz_bookmarks f ON f.id = b.parent
       WHERE b.type = 1 LIMIT ${MAX_BOOKMARKS}`).all());
    const entries = rows
      .filter((r) => /^https?:/i.test(r.url || ''))
      .map((r) => ({
        url: r.url,
        title: r.title || '',
        // Firefox's own top-level folders read as nothing to a person.
        folder: /^(menu|toolbar|unfiled|mobile)$/i.test(r.folder || '') ? '' : (r.folder || ''),
        addedAt: sane(fromFirefox(r.added)) || Date.now()
      }));
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, reason: `could not read ${profile.browser}'s bookmarks (${err.message})` };
  }
}

/* ------------------------------------------------------------------ */
/* Safari                                                              */
/* ------------------------------------------------------------------ */

/**
 * macOS keeps ~/Library/Safari from every app the user has not given Full
 * Disk Access. Said as what to do, with the way round it: Safari's own export
 * (File > Export Browsing Data) writes bookmarks as HTML and passwords as CSV,
 * both of which import from a file here.
 */
const SAFARI_LOCKED = 'macOS keeps Safari’s data private. Allow Debrowser in System Settings > Privacy & Security > ' +
  'Full Disk Access, or export from Safari (File > Export Browsing Data) and import that file';

/**
 * A binary property list (`bplist00`), as Safari writes Bookmarks.plist.
 * Enough of the format for that file: dictionaries, arrays, strings, numbers,
 * dates, booleans and data. Offsets are checked, so a damaged file throws
 * rather than reading past its end.
 */
function parseBinaryPlist(buf) {
  if (buf.length < 40 || buf.toString('latin1', 0, 8) !== 'bplist00') throw new Error('not a binary property list');
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer[6];
  const refSize = trailer[7];
  const count = Number(trailer.readBigUInt64BE(8));
  const top = Number(trailer.readBigUInt64BE(16));
  const tableAt = Number(trailer.readBigUInt64BE(24));
  if (count > 2_000_000 || tableAt + count * offsetSize > buf.length) throw new Error('damaged property list');
  const uint = (at, size) => {
    if (at + size > buf.length) throw new Error('damaged property list');
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[at + i];
    return v;
  };
  const offsets = Array.from({ length: count }, (_, i) => uint(tableAt + i * offsetSize, offsetSize));
  const seen = new Set();

  const read = (ref) => {
    if (ref >= count || seen.has(ref)) throw new Error('damaged property list');
    const at = offsets[ref];
    const marker = buf[at];
    const kind = marker >> 4;
    let info = marker & 0x0f;
    let start = at + 1;
    // A length of 15 means the real length follows, as an integer object.
    const length = () => {
      if (info !== 0x0f) return info;
      const size = 1 << (buf[start] & 0x0f);
      const n = uint(start + 1, size);
      start += 1 + size;
      return n;
    };
    switch (kind) {
      case 0x0: return info === 0x08 ? false : info === 0x09 ? true : null;
      case 0x1: return uint(start, 1 << info);
      case 0x2: return info === 2 ? buf.readFloatBE(start) : buf.readDoubleBE(start);
      case 0x3: return new Date(buf.readDoubleBE(start) * 1000 + SAFARI_EPOCH_OFFSET_MS);
      case 0x4: { const n = length(); return buf.subarray(start, start + n); }
      case 0x5: { const n = length(); return buf.toString('latin1', start, start + n); }
      case 0x6: {
        const n = length();
        const out = Buffer.from(buf.subarray(start, start + n * 2));
        out.swap16();
        return out.toString('utf16le');
      }
      case 0xa: {
        const n = length();
        seen.add(ref);
        const out = Array.from({ length: n }, (_, i) => read(uint(start + i * refSize, refSize)));
        seen.delete(ref);
        return out;
      }
      case 0xd: {
        const n = length();
        seen.add(ref);
        const out = {};
        for (let i = 0; i < n; i++) {
          const key = read(uint(start + i * refSize, refSize));
          out[String(key)] = read(uint(start + (n + i) * refSize, refSize));
        }
        seen.delete(ref);
        return out;
      }
      default: return null;
    }
  };
  return read(top);
}

/** Safari's bookmarks, with the folder each is in. The Reading List is left to Safari. */
function readSafariBookmarks(profile) {
  let root;
  try {
    root = parseBinaryPlist(fs.readFileSync(profile.path));
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return { ok: false, reason: SAFARI_LOCKED };
    return { ok: false, reason: `could not read Safari's bookmarks (${err.message})` };
  }
  const entries = [];
  const walk = (node, folder) => {
    if (!node || typeof node !== 'object' || entries.length >= MAX_BOOKMARKS) return;
    if (node.WebBookmarkType === 'WebBookmarkTypeLeaf') {
      const url = typeof node.URLString === 'string' ? node.URLString : '';
      if (/^https?:/i.test(url)) {
        const title = node.URIDictionary && typeof node.URIDictionary.title === 'string' ? node.URIDictionary.title : '';
        entries.push({ url, title, folder, addedAt: Date.now() });
      }
      return;
    }
    if (node.Title === 'com.apple.ReadingList') return;
    // Safari's own top-level lists - the bar and the menu - are where, not what.
    const own = /^(BookmarksBar|BookmarksMenu)$/.test(node.Title || '');
    const name = !node.Title || own ? folder : node.Title;
    for (const child of Array.isArray(node.Children) ? node.Children : []) walk(child, name);
  };
  walk(root, '');
  return { ok: true, entries };
}

/* ------------------------------------------------------------------ */
/* Passwords, from a CSV export                                        */
/* ------------------------------------------------------------------ */

/** RFC 4180, as exporters write it: quoted fields may hold commas, quotes and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ''));
}

/**
 * Which column is which. Every exporter names them a little differently:
 * Chrome and Edge `url,username,password`, Firefox the same in quotes, Safari
 * `URL,Username,Password`, Bitwarden `login_uri,login_username,login_password`,
 * 1Password `url,username,password` among others.
 */
const COLUMNS = {
  url: /^(url|website|login_uri|origin|web ?site|site)$/i,
  username: /^(username|user ?name|login|login_username|email)$/i,
  password: /^(password|login_password|pass)$/i
};

/**
 * Sign-ins from a CSV export, as { origin, username, password }.
 * @returns {{ok: boolean, logins?: object[], reason?: string}}
 */
function parseLoginCsv(text) {
  const rows = parseCsv(String(text || '').replace(/^﻿/, ''));
  if (rows.length < 2) return { ok: false, reason: 'the file has no sign-ins in it' };
  const header = rows[0].map((h) => h.trim());
  const at = {};
  for (const [key, re] of Object.entries(COLUMNS)) at[key] = header.findIndex((h) => re.test(h));
  if (at.url === -1 || at.password === -1) {
    return { ok: false, reason: 'that does not look like a password export (no url and password columns)' };
  }
  const logins = [];
  for (const r of rows.slice(1, MAX_LOGINS + 1)) {
    let origin = null;
    try {
      const u = new URL(r[at.url]);
      if (u.protocol === 'https:' || u.protocol === 'http:') origin = u.origin;
    } catch { /* an app entry, or no address: nothing a browser can fill */ }
    const password = r[at.password] || '';
    if (!origin || !password) continue;
    logins.push({ origin, username: at.username === -1 ? '' : (r[at.username] || ''), password });
  }
  return { ok: true, logins };
}

module.exports = { readHistory, readFirefoxBookmarks, readSafariBookmarks, parseBinaryPlist, parseLoginCsv, parseCsv };
