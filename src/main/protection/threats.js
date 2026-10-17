'use strict';

/**
 * Warnings before a site known to be dangerous, or one pretending to be a site
 * you use.
 *
 * Chrome and Edge ask Google's and Microsoft's servers about the sites you
 * visit. Electron has neither service, and a browser whose argument is privacy
 * should not send every address somewhere to be checked anyway. So the lists
 * come here instead, once a day, and every check is made on this machine:
 *
 *   URLhaus (abuse.ch)   hosts currently spreading malware        CC0
 *   Phishing Army        phishing domains, from several feeds      CC BY-NC 4.0
 *
 * About 150,000 domains, held as 64-bit hashes in one sorted array - a little
 * over a megabyte, where the same list as strings would be ten times that.
 *
 * And one check no list can make: a site one letter away from a site you use
 * all the time - `paypa1.com`, `githbu.com` - that you have never been to.
 * Edge calls it typo protection. The sites it compares against are your own
 * most-visited ones, from history, so it knows nothing it was not told.
 *
 * The warning is a page in the tab, with Go back first and "continue anyway"
 * behind a second click. Never in a private window, which checks nothing and
 * remembers nothing.
 */

const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const { getDomain } = require('tldts-experimental');
const { WebHooks } = require('../web-hooks');

const LISTS = [
  { url: 'https://urlhaus.abuse.ch/downloads/hostfile/', kind: 'malware' },
  { url: 'https://phishing.army/download/phishing_army_blocklist.txt', kind: 'phishing' }
];
const MAX_AGE_MS = 24 * 3600 * 1000;
const FILE = 'threats.bin';

/** Two independent 32-bit hashes of a name, as one 64-bit value. */
function hash64(name) {
  let a = 0x811c9dc5;          // FNV-1a
  let b = 5381;                // djb2
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = (Math.imul(b, 33) + c) >>> 0;
  }
  return (BigInt(a) << 32n) | BigInt(b);
}

/** Domains from a list: plain names, or hosts-file lines ("0.0.0.0 name"). */
function domainsIn(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*/, '').trim().toLowerCase();
    if (!line) continue;
    const name = line.split(/\s+/).pop();
    if (name && name.includes('.') && !/^[\d.]+$/.test(name) && name !== 'localhost') out.push(name);
  }
  return out;
}

/**
 * Edit distance, with a swap of two neighbouring letters counting as one edit
 * (optimal string alignment), stopping early once it passes `max`.
 */
function distance(a, b, max = 1) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (before && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1);
      row[j] = d;
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    before = prev;
    prev = row;
  }
  return prev[b.length];
}

/**
 * Both lists, fetched and compiled: a count, then the sorted hashes, then
 * each one's kind - the file the browser keeps, and what it reads back.
 * Run in a helper process (list-worker.js) where it can be, since the parse is
 * sixty-odd megabytes the browser process would be slow to give back.
 */
async function compileThreats() {
  const entries = [];
  for (const list of LISTS) {
    const res = await net.fetch(list.url);
    if (!res.ok) throw new Error(`${list.url}: HTTP ${res.status}`);
    for (const d of domainsIn(await res.text())) entries.push({ d, kind: list.kind });
  }
  const { hashes, kinds } = indexOf(entries);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(hashes.length, 0);
  return Buffer.concat([head, Buffer.from(hashes.buffer), Buffer.from(kinds.buffer)]);
}

/** Hashes sorted for a binary search, and each one's kind beside it. */
function indexOf(entries) {
  const pairs = entries.map(({ d, kind }) => [hash64(d), kind === 'malware' ? 0 : 1]);
  pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return { hashes: BigUint64Array.from(pairs.map((p) => p[0])), kinds: Uint8Array.from(pairs.map((p) => p[1])) };
}

/** Letters people and attackers swap for one another. */
const LOOKALIKE = { 0: 'o', 1: 'l', 3: 'e', 5: 's', 7: 't', rn: 'm', vv: 'w' };
const unconfuse = (s) => s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[01357]/g, (c) => LOOKALIKE[c]);

class Threats {
  /**
   * @param {object} opts
   * @param {string|null} opts.dir - where the compiled list is kept; null: nowhere
   * @param {() => boolean} opts.enabled - the setting, read live
   * @param {() => Array<{url: string, visits: number}>} opts.history - for typo checks
   * @param {string[]|null} [opts.domains] - a list to use instead of the real ones (tests)
   */
  constructor({ dir, enabled, history = () => [], domains = null, log = () => {} }) {
    this.dir = dir;
    this.enabled = enabled;
    this.history = history;
    this.log = log;
    this.hashes = new BigUint64Array(0);
    this.kinds = new Uint8Array(0);   // 0 malware, 1 phishing, index-aligned with hashes
    /** URLs stopped on their way out, until the tab asks what happened. */
    this.stopped = new Map();
    /** Hosts the user chose to open anyway, until restart. */
    this.allowed = new Set();
    this.familiar = null;
    this.familiarAt = 0;
    if (domains) this.index(domains.map((d) => ({ d, kind: 'phishing' })));
  }

  static current = null;

  get file() { return this.dir ? path.join(this.dir, FILE) : null; }

  index(entries) {
    ({ hashes: this.hashes, kinds: this.kinds } = indexOf(entries));
  }

  /** Take a compiled list (compileThreats) as the one in force. */
  use(buf) {
    const n = buf.readUInt32LE(0);
    this.hashes = new BigUint64Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + 8 + n * 8));
    this.kinds = new Uint8Array(buf.buffer.slice(buf.byteOffset + 8 + n * 8, buf.byteOffset + 8 + n * 9));
  }

  /** The list from disk if it is today's, else fetched again; yesterday's beats none. */
  async load() {
    const file = this.file;
    let fresh = false;
    if (file) {
      try {
        this.use(fs.readFileSync(file));
        this.updatedAt = fs.statSync(file).mtimeMs;
        fresh = Date.now() - this.updatedAt < MAX_AGE_MS;
      } catch { /* none yet */ }
    }
    if (fresh) return;
    try {
      // In a helper process; here only if one could not be started.
      const buf = await require('./list-helper').compileInHelper('threats').catch((err) => {
        this.log(`threats: compiling here (${err.message})`);
        return compileThreats();
      });
      this.use(buf);
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, buf);
        fs.renameSync(`${file}.tmp`, file);
      }
      this.updatedAt = Date.now();
      this.log(`threats: ${this.hashes.length} dangerous domains listed`);
    } catch (err) {
      this.log(`threats: could not refresh the lists (${err.message})`);
    }
  }

  /** 'malware', 'phishing' or null for one hostname and every domain above it. */
  listed(hostname) {
    const labels = String(hostname || '').toLowerCase().replace(/\.$/, '').split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const h = hash64(labels.slice(i).join('.'));
      let lo = 0;
      let hi = this.hashes.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = this.hashes[mid];
        if (v === h) return this.kinds[mid] === 0 ? 'malware' : 'phishing';
        if (v < h) lo = mid + 1; else hi = mid - 1;
      }
    }
    return null;
  }

  /** The user's own well-used sites, by registrable domain, refreshed every few minutes. */
  familiarSites() {
    if (this.familiar && Date.now() - this.familiarAt < 5 * 60_000) return this.familiar;
    const visits = new Map();
    for (const entry of this.history()) {
      let domain = null;
      try { domain = getDomain(new URL(entry.url).hostname); } catch { domain = null; }
      if (domain) visits.set(domain, (visits.get(domain) || 0) + (entry.visits || 1));
    }
    this.familiar = new Map([...visits].filter(([, n]) => n >= 5));
    this.familiarAt = Date.now();
    return this.familiar;
  }

  /** The familiar site this one is one slip away from, if it is new to the user. */
  lookalikeOf(hostname) {
    const domain = getDomain(hostname);
    if (!domain) return null;
    const sites = this.familiarSites();
    if (sites.has(domain)) return null;
    const name = domain.split('.')[0];
    if (name.length < 5) return null;               // too short to tell a typo from a different name
    for (const known of sites.keys()) {
      const other = known.split('.')[0];
      if (other.length < 5 || other === name) continue;
      if (distance(name, other) <= 1 || unconfuse(name) === other) return known;
    }
    return null;
  }

  /** What the page would warn about, or null. */
  verdict(url) {
    if (this.enabled() === false) return null;
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (!/^https?:$/.test(parsed.protocol) || this.allowed.has(parsed.hostname)) return null;
    const kind = this.listed(parsed.hostname);
    if (kind) return { kind };
    const like = this.lookalikeOf(parsed.hostname);
    return like ? { kind: 'lookalike', like } : null;
  }

  attach(session) {
    WebHooks.for(session).onBeforeRequest((details) => {
      if (details.resourceType !== 'mainFrame') return undefined;
      const verdict = this.verdict(details.url);
      if (!verdict) return undefined;
      this.caught = (this.caught || 0) + 1;
      this.stopped.set(details.url, verdict);
      if (this.stopped.size > 64) this.stopped.delete(this.stopped.keys().next().value);
      return { cancel: true };
    });
  }

  /** The tab's question after a failed load: was that us, and why? */
  takeStopped(url) {
    const verdict = this.stopped.get(url);
    this.stopped.delete(url);
    return verdict || null;
  }

  allow(url) {
    try {
      this.allowed.add(new URL(url).hostname);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { Threats, hash64, domainsIn, distance, compileThreats };
