'use strict';

/**
 * The page's context menu.
 *
 * Right-clicking a page did nothing at all before this, which is the single
 * most noticeable thing a browser can be missing: Electron fires a
 * `context-menu` event and, unless something answers it, no menu appears.
 *
 * Deliberately the same shape as the app menu, and deliberately not a copy of
 * it. It loads `menu.css`, so a change to how a row looks lands on both; it
 * draws from a model built in the browser process, so nothing here knows what
 * "Copy link address" means, only that the item carries `copy-link` and a
 * payload; and it owns the same two things a platform menu would have given us
 * for free - the keyboard, and an accessibility tree that announces a menu
 * rather than a page with buttons on it.
 *
 * What it does *not* share with the app menu is where it opens: a menu raised
 * by a right-click hangs down and to the right of the pointer, not from the
 * right edge of a button.
 */

const api = window.debrowser;

const el = {
  sheet: document.getElementById('sheet'),
  backdrop: document.getElementById('backdrop')
};

/** Where the pointer was, in window coordinates. */
const params = new URLSearchParams(location.search);
const anchor = {
  x: Number(params.get('x')) || 0,
  y: Number(params.get('y')) || 0,
  right: Number(params.get('right')) || 0
};

const EDGE = 8;

/**
 * The glyphs, as path data - inline for the same reason the app menu's are:
 * no request and no decode before a menu that has to be drawn within a frame
 * of the click.
 */
const ICONS = {
  plus: ['M8 3v10M3 8h10'],
  copy: ['M5.5 5.5h7v8h-7z', 'M3.5 10.5v-8h7'],
  download: ['M8 2.5v7', 'M5 7l3 3 3-3', 'M3 11.5v1.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-1.5'],
  scissors: ['M4.5 3l7 9', 'M11.5 3l-7 9', 'M4 12.5a1.5 1.5 0 1 0 0 .01', 'M12 12.5a1.5 1.5 0 1 0 0 .01'],
  clipboard: ['M6 3.5H4.5v10h7v-10H10', 'M6 2.5h4v2H6z'],
  select: ['M3 3.5h10v9H3z', 'M5.5 8h5'],
  search: ['M7 3.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z', 'M9.8 9.8l3 3'],
  back: ['M10 3L5 8l5 5'],
  forward: ['M6 3l5 5-5 5'],
  reload: ['M13.5 8a5.5 5.5 0 1 1-1.6-3.9', 'M13.5 2v3.2h-3.2'],
  star: ['M8 2.6l1.7 3.45 3.8.55-2.75 2.68.65 3.79L8 11.28l-3.4 1.79.65-3.79L2.5 6.6l3.8-.55z'],
  print: ['M4.5 6V2.5h7V6', 'M4.5 11.5h-2v-4h11v4h-2', 'M4.5 9.5h7v4h-7z'],
  code: ['M6 5.5L3 8l3 2.5', 'M10 5.5L13 8l-3 2.5'],
  inspect: ['M2.5 2.5h5v5h-5z', 'M7.5 7.5l6 6', 'M9.5 13.5h4v-4']
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/* ------------------------------------------------------------------ */

function close() {
  api.send('close-menu');
}

/**
 * Run an item, then get out of the way - as the app menu does, and for the same
 * reason: the command may open a tab, and a menu still sitting over the thing
 * that was just asked for is the clearest way this could feel worse than the
 * platform menu it replaces.
 */
function invoke(item) {
  api.send(item.id, item.payload || null);
  close();
}

function render(items) {
  el.sheet.textContent = '';

  for (const item of items) {
    if (item.kind === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'sep';
      sep.setAttribute('role', 'separator');
      el.sheet.append(sep);
      continue;
    }

    const button = document.createElement('button');
    button.className = 'item';
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    if (item.enabled === false) button.disabled = true;

    button.append(icon(item.icon));

    const label = document.createElement('span');
    label.className = 'item-label';
    label.textContent = item.label;
    button.append(label);

    if (item.accel) {
      const accel = document.createElement('span');
      accel.className = 'accel';
      accel.textContent = item.accel;
      button.append(accel);
    }

    button.addEventListener('click', () => invoke(item));
    el.sheet.append(button);
  }

  place();
  // The sheet, not the first item: focusing an item draws it as though the user
  // had arrowed onto it, and a menu that opens with something already
  // highlighted reads as a selection nobody made.
  el.sheet.focus();
}

function place() {
  anchorSheet(el.sheet, anchor, EDGE, 'left');
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

function focusables() {
  return [...el.sheet.querySelectorAll('button:not(:disabled)')];
}

function focusItem(index) {
  const list = focusables();
  if (!list.length) return;
  list[(index + list.length) % list.length].focus();
}

function moveFocus(delta) {
  const list = focusables();
  const at = list.indexOf(document.activeElement);
  focusItem(at === -1 ? (delta > 0 ? 0 : -1) : at + delta);
}

window.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'Escape': close(); break;
    case 'ArrowDown': moveFocus(1); break;
    case 'ArrowUp': moveFocus(-1); break;
    case 'Home': focusItem(0); break;
    case 'End': focusItem(-1); break;
    // Trapped: focus leaving this view dismisses the menu, so Tab walking out
    // of it would close the menu the user is trying to walk through.
    case 'Tab': moveFocus(event.shiftKey ? -1 : 1); break;
    default: return;
  }
  event.preventDefault();
});

el.backdrop.addEventListener('mousedown', close);

/*
 * A right-click somewhere else dismisses this menu, and does not open the next
 * one - which is worth stating rather than leaving as a surprise.
 *
 * The backdrop is what makes the menu dismissable at all, and it necessarily
 * swallows the click: the page never sees the right-click, so there is nothing
 * to hit-test and no new menu to build from. The honest behaviour is therefore
 * one click to dismiss and one to open again, and the guard in `openSheet`
 * that would otherwise eat that second click is lifted for this sheet - see the
 * note there.
 */
el.backdrop.addEventListener('contextmenu', (event) => { event.preventDefault(); close(); });

/* ------------------------------------------------------------------ */

api.request('context-model').then((res) => {
  if (!res) return;
  applyThemePrefs(res.prefs);
  const items = res.items || [];
  // An empty model means the hit test produced nothing worth showing, which
  // should not happen - the page section is unconditional - but a menu with no
  // rows in it would be a small empty card floating over the page.
  if (!items.length) { close(); return; }
  render(items);
});

window.addEventListener('resize', place);
