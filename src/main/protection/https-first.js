'use strict';

/**
 * HTTPS first, for the ordinary browser.
 *
 * A plain-HTTP address - a link, a bookmark, something typed - is tried over
 * HTTPS first. Most sites offer both, and the HTTPS one cannot be read or
 * changed by the network in between. What happens when a site has no HTTPS is
 * the setting (`httpsMode`):
 *
 *   upgrade  the plain page loads, as before; the padlock says it is not
 *            secure. The default, and what Chrome and Firefox do by default.
 *   strict   a page says the site has no secure version, with Continue - as
 *            Chrome's "Always use secure connections" and Firefox's
 *            HTTPS-Only mode do. Continue holds for that site until restart.
 *   off      nothing is changed.
 *
 * Main-frame navigations only: a secure page's plain subresources are already
 * upgraded or blocked by Chromium itself, and a plain page's are its own
 * business. Hosts on this machine or its network, and names that cannot be on
 * the public internet (`printer`, `nas.local`, `site.test`), are left alone:
 * they rarely have certificates, and never public ones.
 *
 * Private windows have their own, stricter rule (incognito/policy.js).
 */

const { isLocalHost } = require('../incognito/policy');
const { WebHooks } = require('../web-hooks');

/** Names reserved for testing, examples and private networks (RFC 2606, 6761, 8375). */
const RESERVED = ['.test', '.example', '.invalid', '.localhost', '.local', '.lan', '.home.arpa', '.internal', '.corp'];

/** The failures that mean "this site has no working HTTPS", not "the network is down". */
const NO_HTTPS = new Set([
  -107, // SSL_PROTOCOL_ERROR
  -113, // SSL_VERSION_OR_CIPHER_MISMATCH
  -102, // CONNECTION_REFUSED
  -100, // CONNECTION_CLOSED
  -101, // CONNECTION_RESET
  -118, // CONNECTION_TIMED_OUT
  -20,  // BLOCKED_BY_CLIENT: our own cancel of a redirect loop, below
  -310  // TOO_MANY_REDIRECTS
]);
/** Certificate errors (-200 to -299): the HTTPS version is there but not trustworthy. */
const isCertError = (code) => code <= -200 && code > -300;

const KEPT = 256;
const LOOP_MS = 5000;

class HttpsFirst {
  /** The ordinary browser's one instance, for the tabs to consult (tab.js). */
  static current = null;

  /** @param {() => ('upgrade'|'strict'|'off')} mode - the setting, read live */
  constructor(mode) {
    this.mode = mode;
    /** https URL we made -> { from: the http URL, at } */
    this.upgraded = new Map();
    /** Hosts allowed over plain HTTP until restart: a failed upgrade, or Continue. */
    this.allowed = new Set();
    /** http URLs whose upgrade came straight back to http - a site that redirects down. */
    this.looped = new Set();
  }

  static eligible(parsed) {
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('.') || isLocalHost(host)) return false;
    return !RESERVED.some((suffix) => host.endsWith(suffix));
  }

  /** The verdict for one request, as `onBeforeRequest` takes it. */
  judge({ url, resourceType }) {
    if (resourceType !== 'mainFrame' || this.mode() === 'off') return undefined;
    let parsed;
    try { parsed = new URL(url); } catch { return undefined; }
    if (parsed.protocol !== 'http:' || this.allowed.has(parsed.host) || !HttpsFirst.eligible(parsed)) return undefined;
    parsed.protocol = 'https:';
    const target = parsed.toString();
    // The https page sent us straight back to http: upgrading again would go
    // round for ever. Stopped, and treated as a site with no HTTPS.
    const before = this.upgraded.get(target);
    if (before && Date.now() - before.at < LOOP_MS) {
      this.looped.add(url);
      this.upgraded.delete(target);
      return { cancel: true };
    }
    this.upgraded.set(target, { from: url, at: Date.now() });
    if (this.upgraded.size > KEPT) this.upgraded.delete(this.upgraded.keys().next().value);
    return { redirectURL: target };
  }

  /**
   * A main-frame load failed. If it was an upgrade of ours that found no
   * working HTTPS, the plain address - for the tab to load (upgrade mode) or
   * to explain (strict mode). Null otherwise.
   */
  failed(url, errorCode) {
    if (errorCode === -3) return null;               // superseded, not failed
    if (this.looped.delete(url)) return url;
    const entry = this.upgraded.get(url);
    if (!entry || !(NO_HTTPS.has(errorCode) || isCertError(errorCode))) return null;
    this.upgraded.delete(url);
    return entry.from;
  }

  /** Plain HTTP for this page's host, until restart. */
  allow(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:') return false;
      this.allowed.add(parsed.host);
      return true;
    } catch {
      return false;
    }
  }

  attach(session) {
    const hooks = WebHooks.for(session);
    hooks.onBeforeRequest((details) => this.judge(details));
    hooks.onHeadersReceived((details) => this.answered(details));
  }

  /**
   * The upgraded page answered. Anything but a redirect means HTTPS works, and
   * the upgrade is forgotten - so the same http link clicked again moments
   * later is upgraded again rather than taken for a loop, and a later failure
   * of the https page is not taken for "this site has no HTTPS". A redirect is
   * kept: if it leads back to http, that is the loop `judge` stops.
   */
  answered({ url, resourceType, statusCode }) {
    if (resourceType !== 'mainFrame' || !this.upgraded.has(url)) return undefined;
    if (!(statusCode >= 300 && statusCode < 400)) this.upgraded.delete(url);
    return undefined;
  }
}

module.exports = { HttpsFirst };
