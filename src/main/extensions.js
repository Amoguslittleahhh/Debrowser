'use strict';

/**
 * Extensions, as a Lab: Chrome's and Firefox's.
 *
 * Electron loads an unpacked Chrome extension into a session and runs part of
 * the extension API: content scripts, the background page or service worker,
 * storage, messaging, and some of `chrome.tabs` and `chrome.webRequest`. It
 * does not draw an extension's toolbar button or popup, and it cannot install
 * from the Chrome Web Store. So this is a Lab, and Settings says so plainly:
 * extensions that work on the pages themselves (a script-blocker, a
 * dark-mode, a password filler's in-page part) mostly work; ones that live in
 * a toolbar popup mostly do not.
 *
 * Firefox extensions are the same WebExtension format with two differences
 * this file papers over: the API is `browser.*` rather than `chrome.*`, and
 * the manifest carries Gecko-only keys. A small shim (`browser = chrome`) is
 * put in front of every script the manifest names, and Chromium ignores the
 * keys it does not know. An extension that leans on a Firefox-only API still
 * will not run; one written to the shared API usually does.
 *
 * Installed copies live unpacked under `<userData>/extensions/<id>/`, and are
 * loaded into every ordinary browsing session at start (and when one is
 * added). Never into a private window, which loads nothing it did not ship
 * with: an extension sees every page it runs on.
 *
 * Accepted: a folder with a manifest.json, a `.crx` (Chrome's packed format:
 * a header, then a zip), and a `.xpi` or `.zip` (a zip).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

/** Firefox's API name on top of Chrome's: enough for extensions written to both. */
const BROWSER_SHIM = `/* Added by Debrowser: Firefox's browser.* on top of chrome.* */
if (typeof globalThis.browser === 'undefined' && typeof globalThis.chrome !== 'undefined') {
  globalThis.browser = globalThis.chrome;
}
`;
const SHIM_FILE = '__debrowser_browser_shim.js';
/** Recorded beside each copy: where it came from, so the list can say so. */
const META_FILE = '__debrowser.json';

/* ---- Unpacking ------------------------------------------------------------ */

/**
 * The files in a zip, read from its central directory. Stored and deflated
 * entries, which is everything a browser extension is packed with. Paths that
 * would leave the folder (`..`, absolute) are refused, not skipped: an archive
 * that tries it is not one to half-install.
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, data: Buffer}>}
 */
function readZip(buf) {
  // The end-of-central-directory record, searched for from the end: a comment
  // of up to 64KB may follow it.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged zip archive');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const normal = path.posix.normalize(name.replace(/\\/g, '/'));
    if (normal.startsWith('../') || normal === '..' || path.posix.isAbsolute(normal) || /^[a-z]:/i.test(normal)) {
      throw new Error(`unsafe path in archive: ${name}`);
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported compression in ${name}`);
    files.push({ name: normal, data });
  }
  return files;
}

/** The zip inside a `.crx`: version 2 and 3 headers both name their own length. */
function crxZip(buf) {
  if (buf.toString('latin1', 0, 4) !== 'Cr24') return buf;
  const version = buf.readUInt32LE(4);
  if (version === 3) return buf.subarray(12 + buf.readUInt32LE(8));
  if (version === 2) return buf.subarray(16 + buf.readUInt32LE(8) + buf.readUInt32LE(12));
  throw new Error(`unknown .crx version ${version}`);
}

/**
 * Where a manifest sits in the files: at the top, or one folder down - a
 * zipped folder rather than its contents is the most common way people pack
 * one by hand.
 */
function rootOf(files) {
  if (files.some((f) => f.name === 'manifest.json')) return '';
  const nested = files.find((f) => /^[^/]+\/manifest\.json$/.test(f.name));
  if (nested) return nested.name.slice(0, -'manifest.json'.length);
  throw new Error('no manifest.json in it');
}

/* ---- Manifests ------------------------------------------------------------ */

/** Firefox's, if it says Gecko anywhere Firefox puts that. */
function isFirefox(manifest) {
  return Boolean(manifest.browser_specific_settings?.gecko || manifest.applications?.gecko);
}

/**
 * A Firefox manifest made loadable here: the shim in front of every script it
 * names, and a background page's scripts kept as scripts. Returns the new
 * manifest; the shim file is written by the caller.
 */
function adaptFirefox(manifest) {
  const out = JSON.parse(JSON.stringify(manifest));
  if (out.background?.scripts) out.background.scripts = [SHIM_FILE, ...out.background.scripts];
  if (Array.isArray(out.content_scripts)) {
    for (const cs of out.content_scripts) if (Array.isArray(cs.js)) cs.js = [SHIM_FILE, ...cs.js];
  }
  return out;
}

/** "__MSG_name__" names, read from the default locale, as the browser shows them. */
function displayName(dir, manifest) {
  const raw = String(manifest.name || '');
  const m = /^__MSG_(.+)__$/.exec(raw);
  if (!m) return raw || 'Extension';
  try {
    const locale = manifest.default_locale || 'en';
    const messages = JSON.parse(fs.readFileSync(path.join(dir, '_locales', locale, 'messages.json'), 'utf8'));
    const hit = Object.entries(messages).find(([k]) => k.toLowerCase() === m[1].toLowerCase());
    return hit ? hit[1].message : raw;
  } catch {
    return raw;
  }
}

/* ---- The store ------------------------------------------------------------ */

class Extensions {
  /**
   * @param {string} root - `<userData>/extensions`
   * @param {(msg: string) => void} [log]
   */
  constructor(root, log = () => {}) {
    this.root = root;
    this.log = log;
    this.sessions = new Set();
  }

  /** The installed copies, newest first, as Settings lists them. */
  list() {
    let names = [];
    try { names = fs.readdirSync(this.root); } catch { return []; }
    const out = [];
    for (const id of names) {
      const dir = path.join(this.root, id);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')); } catch { /* none */ }
        out.push({
          id, dir, name: displayName(dir, manifest), version: String(manifest.version || ''),
          from: meta.from || 'chrome', addedAt: meta.addedAt || 0, manifestVersion: manifest.manifest_version || 2
        });
      } catch { /* a half-written folder: not listed, not loaded */ }
    }
    return out.sort((a, b) => b.addedAt - a.addedAt);
  }

  /**
   * Install from a folder, a .crx, or a .xpi/.zip. Returns the listed entry.
   *
   * @param {string} source
   */
  install(source) {
    let files;
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      files = [];
      const walk = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), r);
          else if (entry.isFile()) files.push({ name: r, data: fs.readFileSync(path.join(dir, entry.name)) });
        }
      };
      walk(source, '');
    } else {
      files = readZip(crxZip(fs.readFileSync(source)));
    }
    const base = rootOf(files);
    const own = files.filter((f) => f.name.startsWith(base)).map((f) => ({ name: f.name.slice(base.length), data: f.data }));
    let manifest = JSON.parse(own.find((f) => f.name === 'manifest.json').data.toString('utf8').replace(/^﻿/, ''));
    if (!manifest.manifest_version || !manifest.name) throw new Error('manifest.json has no name or version');
    const from = isFirefox(manifest) ? 'firefox' : 'chrome';
    if (from === 'firefox') manifest = adaptFirefox(manifest);

    // Named for what it is, so installing it again replaces it.
    const key = manifest.browser_specific_settings?.gecko?.id || manifest.applications?.gecko?.id ||
      manifest.key || `${manifest.name}@${from}`;
    const id = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24);
    const dir = path.join(this.root, id);
    const temp = `${dir}.part`;
    fs.rmSync(temp, { recursive: true, force: true });
    for (const f of own) {
      const target = path.join(temp, f.name);
      if (!target.startsWith(temp + path.sep)) throw new Error(`unsafe path: ${f.name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.name === 'manifest.json' ? JSON.stringify(manifest, null, 2) : f.data);
    }
    if (from === 'firefox') fs.writeFileSync(path.join(temp, SHIM_FILE), BROWSER_SHIM);
    fs.writeFileSync(path.join(temp, META_FILE), JSON.stringify({ from, addedAt: Date.now(), source: path.basename(source) }));
    this.unloadEverywhere(id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(temp, dir);
    this.log(`extensions: installed ${manifest.name} (${from})`);
    return this.list().find((e) => e.id === id);
  }

  /** Remove one: out of every session now, and off the disk. */
  remove(id) {
    if (!/^[0-9a-f]{24}$/.test(String(id))) return false;
    this.unloadEverywhere(id);
    fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
    return true;
  }

  /**
   * Load every installed copy into a session, and remember the session so a
   * later install reaches it too. Failures are logged and listed, not thrown:
   * one extension Electron refuses must not keep the rest out.
   *
   * @returns {Promise<Array<{id: string, ok: boolean, error?: string}>>}
   */
  async attach(ses) {
    this.sessions.add(ses);
    const results = [];
    for (const ext of this.list()) results.push(await this.loadInto(ses, ext));
    return results;
  }

  async loadInto(ses, ext) {
    if (ses.__debrowserExt?.has(ext.id)) return { id: ext.id, ok: true };
    try {
      const api = ses.extensions || ses;
      const loaded = await api.loadExtension(ext.dir, { allowFileAccess: false });
      (ses.__debrowserExt ||= new Map()).set(ext.id, loaded.id);
      return { id: ext.id, ok: true };
    } catch (err) {
      this.log(`extensions: ${ext.name} did not load: ${err.message}`);
      this.errors = { ...(this.errors || {}), [ext.id]: err.message };
      return { id: ext.id, ok: false, error: err.message };
    }
  }

  /** Into every session already attached: after an install. */
  async loadEverywhere(id) {
    const ext = this.list().find((e) => e.id === id);
    if (!ext) return [];
    if (this.errors) delete this.errors[id];
    return Promise.all([...this.sessions].map((ses) => this.loadInto(ses, ext)));
  }

  unloadEverywhere(id) {
    for (const ses of this.sessions) {
      const loadedId = ses.__debrowserExt?.get(id);
      if (!loadedId) continue;
      try { (ses.extensions || ses).removeExtension(loadedId); } catch { /* already gone */ }
      ses.__debrowserExt.delete(id);
    }
  }

  /** Out of every session, for the Lab being turned off. Copies stay on disk. */
  detachAll() {
    for (const ext of this.list()) this.unloadEverywhere(ext.id);
  }
}

module.exports = { Extensions, readZip, crxZip, adaptFirefox, isFirefox, SHIM_FILE };
