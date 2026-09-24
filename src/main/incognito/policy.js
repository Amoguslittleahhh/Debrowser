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

function install(ses) {
  ses.webRequest.onBeforeRequest((details, callback) => callback(judge(details)));
}

module.exports = { isLocalHost, judge, upgradeFailed, allowHttp, install };
