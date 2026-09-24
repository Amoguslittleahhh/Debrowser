'use strict';

/**
 * What an incognito page may ask the network for.
 *
 * Two rules, applied to every request of every incognito session before it
 * leaves the browser:
 *
 *   1. Nothing on this machine or this network. A page cannot reach loopback,
 *      private ranges, link-local addresses or `.local` names. Those are where
 *      Tor's own ports are, where the router's admin page is, and where every
 *      other local service a machine runs lives - reaching them is both an
 *      attack path and a fingerprint ("this visitor has port 8080 open"), and
 *      they are addresses a Tor exit cannot reach anyway. Electron switches
 *      Chromium's own local-network-access checks off (the renderer command
 *      line says `--disable-features=LocalNetworkAccessChecks`), so this is the
 *      only such check there is.
 *
 *   2. HTTPS, or a page that says why not. A plain `http://` page travels in
 *      the clear from the Tor exit relay to the site, so the exit can read and
 *      change it - including anything typed into it. Top-level and frame
 *      navigations are upgraded; when the upgrade fails, the tab shows a page
 *      explaining the risk instead of silently falling back, and plain HTTP is
 *      allowed for that host only if the user says so, and only until the
 *      window closes. `.onion` sites are exempt: Tor encrypts them end to end.
 */

const net = require('net');

const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home.arpa', '.internal'];

/** Whether a host is this machine or its local network. */
function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true;

  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);            // carrier-grade NAT
  }
  if (net.isIPv6(host)) {
    if (host === '::1' || host === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return isLocalHost(mapped[1]);
    return /^f[cd][0-9a-f]{2}:/.test(host) ||      // unique local, fc00::/7
           /^fe[89ab][0-9a-f]:/.test(host);        // link-local, fe80::/10
  }
  return false;
}

/** Https URLs this policy made from http ones, so a failure can be recognised. */
const upgraded = new Map();
const UPGRADED_KEPT = 256;
/** Hosts the user has chosen to load over plain HTTP, for this window only. */
const httpAllowed = new Set();

const NAVIGATIONS = new Set(['mainFrame', 'subFrame']);

/**
 * The verdict for one request, in the shape `onBeforeRequest` takes.
 * Exported for the test suite, which checks the rules without a network.
 */
function judge({ url, resourceType }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  if (!/^(https?|wss?):$/.test(parsed.protocol)) return {};

  if (isLocalHost(parsed.hostname)) return { cancel: true };

  const onion = parsed.hostname.endsWith('.onion');
  if (parsed.protocol === 'http:' && NAVIGATIONS.has(resourceType) && !onion &&
      !httpAllowed.has(parsed.host)) {
    parsed.protocol = 'https:';
    const target = parsed.toString();
    upgraded.set(target, url);
    if (upgraded.size > UPGRADED_KEPT) upgraded.delete(upgraded.keys().next().value);
    return { redirectURL: target };
  }
  return {};
}

/**
 * A navigation failed. If it was one this policy upgraded, the plain-HTTP
 * address it came from - so the tab can explain rather than just fail.
 */
function upgradeFailed(url, errorCode) {
  if (errorCode === -3) return null;                 // superseded, not failed
  return upgraded.get(url) || null;
}

/** The user chose plain HTTP for this page's host, for the rest of this window. */
function allowHttp(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || isLocalHost(parsed.hostname)) return false;
    httpAllowed.add(parsed.host);
    return true;
  } catch {
    return false;
  }
}

/**
 * A site's onion address, from its `Onion-Location` header - honoured only on
 * an HTTPS page, as the Tor Project specifies, because on plain HTTP the exit
 * relay could have written the header itself and sent the tab anywhere.
 */
function onionFrom(pageUrl, headers) {
  let page;
  try { page = new URL(pageUrl); } catch { return null; }
  if (page.protocol !== 'https:') return null;
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === 'onion-location');
  const value = key && [].concat(headers[key])[0];
  if (!value) return null;
  try {
    const onion = new URL(String(value).trim());
    if (!/^https?:$/.test(onion.protocol) || !/\.onion$/.test(onion.hostname)) return null;
    return onion.toString();
  } catch {
    return null;
  }
}

/** Whether a URL is an onion site's. */
function isOnion(url) {
  try { return new URL(url).hostname.endsWith('.onion'); } catch { return false; }
}

/** Per tab (webContents id): the onion address its page offered, and its last status. */
const offered = new Map();
const statuses = new Map();

/**
 * Whether a finished page looks like a site refusing Tor.
 *
 * Exit relays are public, so some sites answer them with a block page or a
 * challenge. The status and a few markers the common ones use are enough to
 * say "try another exit" - and a wrong guess costs a reload, nothing more.
 */
const BLOCK_STATUSES = new Set([403, 429, 503]);
const BLOCK_MARKERS = /captcha|cf-chl|challenge-platform|just a moment|attention required|access denied|unusual traffic|are you a robot|blocked/i;
function looksBlocked(status, text) {
  return BLOCK_STATUSES.has(status) && BLOCK_MARKERS.test(String(text || ''));
}

function install(ses) {
  ses.webRequest.onBeforeRequest((details, callback) => callback(judge(details)));
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'mainFrame') {
      const onion = onionFrom(details.url, details.responseHeaders);
      if (onion) offered.set(details.webContentsId, onion);
      else offered.delete(details.webContentsId);
      statuses.set(details.webContentsId, details.statusCode);
    }
    callback({});
  });
}

module.exports = {
  isLocalHost, judge, upgradeFailed, allowHttp, install, onionFrom, looksBlocked, BLOCK_STATUSES, isOnion,
  onionFor: (wcId) => offered.get(wcId) || null,
  statusFor: (wcId) => statuses.get(wcId) ?? null,
  /** A tab's renderer is gone; what was recorded for it goes too. */
  forget: (wcId) => { offered.delete(wcId); statuses.delete(wcId); }
};
