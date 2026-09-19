'use strict';

/**
 * The page's context menu.
 *
 * Right-clicking a page did nothing at all before this, which is the single
 * most noticeable thing a browser can be missing: Electron fires a
 * `context-menu` event and, unless something answers it, no menu appears.
 *
 * Deliberately the same object as the app menu rather than a copy of it: the
 * same stylesheet, and the same glyphs, keyboard and click-away out of
 * sheet-menu.js. It draws from a model built in the browser process, so nothing
 * here knows what "Copy link address" means, only that the item carries
 * `copy-link` and a payload.
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

    button.append(menuIcon(item.icon));

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

// The keyboard and the click-away are the same in both menus; see sheet-menu.js.
wireMenuKeyboard(el.sheet, el.backdrop, close);

/*
 * A right-click somewhere else dismisses this menu, and does not open the next
 * one - which is worth stating rather than leaving as a surprise.
 *
 * The backdrop is what makes the menu dismissable at all, and it necessarily
 * swallows the click: the page never sees the right-click, so there is nothing
 * to hit-test and no new menu to build from. The honest behaviour is therefore
 * one click to dismiss and one to open again, and the guard in `openSheet` that
 * would otherwise eat that second click is lifted for this sheet - see the note
 * there.
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
