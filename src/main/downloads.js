'use strict';

/**
 * Downloads, in several connections at once.
 *
 * The idea is the one IDM made famous: ask the server for byte ranges in
 * parallel rather than pulling one stream end to end. On a link where a single
 * connection is not the bottleneck - a server that shapes per-connection, a
 * long fat path where one TCP flow never fills the window - several segments
 * finish sooner than one. On a link where it *is* the bottleneck, they do not,
 * and this is careful not to pretend otherwise.
 *
 * ## What decides whether it can be done
 *
 * Only the server. A segmented download needs `Accept-Ranges: bytes` and a
 * `Content-Length`, and needs the file not to change underneath us while it is
 * being fetched in pieces. Everything else here is arithmetic.
 *
 * So the first request is a probe, and the answer to it decides the strategy:
 *
 *   - ranges and a length      → split into N segments
 *   - no ranges, or no length  → one connection, start to finish
 *   - a validator changes mid-flight → give up and restart whole
 *
 * The last is the one that matters for correctness. A file reassembled from
 * segments of two different versions is corrupt in a way no size check
 * notices, so the ETag or Last-Modified from the probe is sent back with every
 * segment as `If-Range`, and a server that answers 200 instead of 206 has told
 * us the file changed.
 *
 * ## Writing
 *
 * Segments are written into one file at their own offsets rather than into N
 * temporary files that are concatenated at the end. Concatenating means
 * reading and writing the whole thing a second time, which on a large download
 * costs more than the parallelism saved.
 */

const fs = require('fs');
const path = require('path');
const { net } = require('electron');

/** Below this, splitting costs more in round trips than it saves. */
const MIN_SEGMENTED_BYTES = 2 * 1024 * 1024;

/** Hard ceiling on connections, whatever the setting says. */
const MAX_CONNECTIONS = 16;

/** Redirect depth. Enough for any real chain, short enough to stop a loop. */
const MAX_REDIRECTS = 5;

/** How often progress is reported, at most. */
const PROGRESS_INTERVAL_MS = 250;

let nextId = 0;

class Download {
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {string} opts.dir - directory to write into
   * @param {number} opts.connections
   * @param {(...a:any[]) => void} opts.log
   * @param {(d: Download) => void} [opts.onChange]
   */
  constructor({ url, dir, connections, log = () => {}, onChange = () => {} }) {
    this.id = `dl-${Date.now().toString(36)}-${(nextId += 1).toString(36)}`;
    this.url = url;
    this.dir = dir;
    this.wanted = clampConnections(connections);
    this.log = log;
    this.onChange = onChange;

    this.state = 'starting';       // starting | running | done | failed | cancelled
    this.filename = null;
    this.file = null;
    this.total = 0;
    this.received = 0;
    this.segments = 0;
    this.error = null;
    this.startedAt = Date.now();
    this.finishedAt = null;

    this.requests = new Set();
    this.handle = null;
    this.cancelled = false;
    this.lastReport = 0;
  }

  report(force = false) {
    const now = Date.now();
    if (!force && now - this.lastReport < PROGRESS_INTERVAL_MS) return;
    this.lastReport = now;
    this.onChange(this);
  }

  snapshot() {
    const seconds = ((this.finishedAt || Date.now()) - this.startedAt) / 1000;
    return {
      id: this.id,
      url: this.url,
      filename: this.filename,
      state: this.state,
      total: this.total,
      received: this.received,
      segments: this.segments,
      error: this.error,
      bytesPerSecond: seconds > 0.25 ? Math.round(this.received / seconds) : 0
    };
  }

  async start() {
    try {
      const probe = await this.probe();
      if (this.cancelled) return;

      this.total = probe.total;
      this.filename = await uniqueName(this.dir, probe.filename);
      this.file = path.join(this.dir, this.filename);
      this.handle = await fs.promises.open(this.file, 'w');

      // Sparse-allocate so the segments have somewhere to write. Without this
      // a write past the end still works, but the file grows in whatever order
      // the segments happen to finish, and the size on disk lies until it ends.
      if (this.total > 0) await this.handle.truncate(this.total);

      const canSplit = probe.acceptsRanges && this.total >= MIN_SEGMENTED_BYTES && this.wanted > 1;
      this.segments = canSplit ? Math.min(this.wanted, MAX_CONNECTIONS) : 1;
      this.state = 'running';
      this.report(true);

      if (canSplit) await this.runSegmented(probe);
      else await this.runWhole(probe);

      if (this.cancelled) return;

      // The size is the one end-to-end check available without a digest the
      // server did not give us. A short file here means a segment ended early
      // and its error was swallowed somewhere.
      if (this.total > 0 && this.received !== this.total) {
        throw new Error(`incomplete: ${this.received} of ${this.total} bytes`);
      }

      this.state = 'done';
      this.finishedAt = Date.now();
      this.log('downloads', `${this.filename}: ${this.received} bytes in ${this.segments} segment(s)`);
    } catch (err) {
      if (this.cancelled) return;
      this.state = 'failed';
      this.error = err.message;
      this.finishedAt = Date.now();
      this.log('downloads', `${this.url}: ${err.message}`);
    } finally {
      await this.closeHandle();
      this.report(true);
    }
  }

  /**
   * One HEAD-shaped request to find out what the server will allow.
   *
   * Sent as a GET with `Range: bytes=0-0` rather than a HEAD, because a good
   * number of servers answer HEAD without `Accept-Ranges` while happily
   * serving ranges, and some reject HEAD outright. A 206 to this *is* the
   * capability, observed rather than advertised.
   */
  async probe() {
    const res = await this.request(this.url, { Range: 'bytes=0-0' }, MAX_REDIRECTS);
    const headers = res.headers || {};

    const contentRange = header(headers, 'content-range');
    const acceptsRanges = res.statusCode === 206 && Boolean(contentRange);

    let total = 0;
    if (contentRange) {
      const match = /\/(\d+)\s*$/.exec(contentRange);
      if (match) total = Number(match[1]);
    }
    if (!total) {
      const length = Number(header(headers, 'content-length'));
      // A 206 for one byte has a Content-Length of 1, which is not the file.
      if (Number.isFinite(length) && res.statusCode === 200) total = length;
    }

    res.destroy?.();

    return {
      total: Number.isFinite(total) && total > 0 ? total : 0,
      acceptsRanges,
      // If-Range wants a strong validator. Either is accepted by servers; the
      // ETag is preferred because Last-Modified has one-second resolution and a
      // file rewritten within the same second looks unchanged.
      validator: header(headers, 'etag') || header(headers, 'last-modified') || null,
      filename: filenameFor(this.url, header(headers, 'content-disposition')),
      finalUrl: res.finalUrl || this.url
    };
  }

  /** Split the range and fetch the pieces at once. */
  async runSegmented(probe) {
    const size = Math.ceil(this.total / this.segments);
    const jobs = [];
    for (let i = 0; i < this.segments; i++) {
      const start = i * size;
      const end = Math.min(start + size, this.total) - 1;
      if (start > end) break;
      jobs.push(this.fetchRange(probe.finalUrl, start, end, probe.validator));
    }
    await Promise.all(jobs);
  }

  /** No ranges on offer: one stream, written as it arrives. */
  async runWhole(probe) {
    const res = await this.request(probe.finalUrl, {}, MAX_REDIRECTS);
    if (res.statusCode >= 400) throw new Error(`server said ${res.statusCode}`);
    let offset = 0;
    await this.pump(res, () => {
      const at = offset;
      return at;
    }, (n) => { offset += n; });
  }

  async fetchRange(url, start, end, validator) {
    const headers = { Range: `bytes=${start}-${end}` };
    // The whole point of If-Range: if the file changed since the probe, the
    // server sends 200 with the *whole* file instead of the range, and we stop
    // rather than writing the beginning of a new version over the middle of an
    // old one.
    if (validator) headers['If-Range'] = validator;

    const res = await this.request(url, headers, MAX_REDIRECTS);
    if (res.statusCode === 200) {
      throw new Error('the file changed on the server while it was downloading');
    }
    if (res.statusCode !== 206) {
      throw new Error(`server refused a range with ${res.statusCode}`);
    }

    let offset = start;
    await this.pump(res, () => offset, (n) => { offset += n; }, end);
  }

  /** Write a response body into the file at a moving offset. */
  pump(res, offsetOf, advance, limit = null) {
    return new Promise((resolve, reject) => {
      let pending = 0;
      let ended = false;
      const settleIfDone = () => { if (ended && pending === 0) resolve(); };

      res.on('data', (chunk) => {
        if (this.cancelled) { res.destroy(); return; }
        const at = offsetOf();
        // A server that sends more than it was asked for must not be allowed to
        // write past its segment and over the next one's bytes.
        if (limit !== null && at + chunk.length - 1 > limit) {
          chunk = chunk.subarray(0, limit - at + 1);
          if (chunk.length === 0) { res.destroy(); return; }
        }
        advance(chunk.length);
        pending++;
        this.handle.write(chunk, 0, chunk.length, at).then(() => {
          pending--;
          this.received += chunk.length;
          this.report();
          settleIfDone();
        }, (err) => { pending--; reject(err); });
      });
      res.on('error', reject);
      res.on('end', () => { ended = true; settleIfDone(); });
      res.on('aborted', () => reject(new Error('the connection was closed early')));
    });
  }

  /**
   * One request, following redirects by hand.
   *
   * By hand because the final URL matters: every segment has to be fetched from
   * the same place the probe measured, and a redirect chain re-followed per
   * segment can land on a different mirror with a different file.
   */
  request(url, headers, redirectsLeft) {
    return new Promise((resolve, reject) => {
      if (this.cancelled) { reject(new Error('cancelled')); return; }

      let req;
      try {
        req = net.request({ url, method: 'GET', redirect: 'manual' });
      } catch (err) {
        reject(err);
        return;
      }
      for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);

      this.requests.add(req);
      const done = () => this.requests.delete(req);

      req.on('response', (res) => {
        done();
        const location = header(res.headers, 'location');
        if (res.statusCode >= 300 && res.statusCode < 400 && location) {
          res.destroy?.();
          if (redirectsLeft <= 0) { reject(new Error('too many redirects')); return; }
          let next;
          try {
            next = new URL(location, url).href;
          } catch {
            reject(new Error('the server redirected somewhere unparseable'));
            return;
          }
          this.request(next, headers, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        res.finalUrl = url;
        resolve(res);
      });
      req.on('error', (err) => { done(); reject(err); });
      req.end();
    });
  }

  cancel() {
    if (this.state === 'done' || this.cancelled) return;
    this.cancelled = true;
    this.state = 'cancelled';
    this.finishedAt = Date.now();
    for (const req of this.requests) {
      try { req.abort(); } catch { /* already finished */ }
    }
    this.requests.clear();
    this.closeHandle().then(() => {
      // A cancelled download leaves no half file behind. It was never the
      // user's file; it was our attempt at it.
      if (this.file) fs.promises.unlink(this.file).catch(() => {});
      this.report(true);
    });
  }

  async closeHandle() {
    if (!this.handle) return;
    const handle = this.handle;
    this.handle = null;
    try { await handle.close(); } catch { /* already closed */ }
  }
}

/* ------------------------------------------------------------------ */

class DownloadManager {
  constructor({ dir, connections = () => 4, log = () => {}, onChange = () => {} }) {
    this.dir = dir;
    this.connections = connections;
    this.log = log;
    this.onChange = onChange;
    /** @type {Map<string, Download>} */
    this.items = new Map();
  }

  start(url) {
    let clean;
    try {
      const parsed = new URL(url);
      // Only what a download can mean. A file: URL here would be a page asking
      // the browser to copy something off the local disk on its behalf.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      clean = parsed.href;
    } catch {
      return null;
    }

    const item = new Download({
      url: clean,
      dir: this.dir,
      connections: this.connections(),
      log: this.log,
      onChange: () => this.onChange(this.list())
    });
    this.items.set(item.id, item);
    item.start();
    return item;
  }

  cancel(id) {
    const item = this.items.get(id);
    if (!item) return false;
    item.cancel();
    return true;
  }

  /** Forget a finished one. A running download is cancelled first. */
  remove(id) {
    const item = this.items.get(id);
    if (!item) return false;
    if (item.state === 'running' || item.state === 'starting') item.cancel();
    this.items.delete(id);
    return true;
  }

  list() {
    return [...this.items.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((item) => item.snapshot());
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clampConnections(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 4;
  return Math.max(1, Math.min(MAX_CONNECTIONS, n));
}

/** Header lookup that does not care about case, and flattens arrays. */
function header(headers, name) {
  if (!headers) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  if (!key) return null;
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * What to call the file.
 *
 * `Content-Disposition` first, then the URL's last path segment, then a
 * fallback. Whatever it produces is reduced to a bare filename: a server is
 * choosing this, and a server that answers `../../.bashrc` is asking to write
 * outside the downloads directory.
 */
function filenameFor(url, disposition) {
  let name = '';

  if (disposition) {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
    const plain = /filename\s*=\s*"([^"]+)"/i.exec(disposition)
      || /filename\s*=\s*([^;]+)/i.exec(disposition);
    if (star) {
      try { name = decodeURIComponent(star[1]); } catch { name = ''; }
    } else if (plain) {
      name = plain[1].trim();
    }
  }

  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch {
      name = '';
    }
  }

  return sanitiseName(name);
}

/**
 * Reduce a server-chosen name to something that can only land in one directory.
 *
 * Takes the basename twice - once for each separator - because `path.basename`
 * on Linux does not treat a backslash as one, and a name like
 * `..\\..\\evil.exe` would survive a POSIX-only check and then be interpreted
 * as a path by Windows.
 */
function sanitiseName(raw) {
  let name = String(raw || '').replace(/[ -]/g, '');
  name = name.split('/').pop();
  name = name.split('\\').pop();
  name = name.replace(/^\.+/, '');                       // no dotfiles, no ".."
  name = name.replace(/[<>:"|?*]/g, '_');                // illegal on Windows
  name = name.trim().slice(0, 180);
  return name || 'download';
}

/** Never overwrite. `file.zip`, then `file (1).zip`. */
async function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${stem} (${i})${ext}`;
    try {
      await fs.promises.access(path.join(dir, candidate));
    } catch {
      return candidate;                                  // does not exist: take it
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

module.exports = {
  DownloadManager,
  Download,
  sanitiseName,
  filenameFor,
  clampConnections,
  MIN_SEGMENTED_BYTES,
  MAX_CONNECTIONS
};
