'use strict';

/**
 * The history page.
 *
 * The list lives in the browser process and is filtered there: ten thousand
 * entries is not a thing to copy into this renderer on every keystroke, and
 * the store already knows how to search itself. This file asks for at most a
 * few hundred rows at a time and draws them.
 *
 * Navigation goes through the same `navigate` command the address bar and the
 * new tab page use, so the URL-versus-search decision is made in exactly one
 * place in the browser rather than three that disagree.
 */

const api = window.debrowser;

const el = {
  list: document.getElementById('list'),
  query: document.getElementById('q'),
  clear: document.getElementById('clear'),
  close: document.getElementById('close'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count'),
  recording: document.getElementById('recording')
};

/**
 * How many rows are drawn.
 *
 * Search narrows the list rather than paging it, which is the interaction
 * people actually use on a history page - and it keeps this renderer from
 * building ten thousand nodes to show the forty that fit on screen.
 */
const PAGE = 300;

/** Typing filters as you go, but not on every keystroke. */
const SEARCH_DEBOUNCE_MS = 130;
let searchTimer = null;

/** Where a site's icon is if it never said: the address Chromium would try. */
function defaultIcon(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' ? 'local file' : parsed.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Today and yesterday by name; anything older by date. */
function dayLabel(ts) {
  const date = new Date(ts);
  const today = new Date();
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(today) - start(date)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'long', ...(days > 300 ? { year: 'numeric' } : {}) });
}

function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------------ */

function row(entry) {
  const host = hostOf(entry.url);

  const wrap = document.createElement('div');
  wrap.className = 'visit';

  const open = document.createElement('button');
  open.className = 'open';
  open.type = 'button';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = timeLabel(entry.visitedAt);

  // The site's own logo, on top of its letter.
  //
  // The store keeps an icon address only for sites that put theirs somewhere
  // other than the default, so most rows derive it here from the page's origin
  // - which is exactly the address Chromium itself would have tried. Plenty of
  // sites do not answer it, and those fall back to the letter underneath rather
  // than to a broken image.
  //
  // The fetch itself goes through `debrowser://icon`, which is the browser
  // process, without cookies. An <img> pointed at the site would be fetched by
  // *this page* with this session's cookies - so opening a history list would
  // tell two hundred sites that the user is reading their history.
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.setAttribute('aria-hidden', 'true');
  chip.style.setProperty('--hue', String(siteHue(host)));
  chip.textContent = (host.replace(/^[^a-z0-9]+/i, '')[0] || '?');

  const iconUrl = iconSrc(entry.icon || defaultIcon(entry.url));
  if (iconUrl) {
    const icon = document.createElement('img');
    icon.className = 'site-icon';
    icon.alt = '';
    icon.decoding = 'async';
    // Only the rows on screen are fetched. Three hundred at once would be a
    // burst of requests for a list the user has scrolled two screens of.
    icon.loading = 'lazy';
    icon.src = iconUrl;
    // The letter underneath is a stand-in, not a backdrop: favicons are usually
    // transparent, so the chip has to stop painting once the real one is up.
    icon.addEventListener('load', () => chip.classList.add('has-icon'));
    icon.addEventListener('error', () => icon.remove());
    chip.append(icon);
  }

  const text = document.createElement('span');
  text.className = 'visit-text';

  const title = document.createElement('span');
  title.className = 'visit-title';
  title.textContent = entry.title || entry.url;

  const url = document.createElement('span');
  url.className = 'visit-url';
  url.textContent = entry.url;

  text.append(title, url);
  open.append(time, chip, text);

  // Middle-click and ctrl-click open in a new tab, as they do on any link
  // anywhere else. Without them the only way to keep this page while opening
  // something from it is to go back afterwards.
  open.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey) api.send('new-tab', { url: entry.url });
    else api.send('navigate', { url: entry.url });
  });
  open.addEventListener('auxclick', (event) => {
    if (event.button === 1) api.send('new-tab', { url: entry.url });
  });

  wrap.append(open);

  if (entry.visits > 1) {
    const visits = document.createElement('span');
    visits.className = 'visits';
    visits.textContent = `${entry.visits}×`;
    visits.title = `Visited ${entry.visits} times`;
    wrap.append(visits);
  }

  const forget = document.createElement('button');
  forget.className = 'forget';
  forget.type = 'button';
  forget.textContent = '×';
  forget.setAttribute('aria-label', `Forget ${title.textContent}`);
  forget.addEventListener('click', async () => {
    const res = await api.request('delete-history', { id: entry.id });
    // Removed here rather than by redrawing the list: a redraw would jump the
    // scroll position back to the top of a page the user is part-way down.
    if (res && res.removed) {
      const day = wrap.previousElementSibling;
      wrap.remove();
      // A heading with nothing under it is a date that no longer happened.
      if (day && day.classList.contains('day') &&
          (!day.nextElementSibling || day.nextElementSibling.classList.contains('day'))) {
        day.remove();
      }
      refreshCount();
    }
  });
  wrap.append(forget);

  return wrap;
}

function render(items) {
  el.list.textContent = '';

  let day = null;
  for (const entry of items) {
    const label = dayLabel(entry.visitedAt);
    if (label !== day) {
      day = label;
      const heading = document.createElement('div');
      heading.className = 'day';
      heading.textContent = label;
      el.list.append(heading);
    }
    el.list.append(row(entry));
  }

  const query = el.query.value.trim();
  el.empty.hidden = items.length > 0;
  el.empty.textContent = items.length ? ''
    : query ? `Nothing in your history matches “${query}”.`
      : 'Nothing here yet. Pages you visit will be listed as you go.';
}

async function load() {
  const res = await api.request('list-history', { query: el.query.value, limit: PAGE });
  if (!res) return;
  el.recording.checked = res.recording !== false;
  render(res.items || []);
  showCount(res.total, (res.items || []).length);
}

/** Kept separate from `load` so deleting one row does not redraw the list. */
async function refreshCount() {
  const res = await api.request('list-history', { query: '', limit: 1 });
  if (res) showCount(res.total, null);
}

function showCount(total, shown) {
  if (typeof total !== 'number') return;
  const pages = `${total} page${total === 1 ? '' : 's'}`;
  el.count.textContent = shown !== null && shown < total ? `${shown} of ${pages}` : pages;
}

/* ------------------------------------------------------------------ */

el.query.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(load, SEARCH_DEBOUNCE_MS);
});

el.clear.addEventListener('click', async () => {
  const res = await api.request('clear-history');
  if (res) load();
});

el.close.addEventListener('click', () => api.send('close-tab'));

el.recording.addEventListener('change', async () => {
  // The browser decides, and the box follows it. Trusting the click would leave
  // the switch showing a setting that was refused.
  const res = await api.request('set-pref', { key: 'saveHistory', value: el.recording.checked });
  if (!res || !res.ok) el.recording.checked = !el.recording.checked;
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // Escape clears the search first and closes the page only when there is
    // nothing to clear - the same order every search field in a browser uses.
    if (el.query.value) { el.query.value = ''; load(); }
    else api.send('close-tab');
  }
});

api.onState((state) => applyThemePrefs(state.prefs));

load();
