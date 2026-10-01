'use strict';

/**
 * Reading the profile's JSON files without ever losing one.
 *
 * Every store here (preferences, the session, bookmarks, spaces...) fell back
 * to its defaults when its file would not parse - a power cut mid-write on a
 * filesystem without atomic rename, a disk error, a hand edit gone wrong - and
 * its next save then wrote the defaults over the file. The data was gone,
 * silently, on the one machine where it existed.
 *
 * Bookmarks, history and credentials already moved such a file aside
 * (set-aside.js); `readJson` does the same for the rest, before the error
 * reaches the store's own fallback. And before a new version first runs, the whole profile's JSON is
 * copied into `Backups/<old version>/`, so an update that turns out to mangle
 * something can be rolled back with the data it started from.
 */

const fs = require('fs');
const path = require('path');

const { setAside } = require('./set-aside');

const KEEP_BACKUPS = 2;

/**
 * `JSON.parse(fs.readFileSync(file))`, except that a file that exists and
 * does not parse is quarantined before the error reaches the caller. Throws
 * exactly as the expression it replaces does, so callers' fallbacks are
 * unchanged.
 */
function readJson(file, log) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    setAside(file, log);
    throw err;
  }
}

/**
 * Copy the profile's JSON files to `Backups/<version>/` - once per version,
 * before the next version first writes to them. The newest two are kept.
 */
function backupProfile(userData, version, log = () => {}) {
  if (!userData || !/^[\w.-]{1,40}$/.test(String(version || ''))) return false;
  const root = path.join(userData, 'Backups');
  const dest = path.join(root, version);
  try {
    if (fs.existsSync(dest)) return false;
    const files = fs.readdirSync(userData).filter((f) => f.endsWith('.json'));
    if (!files.length) return false;
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(userData, f), path.join(dest, f));
    const kept = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, at: fs.statSync(path.join(root, d.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of kept.slice(KEEP_BACKUPS)) fs.rmSync(path.join(root, old.name), { recursive: true, force: true });
    log('store', `profile backed up to Backups/${version} (${files.length} files)`);
    return true;
  } catch (err) {
    log('store', `profile backup failed: ${err.message}`);
    return false;
  }
}

module.exports = { readJson, backupProfile };
