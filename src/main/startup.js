'use strict';

/**
 * What a start opens, besides the tab in front.
 *
 * Two things carry across a start even with "Reopen your tabs" off:
 *
 *  - Pinned tabs. Pinning is saying "I always want this one", and losing them
 *    at every start made the pin worth nothing to anyone who starts fresh.
 *  - The startup sites from Settings: the day's usual places, so the first
 *    minute of the day is not spent opening the same six sites by hand.
 *
 * Both open asleep - a strip entry and an address, no renderer - which is the
 * state a tab the governor has put away is in. Ten of them cost about what one
 * new tab costs until one is clicked. That is the whole argument of this
 * browser, made at the first moment it is opened.
 *
 * Pure, so the smoke test can check the plan without restarting the browser.
 */

/** At most this many startup sites: past it, the list is a session, not a start. */
const MAX_SITES = 20;

/**
 * Read the Settings list: one address per line. A bare name gets https://;
 * anything that is not http(s) once read - a file, a script, a typo - is left
 * out rather than opened. Duplicates go too.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseSites(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let url;
    try {
      // A scheme is a name and a colon not followed by a digit: after
      // "localhost:" a digit is a port, and the address still needs https://.
      url = new URL(/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(line) ? line : `https://${line}`);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') continue;
    const href = url.href;
    if (!out.includes(href)) out.push(href);
    if (out.length >= MAX_SITES) break;
  }
  return out;
}

/**
 * The same page for this purpose: ignoring the scheme, www and a trailing
 * slash, but not the query or the hash - youtube.com/watch?v=A and ?v=B are
 * two videos, and Gmail's #inbox and #inbox/thread two places.
 */
function placeKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}${u.hash}`;
  } catch {
    return String(url);
  }
}

/**
 * The tabs to open asleep at this start, in strip order: pinned ones first,
 * then the startup sites that are not already one of them.
 *
 * @param {object} p
 * @param {boolean} p.restoring - last time's tabs are coming back anyway
 * @param {Array<{url: string, title?: string, pinned?: boolean}>} p.lastSession
 * @param {string} p.sitesText - the Settings list
 * @returns {Array<{url: string, title: string, pinned: boolean}>}
 */
function startupTabs({ restoring, lastSession, sitesText }) {
  if (restoring) return [];
  const pinned = (lastSession || [])
    .filter((entry) => entry && entry.pinned === true && typeof entry.url === 'string')
    .map((entry) => ({ url: entry.url, title: entry.title || '', pinned: true }));
  const taken = new Set(pinned.map((entry) => placeKey(entry.url)));
  const sites = parseSites(sitesText)
    .filter((url) => !taken.has(placeKey(url)))
    .map((url) => ({ url, title: '', pinned: false }));
  return [...pinned, ...sites];
}

module.exports = { parseSites, startupTabs, placeKey, MAX_SITES };
