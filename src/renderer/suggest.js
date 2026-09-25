'use strict';

/**
 * Draws what the address bar offers, and takes the click.
 *
 * The rows come from the browser (see src/main/suggest.js); which one is
 * highlighted is decided in the address bar, where the keyboard is, and sent
 * here. A press acts on mousedown rather than click: pressing moves focus out
 * of the address bar, and the browser hides this list when that happens - a
 * handler waiting for the button to come back up would sometimes find the list
 * already gone.
 */

const api = window.debrowser;
const list = document.getElementById('list');
let rows = [];

/* The two glyphs this list needs, in the same 16px, 1.5-stroke drawing as the
   rest of the browser's icons. */
const SVG_NS = 'http://www.w3.org/2000/svg';
function glyph(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'glyph');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
const SEARCH = ['M7 12.25A5.25 5.25 0 1 0 7 1.75a5.25 5.25 0 0 0 0 10.5z', 'M10.8 10.8l3.45 3.45'];
const GO = ['M3 8h9.5', 'M8.5 4l4 4-4 4'];

const tidy = (url) => String(url || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');

function row(item, index) {
  const el = document.createElement('div');
  el.className = item.isDefault ? 'row default' : 'row';
  el.setAttribute('role', 'option');
  el.dataset.index = String(index);

  const title = document.createElement('span');
  title.className = 'title';
  const detail = document.createElement('span');
  detail.className = 'detail';

  if (item.kind === 'search') {
    el.append(glyph(SEARCH));
    title.textContent = item.title;
    detail.textContent = `${item.engine} search`;
  } else if (item.kind === 'go') {
    el.append(glyph(GO));
    title.textContent = item.title;
  } else {
    el.append(siteChip(item.url));
    title.textContent = item.title;
    detail.textContent = tidy(item.url);
  }
  el.append(title, detail);

  if (item.kind === 'tab') {
    const action = document.createElement('span');
    action.className = 'action';
    action.textContent = 'Switch to tab';
    el.append(action);
  }
  return el;
}

function render(items, selected) {
  const wasEmpty = rows.length === 0;
  hovered = -1;
  rows = items;
  list.replaceChildren(...items.map(row));
  select(selected);
  if (wasEmpty && items.length) {
    list.classList.remove('arriving');
    void list.offsetWidth;          // restart the animation
    list.classList.add('arriving');
  }
  reportSize();
}

function select(index) {
  for (const el of list.children) el.classList.toggle('selected', Number(el.dataset.index) === index);
}

let lastHeight = 0;
function reportSize() {
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height === lastHeight) return;
  lastHeight = height;
  api.send('suggest-size', { height });
}

// Pointing at a row selects it, as the arrow keys do - one highlight, and
// it is the row Enter takes. A separate hover tint beside the keyboard's left
// two rows lit and no way to tell which one Enter meant.
//
// Only for a pointer that actually moved. Chromium sends a mousemove after
// every relayout to a pointer resting where the list opens, and that used to
// select a row nobody pointed at - so typing and pressing Enter took some
// history row instead of searching.
let hovered = -1;
let pointer = null;
list.addEventListener('mousemove', (event) => {
  const at = `${event.screenX},${event.screenY}`;
  const moved = pointer !== null && pointer !== at;
  pointer = at;
  if (!moved) return;
  const el = event.target.closest('.row');
  const index = el ? Number(el.dataset.index) : -1;
  if (index < 0 || index === hovered) return;
  hovered = index;
  select(index);
  api.send('suggest-hover', { index });
});

list.addEventListener('mousedown', (event) => {
  const el = event.target.closest('.row');
  if (!el || (event.button !== 0 && event.button !== 1)) return;
  event.preventDefault();
  api.send('suggest-pick', { index: Number(el.dataset.index), newTab: event.button === 1 || event.ctrlKey || event.metaKey });
});

api.onMessage((message) => {
  if (message.kind === 'suggest-items') render(message.items || [], message.selected ?? -1);
  else if (message.kind === 'suggest-select') select(message.index);
  else if (message.kind === 'suggest-reset') { rows = []; lastHeight = 0; hovered = -1; list.replaceChildren(); }
});

api.onState((state) => applyThemePrefs(state.prefs));
