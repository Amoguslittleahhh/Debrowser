'use strict';

/**
 * Fetching the page behind a link before it is clicked.
 *
 * A click on a link waits for the network before anything else can happen:
 * DNS, a connection, TLS, the server's own time, and only then does the page
 * start. Chrome hides most of that by fetching the page while the pointer is
 * on its way down - it rests on a link, or the button goes down - and handing
 * the navigation the response it already has. Chromium's machinery for this is
 * speculation rules, and Electron 44 honours the prefetch half (measured:
 * `deliveryType` "navigational-prefetch", the response already there 3 ms
 * into the navigation). Prerendering it does not; asked for, it falls back to
 * the same prefetch.
 *
 * The page preload (probe-preload.js) watches for that intent and, for one
 * link at a time, adds a rule naming exactly that link. It asks here first,
 * and this answers no when:
 *
 *   - the window is private. Nothing is fetched there that the user did not
 *     ask for, and a fetched-but-not-followed link is a request a site can
 *     see;
 *   - the setting is off (Settings, "Preload pages you point at");
 *   - the page's content security policy would refuse an inline rule. The
 *     rule would do nothing there, and a refused one can be reported to the
 *     site - a report saying this browser tried something, which is worse
 *     than no speed-up. The policy comes from the response headers, recorded
 *     below for documents only; a `<meta>` policy the preload checks itself.
 *
 * Chromium applies its own limits on top: a cross-site page is prefetched only
 * when the user holds no cookies for that site, so a prefetch never carries a
 * signed-in identity somewhere the user has not gone.
 */

const { ipcMain } = require('electron');

/** Documents whose policy we have seen, newest last; bounded. */
const MAX_REMEMBERED = 256;

class Speculation {
  /**
   * @param {object} deps
   * @param {() => boolean} deps.enabled - read live: the setting, and not private
   * @param {(sender) => boolean} deps.isTab - the sender is one of our tabs
   */
  constructor({ enabled, isTab }) {
    this.enabled = enabled;
    this.isTab = isTab;
    /** document URL -> may an inline speculation rule run there */
    this.allowed = new Map();
  }

  /**
   * Watch document responses in a session for their content security policy.
   * Documents only (the filter's `types`), so no image, script or font on a
   * page passes through here.
   */
  watch(session) {
    session.webRequest.onHeadersReceived(
      { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] },
      (details, callback) => {
        this.remember(details.url, inlineRulesAllowed(details.responseHeaders));
        callback({});
      });
  }

  remember(url, ok) {
    const key = stripHash(url);
    this.allowed.delete(key);
    this.allowed.set(key, ok);
    if (this.allowed.size > MAX_REMEMBERED) this.allowed.delete(this.allowed.keys().next().value);
  }

  /** The page's question: may it add a prefetch rule for `target`? */
  wire() {
    ipcMain.handle('debrowser:may-speculate', (event, target) => {
      if (!this.enabled() || !this.isTab(event.sender)) return false;
      const page = event.sender.getURL();
      if (!/^https?:/i.test(page) || !/^https?:/i.test(String(target || ''))) return false;
      // Unknown means the header was never seen - a page from the cache, say
      // - and is treated as no rather than guessed at.
      return this.allowed.get(stripHash(page)) === true;
    });
  }
}

const stripHash = (url) => String(url || '').split('#')[0];

/**
 * Whether a response's content security policy lets an inline
 * `<script type="speculationrules">` run: no policy governing scripts, or one
 * that allows inline scripts or speculation rules by name. A nonce or hash
 * makes 'unsafe-inline' ignored, so either one is a no.
 */
function inlineRulesAllowed(headers) {
  const values = [];
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() === 'content-security-policy') values.push(...[].concat(value));
  }
  for (const policy of values) {
    const directives = new Map(String(policy).split(';').map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0]).map(([name, ...rest]) => [name.toLowerCase(), rest.map((s) => s.toLowerCase())]));
    const sources = directives.get('script-src-elem') || directives.get('script-src') || directives.get('default-src');
    if (!sources) continue;
    if (sources.includes("'inline-speculation-rules'")) continue;
    const hashOrNonce = sources.some((s) => /^'(nonce|sha256|sha384|sha512)-/.test(s));
    if (sources.includes("'unsafe-inline'") && !hashOrNonce) continue;
    return false;
  }
  return true;
}

module.exports = { Speculation, inlineRulesAllowed };
