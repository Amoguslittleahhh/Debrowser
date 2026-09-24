'use strict';

/**
 * Site icons, fetched by the browser rather than by the page that shows them.
 *
 * Three views draw a site's logo - the tab strip, the task manager and the
 * history list - and the obvious way to do that is to point an `<img>` at the
 * site's own favicon address. That works, and it has a problem worth more than
 * the convenience: an `<img>` in a page is fetched *by that page*, with that
 * session's cookies. Opening a history list of two hundred sites would send a
 * cookie-bearing request to every one of them, announcing that the user is
 * looking at their history. Chrome does not do that; it keeps a local favicon
 * store and serves from it.
 *
 * So the pages ask `debrowser://icon?url=…` instead, and the fetch happens
 * here, in the browser process, with `credentials: 'omit'` - no cookies, no
 * session, no identity. The net stack caches the result, so a redraw costs
 * nothing.
 *
 * ## Why there is an allowlist
 *
 * Measured, and the reason this file is not fifteen lines: **a website can
 * reference `debrowser://` subresources.** A probe embedding
 * `<img src="debrowser://icon?url=…">` in a plain http page reached this
 * handler. Without a restriction the route would be a general-purpose fetch
 * proxy that any site could aim at any address - stripped of cookies, but also
 * stripped of that page's own CSP and of mixed-content blocking, which are
 * exactly the protections it would be worth bypassing.
 *
 * The referrer is not the answer either: the same probe showed it arrives
 * *empty* for our own pages and populated for the website, so a rule could be
 * written - and a hostile page can send an empty one on purpose with
 * `referrerpolicy="no-referrer"`. It is not a boundary.
 *
 * What is a boundary is: only fetch an icon this browser has already been told
 * about. Two things qualify, and nothing else:
 *
 *   1. `<origin>/favicon.ico` - the well-known path, the one Chromium itself
 *      tries, and a URL any page could already request directly with cookies
 *      attached. Allowing it grants nothing that was not already available.
 *   2. An address Chromium reported for a page the user actually loaded, or
 *      one the history store recorded from such a page. Getting a URL into
 *      that set means having been visited, at which point the icon has already
 *      been fetched once by the page itself.
 */

const { net } = require('electron');

/**
 * Where icon fetches go out from. The default session in the normal browser;
 * in incognito, the in-memory browsing partition, so an icon is neither sent
 * outside the private session's routing nor cached on disk by the default
 * session, which is the one Chromium keeps a profile directory for.
 */
let fetcher = (url, init) => net.fetch(url, init);
function useSession(ses) {
  fetcher = (url, init) => ses.fetch(url, init);
}

/** Longest an icon fetch may take before the row falls back to its letter. */
const TIMEOUT_MS = 6000;

/** A favicon larger than this is not a favicon. */
const MAX_BYTES = 256 * 1024;

/**
 * How many reported icon addresses are remembered.
 *
 * Bounded because this is the browser process and the set would otherwise grow
 * with every distinct site of a long session. Oldest out first: a Set iterates
 * in insertion order, so the eviction is the first key it yields.
 */
const MAX_REMEMBERED = 2000;

/** @type {Set<string>} icon addresses Chromium has reported to us */
const seen = new Set();

/** Is this an address we are willing to fetch at all? */
function parse(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url;
}

/**
 * Note an icon address Chromium reported, so it may later be fetched.
 *
 * Called for every `page-favicon-updated`, and once at startup for the
 * addresses the history store already holds - those came from this same event
 * in an earlier session.
 */
function remember(raw) {
  const url = parse(raw);
  if (!url) return false;
  if (seen.has(url.href)) return true;
  if (seen.size >= MAX_REMEMBERED) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  seen.add(url.href);
  return true;
}

/** Remember a list, ignoring anything unusable. Returns how many were kept. */
function rememberAll(list) {
  let kept = 0;
  for (const raw of list || []) if (remember(raw)) kept++;
  return kept;
}

/**
 * The paths a site's icon is at when the page never said.
 *
 * Both are fixed paths on the page's own origin, which is what keeps them
 * inside what this route will fetch without having been told: a page cannot
 * name them, it can only be on the origin they belong to. `apple-touch-icon` is
 * here because a real number of sites ship one and no favicon.ico, and the
 * alternative for those is the letter chip - which is what apple.com showed
 * until the renderer started trying more than one address. See `showIcon` in
 * theme.js, which decides the order.
 */
const DEFAULT_PATHS = new Set(['/favicon.ico', '/apple-touch-icon.png']);

/**
 * May this address be fetched? A default path is always allowed; anything
 * else has to have been reported for a page that was actually loaded.
 */
function allowed(raw) {
  const url = parse(raw);
  if (!url) return false;
  if (DEFAULT_PATHS.has(url.pathname) && !url.search) return true;
  return seen.has(url.href);
}

/**
 * Serve `debrowser://icon?url=…`.
 *
 * Every refusal is a 404 rather than a 403, and that is deliberate: the `<img>`
 * fires `error` either way and falls back to the site's letter, so there is one
 * failure path for "not allowed", "did not answer", "answered with a page
 * instead of an image" and "took too long".
 */
async function serve(request, log = () => {}) {
  const target = new URL(request.url).searchParams.get('url');
  if (!allowed(target)) {
    log('icons', `refused ${String(target).slice(0, 120)}`);
    return new Response('Not found', { status: 404 });
  }

  try {
    const res = await fetcher(target, {
      // No cookies, no identity. The whole point of routing through here.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) return new Response('Not found', { status: 404 });

    const type = res.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) return new Response('Not found', { status: 404 });

    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length || body.length > MAX_BYTES) return new Response('Not found', { status: 404 });

    return new Response(body, {
      headers: {
        'Content-Type': type,
        // A site's icon does not change often, and a redraw of the history list
        // should not be a round trip per row.
        'Cache-Control': 'public, max-age=86400'
      }
    });
  } catch (err) {
    log('icons', `${target}: ${err.message}`);
    return new Response('Not found', { status: 404 });
  }
}

module.exports = { remember, rememberAll, allowed, serve, useSession, MAX_REMEMBERED };
