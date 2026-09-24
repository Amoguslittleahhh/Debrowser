'use strict';

/**
 * The downloads flyout.
 *
 * Edge's shape rather than Chrome's, because it is the one that answers the
 * question people actually have while a file is arriving - "is it done yet, and
 * where did it go" - without leaving the page they are on. The full page is
 * still there behind "See all", for searching a long history of them.
 *
 * It lives in the same sheet the app menu does: a window-sized transparent view
 * created on open and destroyed on close, so a panel nobody is looking at costs
 * nothing. See BrowserShell#openSheet.
 */

const api = window.debrowser;

const el = {
  sheet: document.getElementById('sheet'),
  backdrop: document.getElementById('backdrop'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  seeAll: document.getElementById('see-all')
};

/** Where the button that opened this is, in window coordinates. */
const params = new URLSearchParams(location.search);
const anchor = {
  x: Number(params.get('x')) || 0,
  y: Number(params.get('y')) || 0,
  right: Number(params.get('right')) || 0
};

/**
 * How many rows the panel shows.
 *
 * A flyout is a glance, not an archive. Past about this many it stops being
 * readable at one look and the page is the better answer - which is what "See
 * all" is for.
 */
const MAX_ROWS = 8;

/** How often the panel refreshes while something is still running. */
const TICK_MS = 400;
let tickTimer = null;

/** Built rows, keyed by download id, so progress updates never rebuild them. */
const rows = new Map();

const RUNNING = new Set(['running', 'starting']);

/* ------------------------------------------------------------------ */

function createRow(item) {
  const root = document.createElement('div');
  root.className = 'dl';

  // Through the browser's icon route, never at the site - see `siteChip`. The
  // shared classes rather than `dl-chip`/`dl-icon`: this row's mark was a
  // twenty-line copy of the shared one differing only in a 1px margin, which is
  // a rule, not a component.
  const chip = siteChip(item.url);

  const text = document.createElement('div');
  text.className = 'dl-text';

  const name = document.createElement('span');
  name.className = 'dl-name';

  const meter = document.createElement('span');
  meter.className = 'dl-meter';
  const fill = document.createElement('span');
  fill.className = 'dl-fill';
  meter.append(fill);

  // The second line is either a status or an action, never both. On a finished
  // download the useful thing is "Open file", which is what Edge puts there and
  // what anyone reaching for this panel came for.
  const status = document.createElement('span');
  status.className = 'dl-status';
  const open = document.createElement('button');
  open.className = 'dl-link';
  open.type = 'button';
  open.textContent = 'Open file';
  open.hidden = true;

  text.append(name, meter, status, open);

  // Cancel while it runs, and out of the way once it does not - a finished row
  // keeps its × for clearing, which is the same button doing the same job.
  const action = document.createElement('button');
  action.className = 'dl-action';
  action.type = 'button';

  root.append(chip, text, action);

  const node = { root, name, meter, fill, status, open, action, state: {} };

  open.addEventListener('click', () => api.request('open-download', { id: item.id }));

  action.addEventListener('click', async () => {
    const running = RUNNING.has(node.state.state);
    await api.request(running ? 'cancel-download' : 'clear-download', { id: item.id });
    load();
  });

  // Reveal rather than open, on the row itself. Two gestures with different
  // consequences should not be one click apart by accident.
  root.addEventListener('auxclick', (event) => {
    if (event.button === 1) api.request('reveal-download', { id: item.id });
  });

  return node;
}

/** Only what changed: a progress bar rebuilt four times a second cannot animate. */
function updateRow(node, item) {
  const prev = node.state;
  const running = RUNNING.has(item.state);

  const label = item.filename || item.url;
  if (prev.label !== label) {
    node.name.textContent = label;
    node.root.title = `${label}\n${item.url}`;
    prev.label = label;
  }

  // Brief: a finished row offers "Open file" instead of a line of figures.
  const status = describeDownload(item, { brief: true });
  if (prev.status !== status) {
    node.status.textContent = status || '';
    node.status.hidden = !status;
    prev.status = status;
  }

  const part = item.total > 0 ? Math.max(0, Math.min(1, item.received / item.total)) : null;
  if (prev.part !== part || prev.state !== item.state) {
    // A download whose size the server never gave has no meaningful bar, so it
    // gets none rather than one frozen at zero that reads as stalled.
    node.meter.hidden = !running || part === null;
    if (part !== null) node.fill.style.transform = `scaleX(${part})`;
    prev.part = part;
  }

  if (prev.state !== item.state) {
    node.root.dataset.state = item.state;
    node.open.hidden = item.state !== 'done';
    node.action.replaceChildren(running ? 'Cancel' : crossIcon());
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
    // Appended in list order each time, which *moves* an existing element
    // rather than cloning it - so a row that changes position keeps its node
    // and its in-flight transition.
    el.list.append(node.root);
  }

  for (const [id, node] of rows) {
    if (seen.has(id)) continue;
    node.root.remove();
    rows.delete(id);
  }

  el.empty.hidden = items.length > 0;
  el.list.hidden = items.length === 0;
}

let placed = false;

async function load() {
  const res = await api.request('list-downloads');
  const all = (res && res.items) || [];
  render(all.slice(0, MAX_ROWS));

  // Placed after the first render, because where a panel goes depends on how
  // tall it turned out - and it is only that tall once its rows exist.
  if (!placed) {
    placed = true;
    anchorSheet(el.sheet, anchor);
    el.sheet.focus();
  }

  // Polled only while something is actually moving. A panel open over a list of
  // finished downloads should cost nothing, which is most of the time it is up.
  const busy = all.some((item) => RUNNING.has(item.state));
  clearTimeout(tickTimer);
  if (busy) tickTimer = setTimeout(load, TICK_MS);
}

/* ------------------------------------------------------------------ */

function close() {
  api.send('close-menu');
}

el.seeAll.addEventListener('click', () => api.send('open-downloads-page'));
el.backdrop.addEventListener('mousedown', close);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { close(); return; }

  // A tab loop that cannot walk out of the panel, which is the other half of
  // what a system popup gives for free. Without it, Tab moves focus to nothing
  // visible and the next keystroke goes somewhere nobody can see.
  if (event.key !== 'Tab') return;
  const focusable = [...el.sheet.querySelectorAll('button:not(:disabled):not([hidden])')];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === el.sheet)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
});

api.onState((state) => applyThemePrefs(state.prefs));

load();
