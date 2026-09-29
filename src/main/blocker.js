'use strict';

/**
 * The built-in ad and tracker blocker.
 *
 * Ghostery's engine (MPL-2.0, the one in Ghostery's own extension) with the
 * lists uBlock Origin users know: EasyList, EasyPrivacy, Peter Lowe's and
 * uBlock's own, plus - unless turned off - the cookie-notice lists, which hide
 * "we use cookies" banners without clicking anything in them.
 *
 * The lists are fetched and compiled once a week, after startup, and the
 * compiled engine is kept on disk, so a start reads one file instead of
 * parsing a hundred thousand rules. If a refresh fails, the last engine keeps
 * working, however old; with none at all the browser simply does not block
 * until one arrives.
 *
 * Three ways it acts on a page:
 *   - requests for ads and trackers are cancelled (web-hooks.js);
 *   - a page's own policy header can be tightened by a list's `$csp` rule;
 *   - "cosmetic" rules hide what is left - the empty ad frame, the cookie
 *     notice - through a small script the engine's package ships, which asks
 *     here for the rules that apply to its page.
 *
 * Off for a site when the user says so in the site panel (site-prefs.js), and
 * off everywhere with the setting. Never in a private window: Tor Browser's
 * reasoning holds - a blocker makes a browser that looks different from every
 * other copy of it, which is what a private window must not do.
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, net } = require('electron');
const { WebHooks } = require('./web-hooks');

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const FILE = 'engine.bin';

let ghostery = null;
const lib = () => (ghostery ||= require('@ghostery/adblocker-electron'));

/** Which lists, by the two settings. The cookie lists only when asked for. */
function listsFor(cookieBanners) {
  const { adsAndTrackingLists, fullLists } = lib();
  if (!cookieBanners) return adsAndTrackingLists;
  // fullLists adds "annoyances-others" too - newsletter pop-ups, social
  // widgets - which breaks more than it fixes for most people. Cookies only.
  return fullLists.filter((url) => adsAndTrackingLists.includes(url) || /cookie/i.test(url));
}

class ContentBlocker {
  /**
   * @param {object} opts
   * @param {string|null} opts.dir - where the compiled engine is kept; null: nowhere
   * @param {() => boolean} opts.enabled - the setting, read live
   * @param {() => boolean} opts.cookieBanners - the cookie-notice setting
   * @param {import('./site-prefs').SitePrefs} opts.sitePrefs - where the user turned it off
   * @param {(...a) => void} [opts.log]
   * @param {string|null} [opts.rules] - a list to use instead of the real ones (tests)
   */
  constructor({ dir, enabled, cookieBanners, sitePrefs, log = () => {}, rules = null }) {
    this.dir = dir ? path.join(dir, 'blocker') : null;
    this.enabled = enabled;
    this.cookieBanners = cookieBanners;
    this.sitePrefs = sitePrefs;
    this.log = log;
    this.rules = rules;
    this.engine = null;
    this.engineCookies = null;
    this.loading = null;
    /** Requests blocked since start, and per page (webContents id) since it last navigated. */
    this.total = 0;
    this.perPage = new Map();
    this.onBlocked = () => {};
  }

  get file() { return this.dir ? path.join(this.dir, FILE) : null; }

  /** Load the engine: the one on disk if it is fresh and built for these lists, else build one. */
  load() {
    if (this.loading) return this.loading;
    const cookies = this.cookieBanners() !== false;
    this.loading = this.build(cookies).then((engine) => {
      this.engine = engine;
      this.engineCookies = cookies;
      this.loadedAt = Date.now();
      return engine;
    }).catch((err) => {
      this.log(`blocker: no engine (${err?.message || err})`);
      return null;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  async build(cookies) {
    const { ElectronBlocker } = lib();
    if (this.rules !== null) return ElectronBlocker.parse(this.rules, { loadCosmeticFilters: true });

    const file = this.file;
    const meta = file ? `${file}.json` : null;
    let stale = null;
    if (file) {
      try {
        const info = JSON.parse(fs.readFileSync(meta, 'utf8'));
        const buffer = fs.readFileSync(file);
        const engine = ElectronBlocker.deserialize(new Uint8Array(buffer));
        this.builtAt = info.built;
        if (info.cookies === cookies && Date.now() - info.built < MAX_AGE_MS) return engine;
        stale = engine;
      } catch { /* none yet, or unreadable: build one */ }
    }
    try {
      // Chromium's network stack, not Node's: it follows the system's proxy.
      const engine = await ElectronBlocker.fromLists((url, init) => net.fetch(url, init), listsFor(cookies),
        { loadCosmeticFilters: true });
      if (file) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, engine.serialize());
        fs.renameSync(`${file}.tmp`, file);
        fs.writeFileSync(meta, JSON.stringify({ built: Date.now(), cookies }));
      }
      this.builtAt = Date.now();
      this.log(`blocker: lists compiled${cookies ? ', with cookie notices' : ''}`);
      return engine;
    } catch (err) {
      // Offline, or the lists' host is down: last week's engine beats none.
      if (stale) { this.log(`blocker: refresh failed, keeping the old lists (${err.message})`); return stale; }
      throw err;
    }
  }

  /**
   * Is blocking on for the page a request belongs to? The page is the top
   * document of the frame that asked - read from the frame first, because a
   * tab's own address can still be the one it is leaving while the new page's
   * first requests go out.
   */
  activeFor(wc, details = null) {
    if (!this.engine || this.enabled() === false) return false;
    const host = hostOf(safely(() => details?.frame?.top?.url)) ||
      hostOf(safely(() => (wc && !wc.isDestroyed() ? wc.getURL() : null))) ||
      hostOf(details?.referrer);
    return !host || this.onFor(host);
  }

  /** The user's choice for a site: on unless they turned it off there. */
  onFor(host) {
    return this.sitePrefs.get(host, 'blocking') !== false;
  }

  /** How many requests were blocked on this page since it loaded. */
  countFor(wc) {
    return (wc && this.perPage.get(wc.id)) || 0;
  }

  /** Start blocking in a session. */
  attach(session) {
    const hooks = WebHooks.for(session);
    hooks.onBeforeRequest((details) => {
      if (details.resourceType === 'mainFrame') {
        // A new page: its count starts again.
        if (details.webContentsId) this.perPage.delete(details.webContentsId);
        return undefined;
      }
      if (!this.activeFor(details.webContents, details)) return undefined;
      let out;
      this.engine.onBeforeRequest(details, (result) => { out = result; });
      if (out && (out.cancel || out.redirectURL)) {
        this.total += 1;
        const id = details.webContentsId;
        if (id) this.perPage.set(id, (this.perPage.get(id) || 0) + 1);
        this.onBlocked(id);
      }
      return out;
    });
    hooks.onHeadersReceived((details) => {
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return undefined;
      if (!this.activeFor(details.webContents, details)) return undefined;
      let out;
      this.engine.onHeadersReceived(details, (result) => { out = result; });
      return out;
    });

    session.registerPreloadScript({ type: 'frame', filePath: require.resolve('@ghostery/adblocker-electron-preload') });
    // Asked by that script, in every frame. Only a web page's frame gets an
    // answer, and only about itself: what comes back is styles and scripts put
    // into the frame that asked.
    const fromWeb = (event) => /^https?:/i.test(event.senderFrame?.url || '');
    ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
      if (!fromWeb(event) || !this.activeFor(event.sender, { frame: event.senderFrame })) return undefined;
      return this.engine.onInjectCosmeticFilters(event, event.senderFrame.url, msg);
    });
    ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) => {
      if (!fromWeb(event) || !this.activeFor(event.sender, { frame: event.senderFrame })) return false;
      return this.engine.onIsMutationObserverEnabled(event);
    });
  }

  /** A setting changed: build an engine if there is none, or if the cookie lists came or went. */
  refresh() {
    if (this.enabled() === false) return;
    if (!this.engine || this.engineCookies !== (this.cookieBanners() !== false)) this.load();
  }
}

function safely(read) {
  try { return read(); } catch { return null; }
}

function hostOf(url) {
  try { return url && /^https?:/i.test(url) ? new URL(url).hostname : null; } catch { return null; }
}

module.exports = { ContentBlocker, listsFor };
