'use strict';

/**
 * The downloads page.
 *
 * Downloads were only ever visible as a handful of rows inside Settings, which
 * is the wrong place for something you check while it is happening: it is a
 * live list, not a preference. This is the same page the history list is - a
 * real address, a real tab, searchable - with the one thing history does not
 * need, which is that a running download changes while you are looking at it.
 *
 * Rows are keyed and updated in place rather than rebuilt. A progress bar that
 * is replaced twice a second cannot animate, and a redraw would drop the
 * scroll position of anyone part-way down a long list.
 */

const api = window.debrowser;

const el = {
  list: document.getElementById('list'),
  query: document.getElementById('q'),
  clear: document.getElementById('clear'),
  close: document.getElementById('close'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count')
};

/** How often the list is refreshed while something is still running. */
const TICK_MS = 500;

/** Typing filters as you go, but not on every keystroke. */
const SEARCH_DEBOUNCE_MS = 130;
let searchTimer = null;
let tickTimer = null;

/** Built rows, keyed by download id, so an update never rebuilds the list. */
const rows = new Map();

const RUNNING = new Set(['running', 'starting']);

/* ------------------------------------------------------------------ */

/** Fraction complete, or null where the server never said how big the file is. */
function fraction(item) {
  if (!item.total || item.total <= 0) return null;
  return Math.max(0, Math.min(1, item.received / item.total));
}

/* ------------------------------------------------------------------ */

function createRow(item) {
  const root = document.createElement('div');
  root.className = 'download';

  // Through the browser's icon route, never at the site - see `siteChip`.
  const chip = siteChip(item.url);

  const text = document.createElement('div');
  text.className = 'download-text';

  const name = document.createElement('span');
  name.className = 'download-name';

  const meter = document.createElement('span');
  meter.className = 'meter';
  const fill = document.createElement('span');
  fill.className = 'meter-fill';
  meter.append(fill);

  const status = document.createElement('span');
  status.className = 'download-status';

  text.append(name, meter, status);

  // Two buttons, because a finished download has two things worth doing to it
  // and the page offered neither. The flyout has had "Open file" since it was
  // written; the page - the one you reach by searching for something you
  // downloaded last week - could only clear the row, which is the least useful
  // thing you can do with a file you have just found.
  const open = document.createElement('button');
  open.className = 'ghost-btn';
  open.type = 'button';
  open.textContent = 'Open file';
  open.hidden = true;

  const action = document.createElement('button');
  action.className = 'ghost-btn';
  action.type = 'button';

  // Private windows only, finished PDFs only: a copy made of pictures of the
  // pages, so nothing in it can run, submit or fetch. Opening the original
  // hands it to another program, outside Tor - this is the way to read one
  // without that.
  const safe = document.createElement('button');
  safe.className = 'ghost-btn';
  safe.type = 'button';
  safe.textContent = 'Save a safe copy';
  safe.title = 'A copy with no scripts, forms, links or hidden details: each page as a picture. Text in it is no longer selectable.';
  safe.hidden = true;

  const buttons = document.createElement('div');
  buttons.className = 'download-actions';
  buttons.append(safe, open, action);

  root.append(chip, text, buttons);

  const node = { root, name, meter, fill, status, action, open, safe, state: {} };

  safe.addEventListener('click', async () => {
    safe.disabled = true;
    safe.textContent = 'Making a safe copy…';
    const res = await api.request('safe-copy', { id: item.id });
    safe.disabled = false;
    safe.textContent = res && res.ok ? `Saved: ${res.name}` : 'Could not make a safe copy';
    safe.title = res && res.ok ? `${res.pages} page(s), beside the original` : (res && res.reason) || '';
  });

  // Through the browser, which resolves the id to a path: no path ever crosses
  // into this renderer, so a page that got hold of this bridge could not be
  // told where the user's files are.
  open.addEventListener('click', () => api.request('open-download', { id: item.id }));
  // The same gesture the flyout uses, and the one a file manager uses: the
  // middle button shows the file in its folder rather than opening it.
  open.addEventListener('auxclick', (event) => {
    if (event.button === 1) api.request('reveal-download', { id: item.id });
  });

  action.addEventListener('click', async () => {
    const running = RUNNING.has(node.state.state);
    await api.request(running ? 'cancel-download' : 'clear-download', { id: item.id });
    load();
  });

  return node;
}

/** Only what changed: a progress bar rebuilt twice a second cannot animate. */
function updateRow(node, item) {
  const prev = node.state;

  const label = item.filename || item.url;
  if (prev.label !== label) {
    node.name.textContent = label;
    node.root.title = `${label}\n${item.url}`;
    prev.label = label;
  }

  const status = describeDownload(item);
  if (prev.status !== status) {
    node.status.textContent = status;
    prev.status = status;
  }

  const running = RUNNING.has(item.state);
  const part = fraction(item);
  if (prev.part !== part || prev.state !== item.state) {
    // A download whose size the server never gave has no meaningful bar, so it
    // gets none rather than a bar frozen at zero that reads as stalled.
    node.meter.hidden = !running || part === null;
    if (part !== null) node.fill.style.transform = `scaleX(${part})`;
    prev.part = part;
  }

  // Outside the change check: whether this is a private window can be learned
  // after the row was drawn.
  node.safe.hidden = !(privateWindow && item.state === 'done' && /\.pdf$/i.test(item.filename || ''));

  if (prev.state !== item.state) {
    node.root.dataset.state = item.state;
    // Only a file that finished can be opened. A cancelled or failed download
    // has nothing on disk worth handing to the system.
    node.open.hidden = item.state !== 'done';
    node.open.title = `Open ${item.filename || 'file'} · middle-click to show it in its folder`;
    node.action.textContent = running ? 'Cancel' : 'Clear';
    node.action.classList.toggle('danger', running);
    node.action.setAttribute('aria-label',
      `${running ? 'Cancel' : 'Clear'} ${item.filename || item.url}`);
    prev.state = item.state;
  }
}

/* ------------------------------------------------------------------ */

function render(items) {
  const seen = new Set();

  for (const item of items) {
    seen.add(item.id);
    let node = rows.get(item.id);
    if (!node) {
      node = createRow(item);
      rows.set(item.id, node);
    }
    updateRow(node, item);
    // Appended in list order every time, which moves an existing node rather
    // than cloning it - so a row that changes position keeps its element and
    // its in-flight transition.
    el.list.append(node.root);
  }

  for (const [id, node] of rows) {
    if (seen.has(id)) continue;
    node.root.remove();
    rows.delete(id);
  }

  const query = el.query.value.trim();
  el.empty.hidden = items.length > 0;
  el.empty.textContent = items.length ? ''
    : query ? `No downloads match “${query}”.`
      : 'Nothing downloaded yet. Files you save appear here as they arrive.';

  el.count.textContent = items.length
    ? `${items.length} download${items.length === 1 ? '' : 's'}`
    : '';
}

function matches(item, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return String(item.filename || '').toLowerCase().includes(needle) ||
    String(item.url || '').toLowerCase().includes(needle);
}

async function load() {
  const res = await api.request('list-downloads');
  const all = (res && res.items) || [];
  render(all.filter((item) => matches(item, el.query.value.trim())));

  // Polled only while something is actually moving. A downloads page with
  // nothing running should cost exactly nothing, which is most of the time it
  // will be open in a browser built around what tabs cost.
  const busy = all.some((item) => RUNNING.has(item.state));
  clearTimeout(tickTimer);
  if (busy) tickTimer = setTimeout(load, TICK_MS);
}

/* ------------------------------------------------------------------ */

el.query.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(load, SEARCH_DEBOUNCE_MS);
});

el.clear.addEventListener('click', async () => {
  const res = await api.request('list-downloads');
  const finished = ((res && res.items) || []).filter((item) => !RUNNING.has(item.state));
  // One at a time rather than a "clear all" command: a running download must
  // survive this button, and the store's own remove() cancels one if asked.
  for (const item of finished) await api.request('clear-download', { id: item.id });
  load();
});

el.close.addEventListener('click', () => api.send('close-tab'));

// Escape clears the search first, and closes the page only when there is
// nothing to clear. See `clearOnEscape` in theme.js.
clearOnEscape(el.query);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.defaultPrevented) api.send('close-tab');
});

/** Whether this is a private window's downloads page, from the state broadcast. */
let privateWindow = false;
api.onState((state) => {
  applyThemePrefs(state.prefs);
  if (Boolean(state.incognito) !== privateWindow) {
    privateWindow = Boolean(state.incognito);
    load();
  }
});

// A half-written search keeps this page off the reclaim ladder; see theme.js.
watchTransientInput(api);

load();
