'use strict';

/**
 * The new tab page.
 *
 * Typing here goes through the same `navigate` command the address bar uses, so
 * the URL-versus-search decision is made in exactly one place in the browser
 * (`normaliseUrl` in main.js) rather than being reimplemented with slightly
 * different rules and disagreeing about what a bare hostname means.
 */

const api = window.debrowser;

const q = document.getElementById('q');
const stat = document.getElementById('stat');

// Typed-but-unsent text keeps this page off the reclaim ladder; see theme.js.
watchTransientInput(api);

document.getElementById('search').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = q.value.trim();
  if (text) api.send('navigate', { url: text });
});


// Focus without stealing it from the address bar if the user went there first.
window.addEventListener('DOMContentLoaded', () => {
  if (!document.hasFocus()) return;
  q.focus();
});

/* ------------------------------------------------------------------ */
/* Tiles                                                               */
/* ------------------------------------------------------------------ */

/**
 * The sites you go to most, folded by origin in the browser process.
 *
 * Asked for once, when the page loads, rather than kept current: a new tab page
 * is open for a second and the list it shows was true when it opened. Subscribing
 * it to anything would be a cost paid by every tab in the browser for a page
 * nobody is looking at any more.
 */
const tiles = document.getElementById('tiles');

function tile(item) {
  const host = siteOf(item.url);

  const root = document.createElement('div');
  root.className = 'tile';

  const open = document.createElement('button');
  open.className = 'tile-open';
  open.type = 'button';
  open.title = `${item.title || host}\n${item.url}`;

  // Through the browser's icon route, never at the site - see `siteChip`.
  const chip = siteChip(item.url, { icon: item.icon });

  const label = document.createElement('span');
  label.className = 'tile-label';
  // With its port, when it has one: four local servers are four places, and
  // four tiles all reading "127.0.0.1" said otherwise.
  let port = '';
  try { port = new URL(item.url).port; } catch { /* no URL, no port */ }
  label.textContent = port ? `${host}:${port}` : host;

  open.append(chip, label);
  open.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey) api.send('new-tab', { url: item.url });
    else api.send('navigate', { url: item.url });
  });
  open.addEventListener('auxclick', (event) => {
    if (event.button === 1) api.send('new-tab', { url: item.url });
  });

  // Removing a tile forgets the site, which is the only thing it can honestly
  // mean: the list is derived from history, so a tile that was merely hidden
  // would be a button that appears to do nothing the next time you look.
  const forget = document.createElement('button');
  forget.className = 'tile-forget';
  forget.type = 'button';
  forget.append(crossIcon());
  forget.title = `Forget ${host}`;
  forget.setAttribute('aria-label', `Forget ${host}`);
  forget.addEventListener('click', async (event) => {
    event.stopPropagation();
    await api.request('forget-site', { url: item.url });
    // Faded where it stands, keeping its place in the grid until the next new
    // tab: removing it slid every tile after it sideways under the pointer
    // and re-centred the page.
    root.classList.add('gone');
    root.setAttribute('aria-hidden', 'true');
    if (![...tiles.children].some((t) => !t.classList.contains('gone'))) tiles.hidden = true;
  });

  root.append(open, forget);
  return root;
}

async function loadTiles() {
  const res = await api.request('top-sites', { limit: 8 });
  const items = (res && res.items) || [];
  tiles.hidden = items.length === 0;
  if (!items.length) return;
  const frag = document.createDocumentFragment();
  for (const item of items) frag.append(tile(item));
  tiles.replaceChildren(frag);
}

loadTiles();

/* ------------------------------------------------------------------ */
/* Continue with these tabs                                            */
/* ------------------------------------------------------------------ */

/**
 * The pages you were last on, a scroll below the search - every design but
 * Legacy. Straight from the browser's history, newest first, so a private
 * window, which keeps none, gets nothing and the card stays hidden.
 */
const card = document.getElementById('continue');
const cardList = document.getElementById('continue-list');
const cardPop = document.getElementById('continue-pop');
const cardMore = document.getElementById('continue-more');

function ago(at) {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  if (hours < 48) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function continueRow(item) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'continue-row';
  row.title = item.url;
  const text = document.createElement('span');
  text.className = 'continue-text';
  const title = document.createElement('span');
  title.className = 'continue-title';
  title.textContent = item.title || siteOf(item.url);
  const meta = document.createElement('span');
  meta.className = 'continue-meta';
  meta.textContent = `${siteOf(item.url)} · ${ago(item.visitedAt)}`;
  text.append(title, meta);
  row.append(siteChip(item.url, { icon: item.icon }), text);
  row.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey) api.send('new-tab', { url: item.url });
    else api.send('navigate', { url: item.url });
  });
  row.addEventListener('auxclick', (event) => {
    if (event.button === 1) api.send('new-tab', { url: item.url });
  });
  return row;
}

async function loadContinue() {
  const res = await api.request('recent-pages', { limit: 4 });
  const items = (res && res.items) || [];
  card.hidden = items.length === 0;
  cardList.replaceChildren(...items.map(continueRow));
  fitCard();
}

function closeCardMenu() {
  cardPop.hidden = true;
  cardMore.setAttribute('aria-expanded', 'false');
}
cardMore.addEventListener('click', () => {
  cardPop.hidden = !cardPop.hidden;
  cardMore.setAttribute('aria-expanded', String(!cardPop.hidden));
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.continue-menu')) closeCardMenu();
});
document.getElementById('continue-hide').addEventListener('click', async () => {
  closeCardMenu();
  card.hidden = true;
  fitCard();
  await api.request('hide-continue-card');
});
document.getElementById('continue-all').addEventListener('click', () => api.send('open-history'));

loadContinue();

// What newtab.css needs to lift the field when the card would not fit below
// it: the height from the top of the field's block to the bottom of the card.
// Called when the card fills or goes, and when the block itself resizes.
const mainEl = document.querySelector('main');
function fitCard() {
  const end = card.hidden ? mainEl.offsetTop + mainEl.offsetHeight : card.offsetTop + card.offsetHeight;
  document.body.style.setProperty('--fit', `${end - mainEl.offsetTop}px`);
}
new ResizeObserver(fitCard).observe(mainEl);

// A spare new tab page is loaded before anyone asks for it (prewarm.js), so
// what it showed may be a little old by the time it is: brought up to date as
// it is shown. And it gets the keyboard, as a freshly loaded one does.
let tilesAt = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - tilesAt > 1000) { tilesAt = Date.now(); loadTiles(); loadContinue(); }
});
window.addEventListener('focus', () => {
  if (document.activeElement === document.body) q.focus();
});

// One line of the thing this browser is actually for. It costs nothing to
// render because the numbers are already in the state message the chrome gets.
api.onState((state) => {
  applyThemePrefs(state.prefs);
  if (typeof state.totalMB !== 'number') return;
  const open = state.tabs ? state.tabs.length : 0;
  const size = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
  // "each" only when there is more than one to divide by.
  stat.textContent = !open ? ''
    : open === 1 ? `${size(state.totalMB)} in 1 tab`
    : `${size(state.totalMB)} in ${open} tabs, about ${size(state.totalMB / open)} each`;
});
