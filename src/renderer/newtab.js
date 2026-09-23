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

// Animate only once the page is actually on screen. A hidden view's animation
// frames are throttled, so one started in the background is still running when
// the tab is shown, and the user sees it settle rather than arrive.
function releaseAnimation() {
  if (document.visibilityState !== 'visible') return;
  document.body.classList.remove('still');
  document.removeEventListener('visibilitychange', releaseAnimation);
}
document.body.classList.add('still');
document.addEventListener('visibilitychange', releaseAnimation);
releaseAnimation();

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
  label.textContent = host;

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
    // Removed here rather than by redrawing: a redraw would slide every
    // remaining tile sideways under the pointer that is still over this one.
    root.remove();
    if (!tiles.children.length) tiles.hidden = true;
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

// One line of the thing this browser is actually for. It costs nothing to
// render because the numbers are already in the state message the chrome gets.
api.onState((state) => {
  applyThemePrefs(state.prefs);
  if (typeof state.totalMB !== 'number') return;
  const open = state.tabs ? state.tabs.length : 0;
  const per = open ? (state.totalMB / open).toFixed(1) : '—';
  stat.textContent = `${state.totalMB} MB across ${open} tab${open === 1 ? '' : 's'} — ${per} MB each`;
});
