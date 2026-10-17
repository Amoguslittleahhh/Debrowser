'use strict';

/**
 * New releases, found by asking GitHub directly.
 *
 * The updater only knows about a new version where it can install one: not
 * for a .deb or .rpm, not from source, and not while updates are turned off.
 * The release notes page wants to know regardless, so it can say "2.5.0 is
 * out" on every install. This asks GitHub's releases list, picks the newest
 * version for the update channel in use, and keeps what it found on disk:
 *
 *   - At most once an hour, and again whenever the installed version changes
 *     (an update just landed), so opening the page costs nothing most times.
 *   - With the last answer's ETag, so an unchanged list is a 304 that counts
 *     against nothing and sends nothing back.
 *   - Draft releases never count. Prereleases count only on the Beta channel.
 *     Tags that are not plain versions (v1.2.1-intune-only) are skipped.
 *   - A failure keeps the last answer; the page never waits more than eight
 *     seconds for it.
 *
 * Each release's body is kept too, so a version the packed CHANGELOG.md does
 * not have - a build from before its notes were written, or a damaged file -
 * still gets its notes after an update.
 */

const fs = require('fs');
const { notesFor } = require('./whats-new');

const RELEASES_URL = 'https://api.github.com/repos/Amoguslittleahhh/Debrowser/releases?per_page=30';
const FRESH_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const BODY_MAX = 40_000;

/** `v2.4.0` or `v2.5.0-beta.1` → comparable parts, or null for anything else. */
function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.?(\d+))?$/.exec(String(tag).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], beta: m[4] === undefined ? null : +m[4],
    version: String(tag).trim().replace(/^v/, '') };
}

/** Negative, zero or positive, as `a` is older than, the same as or newer than `b`. */
function compare(a, b) {
  const pa = typeof a === 'string' ? parseVersion(a) : a;
  const pb = typeof b === 'string' ? parseVersion(b) : b;
  if (!pa || !pb) return 0;
  for (const k of ['major', 'minor', 'patch']) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  // A beta comes before the release it leads up to.
  if (pa.beta === pb.beta) return 0;
  if (pa.beta === null) return 1;
  if (pb.beta === null) return -1;
  return pa.beta - pb.beta;
}

/** The releases that count for this channel, newest first. */
function eligible(releases, channel) {
  return (releases || [])
    .filter((r) => r && !r.draft && (channel === 'beta' || !r.prerelease) && parseVersion(r.tag))
    .sort((a, b) => compare(b.tag, a.tag));
}

/**
 * The newest release for the channel, and whether it is newer than what is
 * installed. `newer` lists every release between the two, newest first.
 */
function pick(releases, { channel = 'stable', current }) {
  const list = eligible(releases, channel);
  const latest = list[0] || null;
  return {
    latest: latest ? { version: parseVersion(latest.tag).version, date: latest.date || null } : null,
    newer: list.filter((r) => compare(r.tag, current) > 0).map((r) => parseVersion(r.tag).version)
  };
}

/**
 * A release body's notes. The body is the changelog section with a header
 * (version line, download table) above it and a footer (links, checksums,
 * credit) below; both are dropped and the rest read as the changelog is.
 */
function bodyNotes(body, version) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('### ') || /^- \*\*/.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && (/^---\s*$/.test(l) || /^Released by /.test(l) || /SHA-256/i.test(l)));
  if (end < 0) end = lines.length;
  const notes = notesFor(`## ${version}\n\n${lines.slice(start, end).join('\n')}\n`, version);
  return notes && notes.sections.length ? notes : null;
}

class ReleaseFeed {
  /**
   * @param {{file: string, fetch: Function, channel: () => string, current: string, log?: Function, now?: () => number}} opts
   */
  constructor({ file, fetch, channel, current, log = () => {}, now = Date.now }) {
    this.file = file;
    this.fetch = fetch;
    this.channel = channel;
    this.current = current;
    this.log = log;
    this.now = now;
    this.inFlight = null;
    this.cache = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data && Array.isArray(data.releases)) return data;
    } catch { /* first run, or a damaged file: ask again */ }
    return { at: 0, etag: null, appVersion: null, releases: [] };
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.cache), { mode: 0o600 });
    } catch (err) {
      this.log('release-feed', `could not save: ${err.message}`);
    }
  }

  /** Stale after an hour, and straight away once a different version runs. */
  stale() {
    return this.cache.appVersion !== this.current || this.now() - this.cache.at > FRESH_MS;
  }

  /** Ask GitHub if the last answer is stale. Never throws; never waits past the timeout. */
  refresh({ force = false } = {}) {
    if (!force && !this.stale()) return Promise.resolve(false);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.ask().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async ask() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `Debrowser/${this.current}` };
      // An unchanged list only counts when it was asked for this version.
      if (this.cache.etag && this.cache.appVersion === this.current) headers['If-None-Match'] = this.cache.etag;
      const res = await this.fetch(RELEASES_URL, { headers, signal: controller.signal });
      if (res.status === 304) {
        this.cache.at = this.now();
      } else if (res.ok) {
        const list = await res.json();
        this.cache.releases = (Array.isArray(list) ? list : []).map((r) => ({
          tag: String(r.tag_name || ''),
          draft: r.draft === true,
          prerelease: r.prerelease === true,
          date: r.published_at || null,
          body: String(r.body || '').slice(0, BODY_MAX)
        }));
        this.cache.etag = res.headers.get('etag');
        this.cache.at = this.now();
      } else {
        this.log('release-feed', `GitHub answered ${res.status}`);
        return false;
      }
      this.cache.appVersion = this.current;
      this.save();
      return true;
    } catch (err) {
      this.log('release-feed', `check failed: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** What the last answer says, for the version installed. */
  status() {
    return pick(this.cache.releases, { channel: this.channel(), current: this.current });
  }

  /** Notes for released versions up to the installed one, from their bodies. */
  releasedNotes() {
    return eligible(this.cache.releases, this.channel())
      .filter((r) => compare(r.tag, this.current) <= 0)
      .map((r) => bodyNotes(r.body, parseVersion(r.tag).version))
      .filter(Boolean);
  }
}

module.exports = { ReleaseFeed, parseVersion, compare, eligible, pick, bodyNotes, RELEASES_URL };
