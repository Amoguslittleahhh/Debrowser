'use strict';

/**
 * Bringing things over from the browser someone is leaving.
 *
 *   history    from a Chromium-family profile's `History` or a Firefox-family
 *              `places.sqlite` - the pages they have been to, so the address
 *              bar knows their sites on the first day rather than the tenth
 *   bookmarks  from a Firefox-family `places.sqlite` (Chromium-family ones are
 *              JSON, and bookmarks.js reads those itself)
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
    const rows = withCopy(file, (db) => (profile.kind === 'firefox'
      ? db.prepare(`SELECT url, title, visit_count AS visits, last_visit_date / 1000 AS at FROM moz_places
                    WHERE visit_count > 0 AND hidden = 0 AND last_visit_date IS NOT NULL
                    ORDER BY last_visit_date DESC LIMIT ${MAX_HISTORY}`).all()
      : db.prepare(`SELECT url, title, visit_count AS visits, last_visit_time / 1000 AS at FROM urls
                    WHERE hidden = 0 AND last_visit_time > 0
                    ORDER BY last_visit_time DESC LIMIT ${MAX_HISTORY}`).all()));
    const time = profile.kind === 'firefox' ? fromFirefox : fromChrome;
    const entries = [];
    for (const r of rows) {
      if (!/^https?:/i.test(r.url || '')) continue;
      const visitedAt = sane(time(r.at));
      if (!visitedAt) continue;
      entries.push({ url: r.url, title: r.title || '', visits: Math.max(1, Number(r.visits) || 1), visitedAt });
    }
    return { ok: true, entries };
  } catch (err) {
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

module.exports = { readHistory, readFirefoxBookmarks, parseLoginCsv, parseCsv };
