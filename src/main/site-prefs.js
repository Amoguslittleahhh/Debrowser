'use strict';

/**
 * What the user chose for one website, remembered across restarts.
 *
 *   zoom      the zoom they set there (zoom.js decides when it applies)
 *   blocking  false when they turned the ad and tracker blocker off there
 *   sleep     'never' to keep its tabs awake, 'early' to let them sleep sooner
 *
 * Keyed by host, as Chromium keys zoom: a site's choices hold on all its pages
 * and both schemes. That is right for these three - none of them grants the
 * site anything, unlike the permissions in site-permissions.js, which are kept
 * per origin for exactly that reason.
 *
 * In memory only when `dir` is null, which is how a private window uses it:
 * nothing a private window does is written down.
 */

const fs = require('fs');
const path = require('path');
const { setAside } = require('./set-aside');

const FILE = 'site-prefs.json';
const MAX_SITES = 5000;
const SAVE_DELAY_MS = 400;

/** Each key, and what a stored value must look like to be believed. */
const VALID = {
  zoom: (v) => typeof v === 'number' && v >= 0.25 && v <= 5,
  blocking: (v) => v === false,
  sleep: (v) => v === 'never' || v === 'early'
};

const HOST = /^[a-z0-9.-]{1,253}$|^\[[0-9a-f:.]+\]$/i;

class SitePrefs {
  /**
   * @param {string|null} dir - where the file lives; null keeps it in memory
   * @param {(...args: any[]) => void} [log]
   */
  constructor(dir, log = () => {}) {
    this.file = dir ? path.join(dir, FILE) : null;
    this.log = log;
    /** host -> { zoom?, blocking?, sleep? } */
    this.sites = new Map();
    this.timer = null;
    this.load();
  }

  /** The host a URL's choices are kept under, or null for anything but a website. */
  static hostOf(url) {
    try {
      const parsed = new URL(url);
      return /^https?:$/.test(parsed.protocol) ? parsed.hostname : null;
    } catch {
      return null;
    }
  }

  load() {
    if (!this.file) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log(`site prefs: ${this.file} unreadable, starting empty (${err.message})`);
        if (err instanceof SyntaxError) setAside(this.file, this.log);
      }
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    for (const [host, entry] of Object.entries(parsed).slice(0, MAX_SITES)) {
      if (!HOST.test(host) || !entry || typeof entry !== 'object') continue;
      const clean = {};
      for (const [key, value] of Object.entries(entry)) {
        if (Object.hasOwn(VALID, key) && VALID[key](value)) clean[key] = value;
      }
      if (Object.keys(clean).length) this.sites.set(host, clean);
    }
  }

  /** Written a moment after the last change, so a run of zoom steps is one write. */
  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sites), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log(`site prefs: could not save (${err.message})`);
    }
  }

  get(host, key) {
    return host ? this.sites.get(host)?.[key] : undefined;
  }

  forHost(host) {
    return { ...(this.sites.get(host) || {}) };
  }

  /** Remember a choice; `undefined` or `null` forgets it. */
  set(host, key, value) {
    if (!host || !HOST.test(host) || !Object.hasOwn(VALID, key)) return;
    const entry = { ...(this.sites.get(host) || {}) };
    if (value === undefined || value === null) delete entry[key];
    else if (VALID[key](value)) entry[key] = value;
    else return;
    if (Object.keys(entry).length) this.sites.set(host, entry);
    else this.sites.delete(host);
    this.save();
  }

  /** The hosts with a given choice, e.g. every site kept awake. */
  hostsWith(key, value) {
    return [...this.sites].filter(([, e]) => e[key] === value).map(([h]) => h);
  }

  /**
   * One key as a Map-like store, for code that was written against a Map -
   * zoom.js keeps its per-site factors in one.
   */
  view(key) {
    return {
      get: (host) => this.get(host, key),
      set: (host, value) => this.set(host, key, value),
      delete: (host) => this.set(host, key, null)
    };
  }
}

module.exports = { SitePrefs };
