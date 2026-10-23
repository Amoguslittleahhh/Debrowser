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
  // A highlighted row is what Enter takes, and so is a first row that is a
  // page rather than the typed text - an open tab is switched to, as the
  // address bar does.
  const lead = suggestions[0];
  const leadIsPage = listOpen && lead && lead.isDefault && !['go', 'search'].includes(lead.kind) && q.value === typed;
  if (listOpen && selected >= 0) api.send('suggest-pick', { index: selected });
  else if (leadIsPage) api.send('suggest-pick', { index: 0 });
  else if (text) api.send('navigate', { url: text });
  closeList();
});

/*
 * What the field offers as you type: the address bar's own list (suggest.js
 * in the browser), drawn by the browser under this field, with the search
 * engine's suggestions in it. The keyboard stays here and moves the
 * highlight; a press in the list comes back as `suggest-hover`/`suggest-done`.
 */
let typed = '';
let suggestions = [];
let selected = -1;
let listOpen = false;
let asked = 0;

function closeList() {
  asked += 1;
  if (!listOpen && !suggestions.length) return;
  listOpen = false;
  suggestions = [];
  selected = -1;
  api.send('suggest-hide');
}

const shownText = (item) => (item.kind === 'search' || item.kind === 'go' ? item.title : item.url);

q.addEventListener('input', async () => {
  typed = q.value;
  selected = -1;
  if (!typed.trim()) { closeList(); return; }
  const ask = ++asked;
  const r = document.getElementById('search').getBoundingClientRect();
  const res = await api.request('suggest', { text: typed, anchor: { x: r.left, y: r.bottom, width: r.width }, complete: false });
  if (ask !== asked || q.value !== typed || !res) return;
  suggestions = res.items || [];
  listOpen = suggestions.length > 0;
});

q.addEventListener('keydown', (event) => {
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && listOpen) {
    event.preventDefault();
    const n = suggestions.length;
    selected = event.key === 'ArrowDown'
      ? (selected + 1 >= n ? -1 : selected + 1)
      : (selected - 1 < -1 ? n - 1 : selected - 1);
    q.value = selected === -1 ? typed : shownText(suggestions[selected]);
    q.setSelectionRange(q.value.length, q.value.length);
    api.send('suggest-select', { index: selected });
  } else if (event.key === 'Escape' && listOpen) {
    event.preventDefault();
    q.value = typed;
    closeList();
  }
});

// Hidden on the way out, a moment late: a press on a row blurs the field first.
q.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== q) closeList(); }, 120));
window.addEventListener('resize', closeList);

api.onMessage((message) => {
  if (message.kind === 'suggest-hover') {
    if (!listOpen || !suggestions[message.index]) return;
    selected = message.index;
    q.value = shownText(suggestions[selected]);
  } else if (message.kind === 'suggest-done') {
    listOpen = false;
    suggestions = [];
    selected = -1;
  } else if (message.kind === 'suggest-more') {
    if (listOpen && message.text === typed && selected === -1 && Array.isArray(message.items)) suggestions = message.items;
  }
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

/**
 * What a favourite is called under its mark: the site, not its address.
 *
 * "github" rather than "github.com", "mail.google" rather than a truncated
 * "mail.google.…" - the ending is the same on nearly every tile and says
 * nothing. A break is allowed after each dot, so a long name wraps onto its
 * second line at a sensible place instead of being cut. Legacy keeps its
 * hostnames: its tiles are a list, with the room for them.
 */
function favouriteName(host) {
  if (document.body.dataset.design === 'legacy' || !/\./.test(host) || /^[\d.]+$/.test(host)) return host;
  const parts = host.split('.');
  parts.pop();
  // A second-level ending - .co.uk, .com.au - goes too.
  if (parts.length > 1 && /^(co|com|org|net|ac|gov|edu)$/.test(parts[parts.length - 1])) parts.pop();
  return parts.join('.\u200b');
}

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
  label.textContent = port ? `${host}:${port}` : favouriteName(host);

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
    const res = await api.request('forget-site', { url: item.url });
    // Refused - a private window keeps no history to forget from - is not
    // gone: fading it anyway showed a tile that came back on the next new tab.
    if (!res) return;
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
 * The sites you use most, a scroll below the search - every design but
 * Legacy. Counted from the browser's own history on this device (main.js
 * `recent-pages`), so a private window, which keeps none, gets nothing and
 * the card stays hidden, and forgetting a site here forgets its visits.
 */
const card = document.getElementById('continue');
const cardList = document.getElementById('continue-list');
const cardPop = document.getElementById('continue-pop');
const cardMore = document.getElementById('continue-more');

/**
 * The query and the engine, when a recent page is a search results page.
 * Read from the address, where the query is exact, rather than from the
 * title, whose wording each engine sets.
 */
const ENGINES = [
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/search/, param: 'q', name: 'Google' },
  { host: /(^|\.)bing\.com$/, path: /^\/search/, param: 'q', name: 'Bing' },
  { host: /(^|\.)duckduckgo\.com$/, path: /^\/$/, param: 'q', name: 'DuckDuckGo' },
  { host: /(^|\.)search\.brave\.com$/, path: /^\/search/, param: 'q', name: 'Brave' },
  { host: /(^|\.)ecosia\.org$/, path: /^\/search/, param: 'q', name: 'Ecosia' }
];
function searchOf(item) {
  let url;
  try { url = new URL(item.url); } catch { return null; }
  const engine = ENGINES.find((e) => e.host.test(url.hostname) && e.path.test(url.pathname));
  const query = engine && (url.searchParams.get(engine.param) || '').trim();
  return query ? { query, engine: engine.name } : null;
}

function continueRow(item) {
  const host = siteOf(item.url);
  const root = document.createElement('div');
  root.className = 'continue-item';
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'continue-row';
  row.title = item.url;
  const text = document.createElement('span');
  text.className = 'continue-text';
  const title = document.createElement('span');
  title.className = 'continue-title';
  const meta = document.createElement('span');
  meta.className = 'continue-meta';
  // A search engine reads as its name: its busiest page is a results page,
  // and the last query on it says nothing about why you go there.
  const searched = searchOf(item);
  title.textContent = searched ? searched.engine : (item.title || host);
  meta.textContent = host;
  text.append(title, meta);
  // How often, on its own at the end of the row, where a list's counts line up.
  const when = document.createElement('span');
  when.className = 'continue-when';
  // Already open: says so, and the row goes to that tab rather than opening
  // the site a second time.
  when.textContent = item.tabId != null ? 'Open now' : (item.visits === 1 ? '1 visit' : `${item.visits} visits`);
  row.append(siteChip(item.url, { icon: item.icon }), text, when);
  row.addEventListener('click', (event) => {
    if (item.tabId != null && !event.ctrlKey && !event.metaKey) api.send('activate-tab', { id: item.tabId });
    else if (event.ctrlKey || event.metaKey) api.send('new-tab', { url: item.url });
    else api.send('navigate', { url: item.url });
  });
  row.addEventListener('auxclick', (event) => {
    if (event.button === 1) api.send('new-tab', { url: item.url });
  });
  // Removing a site forgets its visits, as a favourite's cross does: the
  // count is history, and a site merely hidden would be counted back.
  const forget = document.createElement('button');
  forget.type = 'button';
  forget.className = 'continue-forget';
  forget.append(crossIcon());
  forget.title = `Forget ${host}`;
  forget.setAttribute('aria-label', `Forget ${host}`);
  forget.addEventListener('click', async () => {
    const res = await api.request('forget-site', { url: item.url });
    if (res) loadContinue();
  });
  root.append(row, forget);
  return root;
}

async function loadContinue() {
  const res = await api.request('recent-pages', { limit: 4 });
  const items = (res && res.items) || [];
  // Shown whenever it is on, empty or not, so the page has one layout whether
  // or not there is anything to continue (main.js `recent-pages`).
  card.hidden = !(res && res.shown);
  // The card is the page's second half when it has something to show; the
  // favourites stand aside for it rather than stacking a third block between
  // the field and the pages you were reading.
  document.body.classList.toggle('with-continue', !card.hidden);
  if (items.length) {
    cardList.replaceChildren(...items.map(continueRow));
  } else {
    const empty = document.createElement('p');
    empty.className = 'continue-empty';
    empty.textContent = 'The pages you visit will be here to come back to.';
    cardList.replaceChildren(empty);
  }
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

const receipt = document.getElementById('receipt');
receipt.addEventListener('click', () => api.send('open-receipt'));

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

  // Today's receipt, once there is something on it.
  const r = state.receipt;
  const parts = [];
  if (r && r.freedMB >= 1) parts.push([size(r.freedMB), 'freed']);
  if (r && r.slept) parts.push([r.slept.toLocaleString(), r.slept === 1 ? 'tab slept' : 'tabs slept']);
  if (r && r.blocked) parts.push([r.blocked.toLocaleString(), r.blocked === 1 ? 'tracker blocked' : 'trackers blocked']);
  receipt.hidden = !parts.length;
  if (parts.length) {
    const nodes = ['Today: '];
    parts.forEach(([n, what], i) => {
      if (i) nodes.push(' · ');
      const b = document.createElement('b');
      b.textContent = n;
      nodes.push(b, ` ${what}`);
    });
    receipt.replaceChildren(...nodes);
  }
});

