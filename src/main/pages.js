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
const { protocol, net } = require('electron');

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
  settings: 'settings.html'
};

/** Where a new tab goes when the user has not chosen a homepage. */
const NEW_TAB_URL = `${SCHEME}://newtab`;
const SETTINGS_URL = `${SCHEME}://settings`;

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

/** Serve the pages. Called once, after the app is ready. */
function serve(log = () => {}) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    // The host names the page; the path names a file belonging to it, so
    // `debrowser://settings/settings.css` works without a second registration.
    const file = url.pathname === '/' || url.pathname === ''
      ? PAGES[url.hostname]
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

    return net.fetch(`file://${full}`);
  });
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
    default: return 'Debrowser';
  }
}

module.exports = {
  SCHEME, PAGES, PAGES_DIR, NEW_TAB_URL, SETTINGS_URL,
  registerScheme, serve, isInternal, pageName, titleFor
};
