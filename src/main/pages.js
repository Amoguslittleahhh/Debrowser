'use strict';

/**
 * The browser's own pages, served under `debrowser://`.
 *
 * Settings used to be a view laid over the content area. That was wrong in a way
 * worth recording, because it produced a bug that looked like a freeze: the
 * overlay covered every tab, nothing dismissed it, and switching tabs appeared
 * to do nothing at all. The browser was fine - it was drawing the page behind a
 * lid nobody had a handle for.
 *
 * The fix is not a dismiss call in more places. It is to stop pretending: a page
 * the user navigates to is a page, so it gets a URL, a tab, a title, a history
 * entry, and back and forward that work. Then there is no lid, because there is
 * no overlay.
 *
 * These pages are privileged - their preload can issue browser commands - so two
 * rules hold absolutely, and both are enforced rather than documented:
 *
 *   1. Only files that exist in the pages directory are served. The path is
 *      resolved and checked to be inside it, so `debrowser://settings/../../..`
 *      cannot walk out into the filesystem.
 *   2. An internal tab can never navigate to a web page. Without that, a link
 *      would carry a privileged preload to a site's own JavaScript.
 */

const path = require('path');
const fs = require('fs');
const { protocol, session } = require('electron');
const icons = require('./icons');

const SCHEME = 'debrowser';
// The renderer directory itself, flat.
//
// A `pages/` subdirectory was tried and rejected: the shared palette lives in
// theme.css beside the chrome and the task manager, and a separate root meant
// either copying it - the drift this project already removed once - or a
// traversal out of the root, which is the one thing the handler must refuse.
// Everything here is our own UI; none of it is secret, and serving it grants
// nothing, because privilege comes from the preload rather than the protocol.
const PAGES_DIR = path.join(__dirname, '..', 'renderer');

/** The pages that exist, and the file each one is. */
const PAGES = {
  newtab: 'newtab.html',
  settings: 'settings.html',
  history: 'history.html',
  downloads: 'downloads.html',
  // Incognito only: connecting to Tor, and what the connection does and does
  // not hide. Served to the normal browser too, where it has nothing to say.
  tor: 'tor.html',
  // Incognito only: a page asked for plain HTTP and HTTPS was not available.
  insecure: 'insecure.html',
  // Incognito only: the fingerprint self-check - what sites can read.
  fingerprint: 'fingerprint.html'
};

/** Where a new tab goes when the user has not chosen a homepage. */
const NEW_TAB_URL = `${SCHEME}://newtab`;
const SETTINGS_URL = `${SCHEME}://settings`;
const HISTORY_URL = `${SCHEME}://history`;
const DOWNLOADS_URL = `${SCHEME}://downloads`;
const TOR_URL = `${SCHEME}://tor`;
const INSECURE_URL = `${SCHEME}://insecure`;
const FINGERPRINT_URL = `${SCHEME}://fingerprint`;

/**
 * Must run before `app.whenReady()`.
 *
 * `standard` gives the scheme an origin, without which it has no localStorage,
 * no fetch, and a null origin that fails every same-origin check. `secure`
 * places it in a secure context, so it is not treated as mixed content.
 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }]);
}

/**
 * Answer with the file's bytes, read here rather than fetched.
 *
 * This used to be `net.fetch(pathToFileURL(full))`, which sends every request
 * for our own UI out through the network service and back. Measured, opening
 * three of the browser's own pages: **997.5ms in the handler against 7.6ms**
 * after this change - 2-6ms per sub-resource once warm and 60-270ms on the
 * first touch of each file, five requests per page, on the most-opened page in
 * the browser. A cold new tab page went from 1758ms to 131ms.
 *
 * An in-memory cache was built on top of this and then deleted, because it was
 * measured too: reading a page's five files costs **0.040ms**, and a Map lookup
 * 0.0003ms. Saving four hundredths of a millisecond is not worth 47KB per page
 * held for the life of the browser, nor the staleness that comes with it. The
 * win was never the cache; it was not using the network stack to read a file
 * off the local disk.
 *
 * `readFileSync`, not its async twin: these are tens of kilobytes from the page
 * cache or from inside the asar, the handler is already off the renderer's
 * critical path, and an async read here would add a promise tick to save
 * nothing measurable.
 */
function respond(full, log) {
  let body;
  try {
    body = fs.readFileSync(full);
  } catch (err) {
    // ENOENT is the ordinary case - a page asking for something that is not
    // there - and anything else is worth a line, because a permission error on
    // our own UI is a broken install rather than a 404.
    if (err.code !== 'ENOENT') log('pages', `could not read ${full}: ${err.message}`);
    return new Response('Not found', { status: 404 });
  }
  return new Response(body, { headers: { 'content-type': contentType(full) } });
}

/** What to call a file, from its extension. Chromium sniffs nothing here. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
};

function contentType(file) {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Serve the pages, on every session that needs them.
 *
 * `protocol.handle` registers on the *default* session only. Tabs run in the
 * `persist:debrowser` partition, which has a protocol registry of its own and
 * inherits nothing - so registering once left every internal page failing with
 * ERR_FAILED inside a tab while working perfectly in a default-session window,
 * which is exactly how this was nearly missed: the standalone render harness
 * used a default session and showed both pages correctly.
 *
 * @param {string[]} partitions - extra partitions to register on
 */
/** The one handler, built once and registered on every session that needs it. */
let handler = null;

function serve(log = () => {}, partitions = []) {
  const registries = [protocol, ...partitions.map((p) => session.fromPartition(p).protocol)];
  handler = async (request) => {
    const url = new URL(request.url);

    // Site icons are served rather than read from disk: they come off the
    // network, without cookies, and only for addresses this browser has been
    // told about. See icons.js - including the measurement showing that a
    // website can reach this handler, which is why there is an allowlist.
    if (url.hostname === 'icon') return icons.serve(request, log);
    // The host names the page; the path names a file belonging to it, so
    // `debrowser://settings/settings.css` works without a second registration.
    // `hasOwn`, because a bare index reaches the prototype chain:
    // `debrowser://__proto__` and `debrowser://constructor` both resolved to
    // something truthy, sailed past the `!file` guard below, and made
    // `path.resolve` throw out of an async handler instead of returning 404.
    const file = url.pathname === '/' || url.pathname === ''
      ? (Object.hasOwn(PAGES, url.hostname) ? PAGES[url.hostname] : null)
      : url.pathname.slice(1);

    if (!file) return new Response('Not found', { status: 404 });

    // Resolve first, then check containment. Checking the unresolved string
    // would pass `..` straight through.
    const full = path.resolve(PAGES_DIR, file);
    if (full !== PAGES_DIR && !full.startsWith(PAGES_DIR + path.sep)) {
      log('pages', `refused a path outside the pages directory: ${file}`);
      return new Response('Forbidden', { status: 403 });
    }
    return respond(full, log);
  };

  for (const registry of registries) {
    try {
      registry.handle(SCHEME, handler);
    } catch (err) {
      // Already registered on this session is harmless; anything else is not.
      log('pages', `could not register ${SCHEME}: ${err.message}`);
    }
  }
}

/**
 * Register our pages on a session made after startup - incognito makes one per
 * tab - so a private tab can open the new tab page like any other.
 */
function serveSession(ses, log = () => {}) {
  if (!handler) return;
  try {
    ses.protocol.handle(SCHEME, handler);
  } catch (err) {
    log('pages', `could not register ${SCHEME}: ${err.message}`);
  }
}

/** Is this one of ours? */
function isInternal(url) {
  return typeof url === 'string' && url.startsWith(`${SCHEME}://`);
}

/** The page name in a `debrowser://` URL, or null. */
function pageName(url) {
  if (!isInternal(url)) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** What the tab strip should call it. */
function titleFor(url) {
  switch (pageName(url)) {
    case 'settings': return 'Settings';
    case 'newtab': return 'New tab';
    case 'history': return 'History';
    case 'downloads': return 'Downloads';
    case 'tor': return 'Private connection';
    case 'insecure': return 'Not private';
    case 'fingerprint': return 'What sites can see';
    default: return 'Debrowser';
  }
}

module.exports = {
  SCHEME, PAGES, PAGES_DIR, NEW_TAB_URL, SETTINGS_URL, HISTORY_URL, DOWNLOADS_URL, TOR_URL,
  INSECURE_URL, FINGERPRINT_URL, registerScheme, serveSession, serve, isInternal, pageName, titleFor
};
