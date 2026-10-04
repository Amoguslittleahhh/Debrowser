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
 * The words for one failure, and what to do about it.
 *
 * @returns {{kind: string, title: string, detail: string, tips: string[],
 *            retryOnline: boolean, search: boolean, safe: boolean}}
 *   `retryOnline`: the failure could be the network, so the page tries again
 *   by itself the moment the machine is back online. `search`: offer to
 *   search for the name instead. `safe`: false where trying again is not the
 *   answer - a certificate that does not check out - and Back leads.
 */
function explain(code, description, url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
  const site = host || 'The site';
  const n = Number(code);
  const words = (kind, title, detail, tips, more = {}) =>
    ({ kind, title, detail, tips, retryOnline: true, search: false, safe: true, ...more });

  if (OFFLINE.has(n)) {
    return words('offline', 'You’re offline', 'This page will load by itself as soon as you’re back online.', [
      'Check that Wi‑Fi is on, or that the network cable is plugged in',
      'Turn off airplane mode',
      'Restart your router if other devices can’t connect either'
    ]);
  }
  if (NOT_FOUND.has(n)) {
    return words('not-found', host ? `Can’t find ${host}` : 'Can’t find this site',
      'The address may have a typo, or the site may be down or no longer exist.', [
        'Check the spelling of the address',
        'Search for the site instead',
        'If no site opens, check your connection'
      ], { search: Boolean(host) });
  }
  if (TIMED_OUT.has(n)) {
    return words('slow', `${site} is taking too long to respond`, 'It may be busy or down.', [
      'Try again in a moment',
      'Check whether other sites open'
    ]);
  }
  if (REFUSED.has(n)) {
    return words('refused', `${site} refused to connect`,
      'It isn’t accepting connections right now. It may be down or restarting.', [
        'Try again in a moment',
        'Check the address, including any port number after a colon'
      ]);
  }
  if (DROPPED.has(n)) {
    return words('dropped', `The connection to ${site} was interrupted`, 'Your network may have changed or dropped out for a moment.', [
      'Try again',
      'If it keeps happening, check your Wi‑Fi or network cable'
    ]);
  }
  if (PROXY.has(n)) {
    return words('proxy', 'Can’t reach the network', 'The connection this window uses isn’t answering.', [
      'Try again in a moment',
      'If you use a proxy or VPN, check that it’s running'
    ]);
  }
  if (n <= -200 && n > -300) {
    // Certificate errors. No way past this here, on purpose: a page that
    // cannot prove who it is should not get the user's typing.
    return words('insecure', `${site} can’t prove it’s the real site`,
      'Its security certificate isn’t valid, so someone could be reading or changing this connection. Don’t continue here.', [
        'Check that your computer’s date and time are right',
        'If you’re on public Wi‑Fi, sign in to it first, then try again'
      ], { retryOnline: false, safe: false });
  }
  if (n === -310) {
    return words('loop', `${site} is redirecting in a loop`, 'The page keeps sending the browser back to itself.', [
      'Clear this site’s cookies in Settings, then try again'
    ], { retryOnline: false });
  }
  if (n === -20) {
    return words('blocked', 'This page was blocked', 'Debrowser stopped this address from loading.', [], { retryOnline: false });
  }
  if (n === -312) {
    return words('blocked', 'This address uses a blocked port',
      'Browsers refuse this port because it belongs to another kind of service, not to web pages.', [], { retryOnline: false });
  }
  if (n === -6) {
    return words('file', 'File not found', 'It may have been moved, renamed or deleted.', [], { retryOnline: false });
  }
  return words('generic', host ? `Can’t load ${host}` : 'This page couldn’t be loaded',
    'The site may be having trouble.', ['Try again in a moment']);
}

/** One stroke icon per kind, in the browser's own icon style (16-unit grid). */
const ICONS = {
  offline: '<path d="M2 6.2a9 9 0 0 1 3.1-1.9M8 3.5a9 9 0 0 1 6 2.7M4.2 8.6a5.4 5.4 0 0 1 2.2-1.3M10.3 7.5a5.4 5.4 0 0 1 1.5 1.1M6.4 11a2.3 2.3 0 0 1 3.2 0M2.5 2.5l11 11"/>',
  'not-found': '<circle cx="7" cy="7" r="4.5"/><path d="M10.3 10.3L14 14M5.8 5.6a1.3 1.3 0 1 1 1.6 1.3c-.3.1-.4.3-.4.6v.3M7 9.3v.01"/>',
  slow: '<circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5M6.5 1.5h3"/>',
  refused: '<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v3a3.5 3.5 0 0 1-7 0zM8 12v2"/><path d="M2.5 2.5l11 11"/>',
  dropped: '<path d="M6.5 9.5l-1.6 1.6a2.3 2.3 0 0 1-3.2-3.2L3.3 6.3M9.5 6.5l1.6-1.6a2.3 2.3 0 0 1 3.2 3.2l-1.6 1.6M6 4V2M4 6H2M10 12v2M12 10h2"/>',
  proxy: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5"/>',
  insecure: '<path d="M8 1.8l5 2v3.6c0 3.1-2.1 5.6-5 6.8-2.9-1.2-5-3.7-5-6.8V3.8z"/><path d="M8 5.2v3.3M8 10.8v.01"/>',
  loop: '<path d="M12.5 6A4.8 4.8 0 0 0 3.6 5M3.5 10a4.8 4.8 0 0 0 8.9 1M3.5 2.5V5H6M12.5 13.5V11H10"/>',
  blocked: '<circle cx="8" cy="8" r="5.5"/><path d="M4.1 11.9l7.8-7.8"/>',
  file: '<path d="M9.5 1.8H4.3a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1V5zM9.5 1.8V5h3.2M6.3 8.5l3.4 3.4M9.7 8.5l-3.4 3.4"/>',
  generic: '<path d="M4.5 12.5a3 3 0 0 1-.4-6 4.2 4.2 0 0 1 8.1.8 2.6 2.6 0 0 1-.7 5.2z"/><path d="M8 7v2.3M8 11v.01"/>'
};

/** Each design's type and corners, as theme.css draws them: the error page wears the browser's design. */
const FACES = {
  ui: 'Aptos, Calibri, Carlito, "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif',
  serif: '"Iowan Old Style", Charter, "Bitstream Charter", "Source Serif Pro", "Noto Serif", Georgia, serif',
  grotesk: '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif'
};
const LOOKS = {
  legacy: { body: FACES.ui, title: FACES.ui, weight: 600, radius: 6, tile: 12 },
  ledger: { body: FACES.ui, title: FACES.ui, weight: 600, radius: 8, tile: 14 },
  paper: { body: FACES.ui, title: FACES.serif, weight: 400, radius: 4, tile: 8 },
  grid: { body: FACES.grotesk, title: FACES.grotesk, weight: 600, radius: 0, tile: 0 }
};

/** The page-side script. Serialised: it must not reference anything outside itself. */
function draw(e) {
  /* global document, location, history, addEventListener */
  const p = e.p;
  const raised = p.raised || p.bg;
  const css = `
    :root { color-scheme: ${e.light ? 'light' : 'dark'}; }
    html, body { margin: 0; min-height: 100%; background: ${p.bg}; color: ${p.text}; }
    body { font: 15px/1.55 ${e.look.body}; -webkit-font-smoothing: antialiased; cursor: default; }
    main { box-sizing: border-box; max-width: 36rem; margin: 0 auto; padding: max(48px, 18vh) 32px 48px;
           animation: in 200ms cubic-bezier(0.32, 0.72, 0, 1); }
    .mark { width: 52px; height: 52px; display: grid; place-items: center; margin-bottom: 22px;
            border: 1px solid ${p.border}; border-radius: ${e.look.tile}px; background: ${raised}; color: ${e.tone}; }
    .mark svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 1.4;
                stroke-linecap: round; stroke-linejoin: round; }
    h1 { font: ${e.look.weight} 24px/1.25 ${e.look.title}; margin: 0 0 8px; letter-spacing: -0.01em; overflow-wrap: anywhere; }
    p { margin: 0; color: ${p.dim}; }
    .tips { margin: 18px 0 0; padding: 0; list-style: none; color: ${p.dim}; }
    .tips-head { margin: 18px 0 0; color: ${p.text}; font-weight: 600; font-size: 13px; }
    .tips li { position: relative; padding-left: 18px; margin-top: 4px; }
    .tips li::before { content: ''; position: absolute; left: 4px; top: 0.72em; width: 5px; height: 5px;
                       border-radius: 50%; background: ${p.border}; }
    .tips-head + .tips { margin-top: 6px; }
    .actions { margin-top: 26px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    button { height: 36px; padding: 0 18px; border-radius: ${e.look.radius}px; font: inherit; font-weight: 600;
             cursor: default; transition: filter 120ms, background-color 120ms; }
    .primary { border: 0; background: ${e.fill}; color: #fff; }
    .primary:hover { filter: brightness(1.08); }
    .secondary { border: 1px solid ${p.border}; background: transparent; color: ${p.text}; }
    .secondary:hover { background: ${raised}; }
    button:active { filter: brightness(0.94); }
    button:focus-visible { outline: 2px solid ${e.accent}; outline-offset: 2px; }
    .waiting { margin-top: 16px; font-size: 13px; color: ${p.dim}; display: flex; align-items: center; gap: 8px; }
    .waiting::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: ${e.accent}; opacity: 0.8; }
    details { margin-top: 30px; padding-top: 14px; border-top: 1px solid ${p.border}; font-size: 13px; color: ${p.dim}; }
    summary { cursor: default; width: max-content; }
    summary:focus-visible { outline: 2px solid ${e.accent}; outline-offset: 2px; }
    .code { margin-top: 8px; font: 12px/1.5 ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace;
            overflow-wrap: anywhere; user-select: text; cursor: text; }
    @keyframes in { from { opacity: 0; transform: translateY(6px); } }
    @media (prefers-reduced-motion: reduce) { main { animation: none; } }`;
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (label, kind, run) => {
    const b = el('button', label, kind);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  };
  document.title = e.title;
  document.documentElement.lang = 'en';
  const main = el('main');

  // The mark is markup from this module's own table, never from the page or
  // the address: set from a fixed string, everything else goes in as text.
  const mark = el('div', '', 'mark');
  mark.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${e.icon}</svg>`;

  const actions = el('div', '', 'actions');
  const retry = () => location.replace(e.url);
  const back = () => history.back();
  const search = () => location.assign(e.searchUrl);
  // Trying again leads, except where it is not the answer: a site that cannot
  // prove who it is, where Back is the way out and trying again is second.
  if (e.safe) actions.append(button('Try again', 'primary', retry));
  else if (e.canGoBack) actions.append(button('Go back', 'primary', back));
  if (e.searchUrl) actions.append(button(`Search for ${e.host}`, 'secondary', search));
  if (e.safe && e.canGoBack) actions.append(button('Go back', 'secondary', back));
  if (!e.safe) actions.append(button('Try again', e.canGoBack ? 'secondary' : 'primary', retry));

  main.append(mark, el('h1', e.title), el('p', e.detail));
  if (e.tips.length) {
    const list = el('ul', '', 'tips');
    for (const tip of e.tips) list.append(el('li', tip));
    main.append(el('p', 'Try:', 'tips-head'), list);
  }
  main.append(actions);
  // Said, not animated: a pulse would draw frames for as long as the machine
  // stays offline, on a laptop that may well be on battery.
  if (e.retryOnline && e.kind === 'offline') main.append(el('div', 'Waiting for a connection', 'waiting'));

  const details = el('details');
  details.append(el('summary', 'Details'));
  details.append(el('div', [e.code, e.url].filter(Boolean).join('\n'), 'code'));
  details.lastChild.style.whiteSpace = 'pre-wrap';
  main.append(details);

  document.head.replaceChildren(el('style', css), el('title', e.title));
  document.body.replaceChildren(main);
  // The first action has the keyboard: Enter tries again (or goes back).
  actions.firstChild?.focus({ focusVisible: false });
  if (e.retryOnline) addEventListener('online', retry, { once: true });
}

/** How to search for something, set by main.js from the chosen engine; null for none. */
let searchFor = null;
function useSearch(fn) { searchFor = typeof fn === 'function' ? fn : null; }

/**
 * The accent, deepened until white text on it reads (4.6:1) - `readable` in
 * theme.js, which gives the browser's own buttons their `--accent-fill`.
 */
function accentFill(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const onWhite = (c) => 1.05 / (lum(c) + 0.05);
  let out = rgb;
  for (let t = 0; t <= 1 && onWhite(out) < 4.6; t += 0.02) out = rgb.map((v) => Math.round(v * (1 - t)));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Draw the error page into `wc`, which has just committed Chromium's error
 * entry for `url`. Resolves whether it was drawn.
 */
async function show(wc, { code, description, url }) {
  const words = explain(code, description, url);
  const theme = palette.current();
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
  let canGoBack = false;
  try { canGoBack = wc.navigationHistory.canGoBack(); } catch { canGoBack = false; }
  const e = {
    ...words,
    ...theme,
    url: String(url || ''),
    host,
    canGoBack,
    searchUrl: words.search && searchFor ? searchFor(host) : '',
    icon: ICONS[words.kind] || ICONS.generic,
    look: LOOKS[theme.design] || LOOKS.legacy,
    // The mark is the accent where something can be done about it, and the
    // dim text colour where the answer is to leave.
    tone: words.safe ? theme.accent : theme.p.dim,
    fill: accentFill(theme.accent),
    // The engine's name for it, for whoever wants to search for it: under Details.
    code: /^ERR_[A-Z_]+$/.test(String(description)) ? String(description) : ''
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

module.exports = { explain, show, useSearch };
