'use strict';

/**
 * What a tab shows when a page could not be loaded.
 *
 * Drawn into the error entry Chromium itself commits for a failed load,
 * rather than loaded as a page of its own. That entry already sits at the
 * address that failed, so the address bar keeps showing what the user typed,
 * Reload retries it, and Back goes where it went before. The page that used
 * to be here was a `data:` URL: the address bar showed a screen of encoded
 * HTML, Reload reloaded the error, and Back landed on a blank white entry.
 *
 * The document it is drawn into is Chromium's own `chrome-error://` page,
 * which has no origin and no privileges, and gets none from this: the
 * failing address is set as text, never parsed as markup, and "Try again"
 * is an ordinary `location.replace` - which retries in place, so trying ten
 * times does not leave ten entries behind.
 *
 * Pure apart from `show`, which only calls executeJavaScript: the smoke suite
 * reads `explain` directly.
 */

const palette = require('./palette');

/** net::ERR_ codes, and how each reads to someone who is not a network engineer. */
const OFFLINE = new Set([-106]);                                  // INTERNET_DISCONNECTED
const NOT_FOUND = new Set([-105, -137]);                          // NAME_NOT_RESOLVED, NAME_RESOLUTION_FAILED
const TIMED_OUT = new Set([-7, -118]);                            // TIMED_OUT, CONNECTION_TIMED_OUT
const REFUSED = new Set([-102]);                                  // CONNECTION_REFUSED
const DROPPED = new Set([-21, -100, -101, -109, -324]);           // NETWORK_CHANGED, CLOSED, RESET, UNREACHABLE, EMPTY_RESPONSE
const PROXY = new Set([-111, -130, -336]);                        // TUNNEL_CONNECTION_FAILED, PROXY_CONNECTION_FAILED, SOCKS_CONNECTION_FAILED

/**
 * The words for one failure.
 *
 * @returns {{title: string, detail: string, retryOnline: boolean}}
 *   `retryOnline`: the failure could be the network, so the page tries again
 *   by itself the moment the machine is back online.
 */
function explain(code, description, url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
  const site = host || 'The site';
  const n = Number(code);

  if (OFFLINE.has(n)) {
    return { title: 'You’re offline',
      detail: 'Check your connection. This page will load again as soon as you’re back online.', retryOnline: true };
  }
  if (NOT_FOUND.has(n)) {
    return { title: host ? `Can’t find ${host}` : 'Can’t find this site',
      detail: 'Check the address for a typo. If it’s right, the site may be down or no longer exist.', retryOnline: true };
  }
  if (TIMED_OUT.has(n)) {
    return { title: `${site} is taking too long to respond`,
      detail: 'It may be busy or down. Try again in a moment.', retryOnline: true };
  }
  if (REFUSED.has(n)) {
    return { title: `${site} refused to connect`,
      detail: 'It isn’t accepting connections right now. It may be down or restarting.', retryOnline: true };
  }
  if (DROPPED.has(n)) {
    return { title: `The connection to ${site} was interrupted`,
      detail: 'Try again. If it keeps happening, check your network.', retryOnline: true };
  }
  if (PROXY.has(n)) {
    return { title: 'Can’t reach the network',
      detail: 'The connection this window uses isn’t answering. Try again in a moment.', retryOnline: true };
  }
  if (n <= -200 && n > -300) {
    // Certificate errors. No way past this here, on purpose: a page that
    // cannot prove who it is should not get the user's typing.
    return { title: `${site} can’t prove it’s the real site`,
      detail: 'Its security certificate isn’t valid, so someone could be reading or changing this connection. Don’t continue here.',
      retryOnline: false };
  }
  if (n === -310) {
    return { title: `${site} is redirecting in a loop`,
      detail: 'Clearing this site’s cookies in Settings often fixes it.', retryOnline: false };
  }
  if (n === -20) {
    return { title: 'This page was blocked',
      detail: 'Debrowser stopped this address from loading.', retryOnline: false };
  }
  if (n === -312) {
    return { title: 'This address uses a blocked port',
      detail: 'Browsers refuse this port because it belongs to another kind of service, not to web pages.', retryOnline: false };
  }
  if (n === -6) {
    return { title: 'File not found',
      detail: 'It may have been moved, renamed or deleted.', retryOnline: false };
  }
  return { title: 'This page couldn’t be loaded',
    detail: 'Try again. If it keeps happening, the site may be having trouble.', retryOnline: true };
}

/** The page-side script. Serialised: it must not reference anything outside itself. */
function draw(e) {
  /* global document, location, addEventListener */
  const css = `
    :root { color-scheme: ${e.light ? 'light' : 'dark'}; }
    html, body { margin: 0; background: ${e.p.bg}; color: ${e.p.text}; }
    body { font: 14px/1.5 Aptos, Calibri, Carlito, "Segoe UI Variable Text", "Segoe UI", system-ui,
           -apple-system, Roboto, sans-serif; -webkit-font-smoothing: antialiased; cursor: default; }
    main { box-sizing: border-box; max-width: 30rem; margin: 22vh auto 0; padding: 0 28px; animation: in 180ms cubic-bezier(0.05, 0.7, 0.1, 1); }
    h1 { font-size: 19px; line-height: 1.3; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.005em; }
    p { margin: 0; color: ${e.p.dim}; }
    .actions { margin-top: 20px; display: flex; align-items: center; gap: 12px; }
    button { height: 32px; padding: 0 16px; border: 0; border-radius: 5px; font: inherit; cursor: default;
             background: ${e.accent}; color: #fff; transition: filter 120ms; }
    button:hover { filter: brightness(1.1); }
    button:active { filter: brightness(0.94); }
    button:focus-visible { outline: 2px solid ${e.accent}; outline-offset: 2px; }
    .code { font: 10.5px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; color: ${e.p.dim}; }
    @keyframes in { from { opacity: 0; transform: translateY(4px); } }
    @media (prefers-reduced-motion: reduce) { main { animation: none; } }`;
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  document.title = e.title;
  const style = el('style', css);
  const main = el('main');
  const actions = el('div', '', 'actions');
  const retry = el('button', 'Try again');
  retry.addEventListener('click', () => location.replace(e.url));
  actions.append(retry);
  if (e.code) actions.append(el('span', e.code, 'code'));
  main.append(el('h1', e.title), el('p', e.detail), actions);
  document.head.replaceChildren(style, el('title', e.title));
  document.body.replaceChildren(main);
  if (e.retryOnline) addEventListener('online', () => location.replace(e.url), { once: true });
}

/**
 * Draw the error page into `wc`, which has just committed Chromium's error
 * entry for `url`. Resolves whether it was drawn.
 */
async function show(wc, { code, description, url }) {
  const words = explain(code, description, url);
  const e = {
    ...words,
    url: String(url || ''),
    // The engine's name for it, small, for whoever wants to search for it.
    code: /^ERR_[A-Z_]+$/.test(String(description)) ? String(description) : '',
    ...palette.current()
  };
  // JSON, with `<` escaped: it is script source, and nothing in it is markup.
  const arg = JSON.stringify(e).replace(/</g, '\\u003c');
  try {
    await wc.executeJavaScript(`(${draw})(${arg}); true`);
    return true;
  } catch {
    return false;
  }
}

module.exports = { explain, show };
