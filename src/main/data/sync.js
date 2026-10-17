'use strict';

/**
 * Sync through a folder the user already syncs.
 *
 * There is no Debrowser server, and this does not add one. The user picks a
 * folder that something else already copies between their computers - iCloud
 * Drive, OneDrive, Dropbox, Google Drive, Syncthing, a network share - and each
 * Debrowser writes what it has there, encrypted, and reads what the others
 * wrote. The folder's owner moves the files; nobody else can read them.
 *
 *   <folder>/Debrowser Sync/sync.json           the salt, and a check that a
 *                                              passphrase is the right one
 *   <folder>/Debrowser Sync/devices/<id>.json   one computer's bookmarks,
 *                                              reading list and settings
 *
 * Each computer writes only its own file, so two of them saving at once never
 * write the same file - the case where a synced folder makes "conflicted copy"
 * files and one side's work is lost. What one computer has, the others take
 * in; what it deleted, it lists, with when, so a bookmark deleted on the
 * laptop goes from the desktop too rather than being copied straight back
 * from it - unless the desktop saved it again after that. Edits to a
 * bookmark's title or folder travel as changes since a computer last looked.
 * The first time two computers meet, nothing is removed: their bookmarks are
 * combined.
 *
 * Encrypted with AES-256-GCM under a key made from the sync passphrase
 * (scrypt). The passphrase itself is never stored; the key is, sealed by the
 * operating system's keystore, so syncing carries on across restarts without
 * asking again. Passwords and cards are not synced.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR_NAME = 'Debrowser Sync';
const LOCAL_FILE = 'sync.json';
const KEY_FILE = 'sync-key.dat';
const CHECK_TEXT = 'debrowser-sync-v1';
const DEVICE_FILE = /^[a-f0-9]{16}\.json$/;
const MIN_PASSPHRASE = 8;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** How long a deletion is remembered: longer than any computer is likely to sit unsynced. */
const TOMBSTONE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The settings that follow you between computers: how the browser looks and
 * behaves. Not what belongs to one machine - its memory budget, graphics,
 * download folder, window position - or anything to do with private windows.
 */
const SYNCED_PREFS = [
  'theme', 'design', 'accent', 'accentFromSystem', 'tabWidth', 'tabBarColor', 'tabBarPosition', 'reduceMotion',
  'darkWebsites', 'hoverCards', 'autoPip', 'continueCard', 'hiddenTiles', 'searchEngine', 'siteShortcuts', 'homepage',
  'translateTo', 'saveHistory', 'restoreTabs', 'startupSites', 'tabCycleOrder', 'bookmarkOpensIn', 'inlineAutocomplete',
  'defaultZoom', 'lastTabCloses', 'closedTabToast', 'confirmCloseTabs', 'newTabPosition', 'linkTabsInBackground',
  'tabCloseButton', 'secureDns', 'httpsMode', 'warnDangerousSites', 'cleanLinks', 'blockThirdPartyCookies', 'blockAds',
  'hideCookieBanners', 'showBookmarksBar', 'clearHistoryOnExit'
];

function seal(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** The value, or null for anything this key did not seal - a wrong passphrase, or a damaged file. */
function open(key, sealed) {
  try {
    // The tag's length is fixed here: left to the file, a tag cut to 4 bytes
    // is accepted, and only those 4 are checked.
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const text = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function deriveKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase.normalize('NFKC'), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function readJsonFile(file) {
  const stat = fs.statSync(file);
  // A link to /dev/zero or a pipe reports no size, and reading it never ends.
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > MAX_FILE_BYTES) throw new Error('too large');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Written beside and renamed, so a reader - or the folder's sync - never sees half a file. */
function writeJsonFile(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** What a snapshot says, without when it was written or its count. */
function digestOf(snap) {
  return crypto.createHash('sha256').update(JSON.stringify({ ...snap, at: 0, seq: undefined })).digest('hex');
}

/**
 * The entries of a list whose contents changed between two snapshots of it,
 * keyed by address. Additions and removals are not changes: they are decided
 * by what each side has and what it deleted (see takeIn).
 */
function changedEntries(before, after, fields) {
  const was = new Map((before || []).map((e) => [e.url, e]));
  const out = [];
  for (const entry of after || []) {
    const old = was.get(entry.url);
    if (old && fields.some((f) => old[f] !== entry[f])) out.push(entry);
  }
  return out;
}

class Sync {
  /**
   * @param {object} deps
   * @param {string} deps.dir - the profile directory
   * @param {object} deps.bookmarks
   * @param {object|null} deps.readingList
   * @param {object} deps.prefs
   * @param {(key: string, value: any) => void} deps.applyPref - sets a preference as Settings would
   * @param {object} deps.safeStorage - Electron's
   * @param {() => {available: boolean, reason: string|null}} deps.keystore
   */
  constructor({ dir, bookmarks, readingList, prefs, applyPref, safeStorage, keystore, log = () => {} }) {
    this.dir = dir;
    this.bookmarks = bookmarks;
    this.readingList = readingList;
    this.prefs = prefs;
    this.applyPref = applyPref;
    this.safeStorage = safeStorage;
    this.keystore = keystore;
    this.log = log;
    this.key = null;
    this.error = null;
    this.running = false;
    this.timer = null;
    /** { folder, deviceId, deviceName, lastSync, lastWritten, remote: { id: {at, name, snapshot} } } */
    this.state = this.loadState();
    if (this.state) this.key = this.loadKey();
  }

  loadState() {
    try {
      const state = readJsonFile(path.join(this.dir, LOCAL_FILE));
      if (state && typeof state.folder === 'string' && /^[a-f0-9]{16}$/.test(state.deviceId)) {
        state.remote = state.remote && typeof state.remote === 'object' ? state.remote : {};
        return state;
      }
    } catch { /* not set up */ }
    return null;
  }

  saveState() {
    if (this.state) writeJsonFile(path.join(this.dir, LOCAL_FILE), this.state);
  }

  loadKey() {
    try {
      const sealed = fs.readFileSync(path.join(this.dir, KEY_FILE));
      return Buffer.from(this.safeStorage.decryptString(sealed), 'base64');
    } catch (err) {
      this.error = 'Sync needs its passphrase again on this computer.';
      this.log(`sync: could not read the key: ${err.message}`);
      return null;
    }
  }

  get syncDir() {
    return this.state ? this.state.folder : null;
  }

  status() {
    if (!this.state) return { on: false, available: this.keystore().available, reason: this.keystore().reason };
    const devices = Object.entries(this.state.remote).filter(([, r]) => !r.gone)
      .map(([id, r]) => ({ id, name: r.name || 'Another computer', at: r.at || 0 }));
    return {
      on: true,
      available: true,
      folder: path.dirname(this.state.folder),
      deviceName: this.state.deviceName,
      lastSync: this.state.lastSync || 0,
      needsPassphrase: !this.key,
      error: this.error,
      devices
    };
  }

  /**
   * Turn sync on with a folder and a passphrase. The first computer sets the
   * passphrase; every other one must give the same, which the check in
   * sync.json proves without the passphrase being stored there.
   * @returns {Promise<{ok: boolean, reason?: string, joined?: boolean}>}
   */
  async start(folder, passphrase) {
    const cap = this.keystore();
    if (!cap.available) return { ok: false, reason: `Sync keeps its key in your system’s keystore, and ${cap.reason}.` };
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
      return { ok: false, reason: `Choose a passphrase of at least ${MIN_PASSPHRASE} characters.` };
    }
    const root = path.basename(folder) === DIR_NAME ? folder : path.join(folder, DIR_NAME);
    const metaFile = path.join(root, 'sync.json');
    let key;
    let joined = false;
    try {
      fs.mkdirSync(path.join(root, 'devices'), { recursive: true });
      if (fs.existsSync(metaFile)) {
        const meta = readJsonFile(metaFile);
        key = await deriveKey(passphrase, Buffer.from(meta.salt, 'base64'));
        if (open(key, meta.check) !== CHECK_TEXT) {
          return { ok: false, reason: 'That isn’t the passphrase this folder was set up with.' };
        }
        joined = true;
      } else if (fs.readdirSync(path.join(root, 'devices')).some((name) => DEVICE_FILE.test(name))) {
        // Other computers sync here, under a passphrase check that is not
        // here: deleted, or not arrived yet. A new one would start a second
        // sync in the same folder that never reads the first.
        return { ok: false, reason: 'Other computers already sync through this folder, but its passphrase check (sync.json) isn’t here yet. Wait for the folder to finish syncing, then try again.' };
      } else {
        const salt = crypto.randomBytes(16);
        key = await deriveKey(passphrase, salt);
        writeJsonFile(metaFile, { v: 1, salt: salt.toString('base64'), check: seal(key, CHECK_TEXT) });
      }
      fs.writeFileSync(path.join(this.dir, KEY_FILE), this.safeStorage.encryptString(key.toString('base64')), { mode: 0o600 });
    } catch (err) {
      return { ok: false, reason: `Couldn’t use that folder: ${err.message}.` };
    }
    this.key = key;
    this.error = null;
    const previous = this.state && this.state.folder === root ? this.state : null;
    this.state = previous || {
      folder: root,
      deviceId: crypto.randomBytes(8).toString('hex'),
      deviceName: os.hostname().replace(/\.local$/, '').slice(0, 60) || 'This computer',
      lastSync: 0,
      remote: {},
      // A computer joining computers already in step takes their settings once.
      adoptPrefs: joined
    };
    this.saveState();
    this.log(`sync: ${joined ? 'joined' : 'set up'} ${root}`);
    this.syncNow();
    return { ok: true, joined };
  }

  /** Stop syncing here. This computer's file goes from the folder; the others keep theirs. */
  stop() {
    if (this.state) {
      try { fs.rmSync(path.join(this.state.folder, 'devices', `${this.state.deviceId}.json`), { force: true }); } catch { /* the folder may be gone */ }
    }
    for (const name of [LOCAL_FILE, KEY_FILE]) {
      try { fs.rmSync(path.join(this.dir, name), { force: true }); } catch { /* already gone */ }
    }
    this.state = null;
    this.key = null;
    this.error = null;
    this.log('sync: stopped');
  }

  /** Every so often, and once now. Unref'd: a pending sync never keeps the browser open. */
  schedule(everyMs = 2 * 60 * 1000) {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.syncNow(), everyMs);
    this.timer.unref?.();
    setTimeout(() => this.syncNow(), 5000).unref?.();
  }

  /** A setting as the user chose it, not as light graphics decides it on this machine. */
  chosen(key) {
    return typeof this.prefs.chosen === 'function' ? this.prefs.chosen(key) : this.prefs.get(key);
  }

  snapshot() {
    const prefs = {};
    for (const key of SYNCED_PREFS) prefs[key] = this.chosen(key);
    return {
      v: 1,
      device: { id: this.state.deviceId, name: this.state.deviceName },
      at: Date.now(),
      bookmarks: this.bookmarks.all().map(({ url, title, folder, addedAt }) => ({ url, title, folder, addedAt })),
      readingList: this.readingList
        ? this.readingList.items.map(({ url, title, addedAt, readAt }) => ({ url, title, addedAt, read: Boolean(readAt), readAt: readAt || 0 }))
        : [],
      deleted: this.state.deleted,
      prefs
    };
  }

  /**
   * What the user deleted here since this computer last wrote its file: in
   * that file then, gone now, and not already known to be deleted. Old
   * deletions are forgotten.
   */
  noteDeletions() {
    const deleted = this.state.deleted || (this.state.deleted = { bookmarks: {}, readingList: {} });
    const now = Date.now();
    const current = {
      bookmarks: new Set(this.bookmarks.all().map((b) => b.url)),
      readingList: new Set(this.readingList ? this.readingList.items.map((e) => e.url) : [])
    };
    for (const kind of ['bookmarks', 'readingList']) {
      deleted[kind] = deleted[kind] || {};
      for (const url of (this.state.lastMine && this.state.lastMine[kind]) || []) {
        if (!current[kind].has(url) && !deleted[kind][url]) deleted[kind][url] = now;
      }
      for (const [url, at] of Object.entries(deleted[kind])) {
        if (current[kind].has(url) || now - at > TOMBSTONE_MS) delete deleted[kind][url];
      }
    }
  }

  /**
   * Read the other computers' files, take in what they changed, then write
   * this one's. Synchronous once the key is known, and a few milliseconds for
   * a large collection, so it never overlaps itself.
   * @returns {{ok: boolean, reason?: string}}
   */
  syncNow() {
    if (!this.state || !this.key || this.running) return { ok: false, reason: this.error || 'Sync is off.' };
    this.running = true;
    try {
      const devicesDir = path.join(this.state.folder, 'devices');
      let names;
      try {
        names = fs.readdirSync(devicesDir);
      } catch (err) {
        this.error = `The sync folder can’t be reached (${err.code || err.message}).`;
        return { ok: false, reason: this.error };
      }
      this.noteDeletions();
      // This computer's file changed under it: another computer writes it - a
      // profile copied there - and neither would ever read the other. This one
      // takes a new name, and reads that file as the other computer's.
      if (names.includes(`${this.state.deviceId}.json`) && this.state.lastWritten) {
        let found = null;
        try { found = open(this.key, readJsonFile(path.join(devicesDir, `${this.state.deviceId}.json`))); } catch { /* written again below */ }
        if (found && digestOf(found) !== this.state.lastWritten) {
          this.log(`sync: another computer writes as ${this.state.deviceId}; taking a new name`);
          this.state.deviceId = crypto.randomBytes(8).toString('hex');
          this.state.lastWritten = null;
        }
      }
      const own = `${this.state.deviceId}.json`;
      // Changed here since this computer last wrote: newer than anything
      // another computer can be passing on, which may be only an echo of this
      // one's earlier change.
      const last = this.state.lastMine || {};
      this.changedHere = {
        prefs: new Set(last.prefs ? SYNCED_PREFS.filter((k) => JSON.stringify(this.chosen(k)) !== JSON.stringify(last.prefs[k])) : []),
        bookmarks: new Set(last.names ? this.bookmarks.all()
          .filter((b) => last.names[b.url] && (last.names[b.url][0] !== b.title || last.names[b.url][1] !== b.folder))
          .map((b) => b.url) : [])
      };
      const present = new Set();
      let tookIn = false;
      for (const name of names) {
        if (!DEVICE_FILE.test(name) || name === own) continue;
        present.add(name.slice(0, 16));
        // One computer's file that cannot be taken in is that one's problem.
        try {
          if (this.takeIn(path.join(devicesDir, name), name.slice(0, 16))) tookIn = true;
        } catch (err) {
          this.log(`sync: skipped the file from ${name.slice(0, 16)}: ${err.message}`);
        }
      }
      // Not forgotten - its file may only be on its way - but not listed.
      for (const [id, r] of Object.entries(this.state.remote)) r.gone = !present.has(id);
      // A joiner takes the others' settings from the first of their files it
      // reads, which may be a sync or two after it joined.
      if (tookIn) this.state.adoptPrefs = false;
      const mine = this.snapshot();
      this.state.lastMine = {
        bookmarks: mine.bookmarks.map((b) => b.url), readingList: mine.readingList.map((e) => e.url), prefs: mine.prefs,
        names: Object.fromEntries(mine.bookmarks.map((b) => [b.url, [b.title, b.folder]]))
      };
      // Written only when something in it changed: a synced folder uploads
      // every write, and a timestamp alone is not news - unless the file is
      // not there.
      const digest = digestOf(mine);
      if (digest !== this.state.lastWritten || !names.includes(own)) {
        // Counted, so a reader can tell a newer file from an older one
        // whatever this computer's clock says.
        this.state.seq = (Number(this.state.seq) || 0) + 1;
        writeJsonFile(path.join(devicesDir, own), seal(this.key, { ...mine, seq: this.state.seq }));
        this.state.lastWritten = digest;
      }
      this.state.lastSync = Date.now();
      this.error = null;
      this.saveState();
      return { ok: true };
    } catch (err) {
      this.error = `Sync failed: ${err.message}.`;
      this.log(`sync: ${err.stack || err.message}`);
      return { ok: false, reason: this.error };
    } finally {
      this.running = false;
    }
  }

  /** One other computer's file: what it changed since this one last read it, applied here. */
  takeIn(file, id) {
    let snap;
    try {
      snap = open(this.key, readJsonFile(file));
    } catch { snap = null; }
    if (!snap || snap.v !== 1 || !Array.isArray(snap.bookmarks)) {
      this.log(`sync: skipped an unreadable file from ${id}`);
      return false;
    }
    // Entries this version cannot read are passed over, not thrown on.
    const entries = (list) => (Array.isArray(list) ? list.filter((e) => e && typeof e === 'object' && typeof e.url === 'string') : list);
    snap.bookmarks = entries(snap.bookmarks);
    snap.readingList = entries(snap.readingList);
    const seen = this.state.remote[id];
    // By its count where it has one: a clock put back would make every file
    // after it look older than the last.
    const counted = Number.isFinite(snap.seq) && Number.isFinite(seen?.seq);
    if (seen && (counted ? seen.seq >= snap.seq : seen.at >= snap.at)) return true;
    const before = seen ? seen.snapshot : null;
    const theirs = snap.deleted && typeof snap.deleted === 'object' ? snap.deleted : {};
    const ours = this.state.deleted;

    // A deletion over there removes it here, unless it was saved here after
    // that; it is then remembered here too, so it is not taken back in from a
    // third computer that has not caught up yet.
    const deletedAt = (kind, url) => Math.max(Number(ours[kind][url]) || 0, Number(theirs[kind]?.[url]) || 0);
    for (const [url, at] of Object.entries(theirs.bookmarks || {})) {
      if (!Number.isFinite(at)) continue;
      const local = this.bookmarks.all().find((b) => b.url === url);
      if (local && local.addedAt < at) this.bookmarks.remove(local.id);
      if (!local || local.addedAt < at) ours.bookmarks[url] = Math.max(ours.bookmarks[url] || 0, at);
    }
    // Theirs that are not here, and were not deleted here after they were saved.
    const have = new Set(this.bookmarks.all().map((b) => b.url));
    const fresh = snap.bookmarks.filter((b) => !have.has(b.url) && !(deletedAt('bookmarks', b.url) > (b.addedAt || 0)));
    if (fresh.length) this.bookmarks.merge(fresh);
    for (const entry of changedEntries(before && before.bookmarks, snap.bookmarks, ['title', 'folder'])) {
      if (this.changedHere?.bookmarks.has(entry.url)) continue;
      const local = this.bookmarks.all().find((b) => b.url === entry.url);
      if (local) this.bookmarks.update(local.id, { title: entry.title, folder: entry.folder });
    }

    if (this.readingList && Array.isArray(snap.readingList)) {
      for (const [url, at] of Object.entries(theirs.readingList || {})) {
        if (!Number.isFinite(at)) continue;
        const local = this.readingList.items.find((e) => e.url === url);
        if (local && local.addedAt < at) this.readingList.remove(url);
        if (!local || local.addedAt < at) ours.readingList[url] = Math.max(ours.readingList[url] || 0, at);
      }
      for (const entry of snap.readingList) {
        const local = this.readingList.items.find((e) => e.url === entry.url);
        if (!local) {
          if (deletedAt('readingList', entry.url) > (entry.addedAt || 0)) continue;
          this.readingList.add(entry.url, entry.title);
          if (entry.read) this.readingList.markRead(entry.url);
        } else if (entry.read && !(Number(entry.readAt) > 0 && Number(entry.readAt) < local.addedAt)) {
          // Read over there - unless it was saved again here since.
          this.readingList.markRead(entry.url);
        }
      }
    }

    // Settings: what that computer changed since last time - or, the once a
    // computer joins, everything it has.
    const prefs = snap.prefs && typeof snap.prefs === 'object' ? snap.prefs : {};
    for (const key of SYNCED_PREFS) {
      if (!Object.hasOwn(prefs, key) || this.changedHere?.prefs.has(key)) continue;
      const changed = before ? JSON.stringify(before.prefs?.[key]) !== JSON.stringify(prefs[key]) : this.state.adoptPrefs;
      if (changed && JSON.stringify(this.chosen(key)) !== JSON.stringify(prefs[key])) this.applyPref(key, prefs[key]);
    }

    this.state.remote[id] = { at: snap.at, seq: Number.isFinite(snap.seq) ? snap.seq : undefined,
      name: String(snap.device?.name || '').slice(0, 60), snapshot: snap };
    return true;
  }
}

module.exports = { Sync, changedEntries, seal, open, SYNCED_PREFS, DIR_NAME, MIN_PASSPHRASE };
