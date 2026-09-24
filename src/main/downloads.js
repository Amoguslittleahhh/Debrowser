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
   * @param {(defaultPath: string) => any} [opts.saveAs] - see DownloadManager
   */
  constructor({ url, dir, connections, session = null, log = () => {}, onChange = () => {},
                saveAs = null }) {
    this.id = `dl-${Date.now().toString(36)}-${(nextId += 1).toString(36)}`;
    this.url = url;
    this.dir = dir;
    this.saveAs = saveAs;
    this.session = session;
    this.wanted = clampConnections(connections);
    this.log = log;
    this.onChange = onChange;

    this.state = 'starting';       // starting | running | done | failed | cancelled
    this.filename = null;
    this.file = null;
    /** Where a path picked in the save dialog ends up; `file` is written first. */
    this.finalFile = null;
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
      // After the probe, so the dialog can offer the server's name for it.
      if (!(await this.chooseTarget(probe.filename))) {
        this.cancel();
        return;
      }
      // Cancelled while the file was being opened: `cancel` found no handle
      // and no path yet, so the empty file is ours to remove.
      if (this.cancelled) {
        await this.closeHandle();
        await fs.promises.unlink(this.file).catch(() => {});
        return;
      }

      // Sparse-allocate so the segments have somewhere to write. Without this
      // a write past the end still works, but the file grows in whatever order
      // the segments happen to finish, and the size on disk lies until it ends.
      if (this.total > 0) await this.handle.truncate(this.total);

      // Cancelling during the open or the truncate - which on a large file is
      // not instant - used to be overwritten by the assignment below, and the
      // second Cancel was then a no-op because `cancelled` was already set. The
      // download ran to completion with the UI saying it had stopped.
      if (this.cancelled) return;

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
      if (this.state === 'done' && this.finalFile) {
        try {
          await fs.promises.rename(this.file, this.finalFile);
          this.file = this.finalFile;
        } catch (err) {
          this.state = 'failed';
          this.error = `could not replace ${this.filename}: ${err.message}`;
        }
      }
      // A failed download leaves no file behind either - the same rule as a
      // cancelled one, and here it matters more.
      //
      // The file is sparse-allocated to its full length before the first byte
      // arrives, so a download that dies part way through leaves something of
      // exactly the right size with zeros in the gaps: an installer that looks
      // complete in a file manager and is not. Cancelling already unlinked for
      // this reason; failing did not, which is the path the user did not
      // choose and is therefore less likely to be expecting.
      if (this.state === 'failed' && this.file) {
        await fs.promises.unlink(this.file).catch(() => { /* never written */ });
      }
      this.report(true);
    }
  }

  /**
   * Decide where the file goes. False means the user cancelled the dialog.
   *
   * A path picked in the save dialog is taken as given - the dialog has already
   * asked about replacing an existing file - where the automatic name is made
   * unique so nothing is overwritten unasked.
   */
  async chooseTarget(suggested) {
    // The folder may still be being checked - see `downloadDir` in main.js.
    this.dir = await this.dir;
    const picked = this.saveAs ? await this.saveAs(path.join(this.dir, suggested)) : undefined;
    // Cancelled from the list while the dialog was up: nothing to open.
    if (picked === null || this.cancelled) return false;
    if (typeof picked === 'string' && path.isAbsolute(picked)) {
      // Written beside it and moved over it only once complete. The dialog has
      // asked about replacing an existing file, but a download that then fails
      // must not have destroyed the one the user already had.
      this.dir = path.dirname(picked);
      this.filename = path.basename(picked);
      this.finalFile = picked;
      this.file = `${picked}.part`;
      this.handle = await fs.promises.open(this.file, 'w');
    } else {
      const { name, handle } = await openUnique(this.dir, suggested);
      this.filename = name;
      this.file = path.join(this.dir, name);
      this.handle = handle;
    }
    return true;
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
      // If-Range is compared *strongly*, so a weak ETag - `W/"..."`, which is
      // what nginx emits for anything it gzips - can never match. Sent anyway,
      // the server ignores the Range, answers 200, and this code reads that as
      // "the file changed": every segmented download from such a server failed
      // on a file that had not changed at all. Weak validators are dropped and
      // Last-Modified is used instead, which is compared strongly and does
      // match.
      validator: strongValidator(header(headers, 'etag'))
        || header(headers, 'last-modified') || null,
      // From the URL the redirects actually landed on. `/get/latest?os=win`
      // redirecting to a CDN is the common shape, and naming the file from the
      // first URL saves an installer as "latest" with no extension.
      filename: filenameFor(res.finalUrl || this.url, header(headers, 'content-disposition')),
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

    // `allSettled`, not `all`, and this is a crash rather than a nicety.
    //
    // `Promise.all` rejects the moment one segment does, so `start()` ran its
    // `finally` - closing the file handle and setting it to null - while the
    // other three were still streaming. Their next `data` event called
    // `this.handle.write(...)` on null, and a TypeError thrown inside a stream
    // listener takes the whole main process down. One 503 on one connection was
    // enough to close the browser.
    //
    // Settling all of them first means nothing is still writing when the handle
    // goes; the first real failure is then re-thrown, so the download still
    // fails for the right reason.
    const results = await Promise.allSettled(jobs);
    const failure = results.find((r) => r.status === 'rejected');
    if (failure && !this.cancelled) throw failure.reason;
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

      // A destroyed Readable emits no `end`, and may emit no `error` either -
      // so the two paths below that call `res.destroy()` used to leave this
      // promise pending forever, wedging the whole download in `running` with
      // its file handle open. Both now say how they finished.
      let done = false;
      const succeed = () => { if (!done) { done = true; ended = true; settleIfDone(); } };
      const fail = (err) => { if (!done) { done = true; reject(err); } };

      res.on('data', (chunk) => {
        if (this.cancelled) { res.destroy(); fail(new Error('cancelled')); return; }
        const at = offsetOf();
        // A server that sends more than it was asked for must not be allowed to
        // write past its segment and over the next one's bytes.
        if (limit !== null && at + chunk.length - 1 > limit) {
          chunk = chunk.subarray(0, limit - at + 1);
          // Everything asked for has arrived; the rest is the server being
          // generous. Stop reading and call the segment complete.
          if (chunk.length === 0) { res.destroy(); succeed(); return; }
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
      res.on('error', fail);
      res.on('end', succeed);
      res.on('aborted', () => fail(new Error('the connection was closed early')));
      // Last resort: a stream that closes having emitted neither would
      // otherwise hang here, and a hung segment is indistinguishable from a
      // slow one until the user gives up.
      res.on('close', () => { if (!done) fail(new Error('the connection closed unexpectedly')); });
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
        // `session` matters: `will-download` fired inside the browsing session,
        // where the user is signed in. Re-fetching from the default session
        // sends no cookies, so a download behind a login quietly saves the
        // sign-in page under the real filename - the right size, the wrong file,
        // and no error anywhere.
        req = net.request({
          url,
          method: 'GET',
          redirect: 'manual',
          session: this.session || undefined,
          useSessionCookies: true
        });
      } catch (err) {
        reject(err);
        return;
      }
      for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);
      // Identity, always. Chromium decodes a compressed body transparently,
      // while Content-Length and every byte range describe the *encoded*
      // stream - so a gzipped download would write decoded bytes at offsets
      // computed for compressed ones, and fail its own length check while
      // silently interleaving segments wrongly.
      req.setHeader('Accept-Encoding', 'identity');

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
  /**
   * `dir` may be a function, so a changed download folder applies to the next
   * file. `saveAs(defaultPath)` resolves to a chosen path, null for cancelled,
   * or undefined to save without asking.
   */
  constructor({ dir, connections = () => 4, session = null, log = () => {}, onChange = () => {},
                saveAs = null }) {
    this.dir = dir;
    this.saveAs = saveAs;
    this.connections = connections;
    // The session the download was started from, so the refetch carries the
    // cookies the original request would have.
    this.session = session;
    this.log = log;
    this.onChange = onChange;
    /** @type {Map<string, Download>} */
    this.items = new Map();
  }

  /**
   * @param {string} url
   * @param {{session?: Electron.Session}} [options] - the session the download
   *   came from, when tabs do not all share one (incognito)
   */
  start(url, { session = null } = {}) {
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
      dir: typeof this.dir === 'function' ? this.dir() : this.dir,
      connections: this.connections(),
      session: session || this.session,
      saveAs: this.saveAs,
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

  /**
   * Where a finished download landed, by id.
   *
   * Separate from `snapshot()`, which is what crosses into a renderer: a
   * filesystem path is not something the chrome needs in order to draw a row,
   * and the one place it is needed - revealing or opening the file - is
   * resolved here from an id the renderer sends. So a compromised chrome can
   * ask to open *a download*, never an arbitrary path.
   *
   * Only a completed download has a file worth opening; a running one is a
   * partial, and a failed one was unlinked.
   */
  pathOf(id) {
    const item = this.items.get(id);
    return item && item.state === 'done' && item.file ? item.file : null;
  }

  /**
   * Just enough for the toolbar button, on the state broadcast.
   *
   * The whole list would be the wrong thing to push into three views twice a
   * second for a button that shows a count and a ring - the same reasoning that
   * keeps bookmarks and credentials off that message. The flyout asks for the
   * list when it opens, which is the only time anyone can read it.
   */
  summary() {
    let active = 0;
    let received = 0;
    let total = 0;
    for (const item of this.items.values()) {
      if (item.state !== 'running' && item.state !== 'starting') continue;
      active += 1;
      received += item.received || 0;
      total += item.total || 0;
    }
    return {
      count: this.items.size,
      active,
      // Null rather than zero where no running download has declared a size:
      // an empty ring and a ring at 0% mean different things.
      progress: total > 0 ? Math.max(0, Math.min(1, received / total)) : null
    };
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

/**
 * An ETag only if it is a strong one.
 *
 * `If-Range` is compared with strong comparison, so `W/"abc"` can never match
 * and the server answers with the whole file instead of the range. Since this
 * code reads an unexpected 200 as "the file changed underneath us", a weak ETag
 * turned every segmented download from nginx-with-gzip into a failure on a file
 * that had not changed at all.
 */
function strongValidator(etag) {
  if (typeof etag !== 'string') return null;
  return /^\s*W\//i.test(etag) ? null : etag;
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
  let name = String(raw || '').replace(/[\x00-\x1f\x7f]/g, '');
  name = name.split('/').pop();
  name = name.split('\\').pop();
  name = name.replace(/^\.+/, '');                       // no dotfiles, no ".."
  name = name.replace(/[<>:"|?*]/g, '_');                // illegal on Windows
  name = name.trim().slice(0, 180);
  // Windows drops trailing dots and spaces, so `evil.exe.` is saved as
  // `evil.exe` - a name other than the one the checks above looked at.
  name = name.replace(/[. ]+$/, '');
  // And reserves device names whatever the extension: `NUL.txt` opens the null
  // device, and the download is written to nowhere.
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name)) name = `_${name}`;
  return name || 'download';
}

/**
 * Never overwrite. `file.zip`, then `file (1).zip`.
 *
 * Creates the file as it chooses the name, with `wx`, rather than checking and
 * then opening: two downloads of one name starting together both found it
 * free and then wrote into the same file.
 */
async function openUnique(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  const candidates = function* () {
    yield name;
    for (let i = 1; i < 1000; i++) yield `${stem} (${i})${ext}`;
    yield `${stem}-${Date.now()}${ext}`;
  };
  for (const candidate of candidates()) {
    try {
      return { name: candidate, handle: await fs.promises.open(path.join(dir, candidate), 'wx') };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;              // taken: try the next
    }
  }
  throw new Error(`no free name for ${name} in ${dir}`);
}

module.exports = {
  DownloadManager,
  Download,
  sanitiseName,
  filenameFor,
  strongValidator,
  clampConnections,
  MIN_SEGMENTED_BYTES,
  MAX_CONNECTIONS
};
