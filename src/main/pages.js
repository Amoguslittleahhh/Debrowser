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
const { pathToFileURL } = require('url');
const fs = require('fs');
const { protocol, net, session } = require('electron');
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
  history: 'history.html'
};

/** Where a new tab goes when the user has not chosen a homepage. */
const NEW_TAB_URL = `${SCHEME}://newtab`;
const SETTINGS_URL = `${SCHEME}://settings`;
const HISTORY_URL = `${SCHEME}://history`;

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
function serve(log = () => {}, partitions = []) {
  const registries = [protocol, ...partitions.map((p) => session.fromPartition(p).protocol)];
  const handler = async (request) => {
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
    if (!fs.existsSync(full)) return new Response('Not found', { status: 404 });

    // pathToFileURL, not string concatenation: a `#` in an install path
    // truncates the URL at the fragment and a `%` begins a broken escape, so
    // every internal page would 404 for anyone whose folder contains one.
    return net.fetch(pathToFileURL(full).href);
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
    default: return 'Debrowser';
  }
}

module.exports = {
  SCHEME, PAGES, PAGES_DIR, NEW_TAB_URL, SETTINGS_URL, HISTORY_URL,
  registerScheme, serve, isInternal, pageName, titleFor
};
