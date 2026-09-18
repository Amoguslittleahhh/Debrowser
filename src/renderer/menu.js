'use strict';

/**
 * The app menu.
 *
 * Draws itself from a model the browser hands over (`menu-model`), where each
 * item's `id` is the command to send back. Nothing here knows what "History"
 * means - it knows that the item labelled History carries `open-history` - so
 * there is one list of what the menu does, in main.js, rather than two that
 * drift.
 *
 * Replacing a platform menu means owning what a platform menu did for free.
 * The two that matter are implemented below and are not optional: the keyboard
 * (arrows, Home/End, Enter, Escape, and a tab loop that cannot leave the menu)
 * and the accessibility tree (a real `role="menu"` of real buttons, so a screen
 * reader announces this as a menu rather than as a page with buttons on it).
 */

const api = window.debrowser;

const el = {
  sheet: document.getElementById('sheet'),
  backdrop: document.getElementById('backdrop')
};

/** Where the button that opened this is, in window coordinates. */
const params = new URLSearchParams(location.search);
const anchor = {
  x: Number(params.get('x')) || 0,
  y: Number(params.get('y')) || 0,
  right: Number(params.get('right')) || 0
};

/** Distance kept from the window's edges when the menu will not fit. */
const EDGE = 8;

/**
 * The glyphs, as path data.
 *
 * Inline rather than a font or a sprite, for the reason the rest of this UI is:
 * no request, no decode, nothing to load before the menu can be drawn - and it
 * is drawn within a frame of the click.
 */
const ICONS = {
  plus:  ['M8 3v10M3 8h10'],
  print: ['M4.5 6V2.5h7V6', 'M4.5 11.5h-2v-4h11v4h-2', 'M4.5 9.5h7v4h-7z'],
  clock: ['M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z', 'M8 5v3.2l2.2 1.3'],
  gauge: ['M2.5 11.5a5.5 5.5 0 1 1 11 0', 'M8 11.5L10.6 7'],
  code:  ['M6 5.5L3 8l3 2.5', 'M10 5.5L13 8l-3 2.5'],
  download: ['M8 2.5v7', 'M5 7l3 3 3-3', 'M3 11.5v1.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-1.5'],
  star:  ['M8 2.6l1.7 3.45 3.8.55-2.75 2.68.65 3.79L8 11.28l-3.4 1.79.65-3.79L2.5 6.6l3.8-.55z'],
  expand: ['M6 2.5H2.5V6', 'M10 2.5h3.5V6', 'M6 13.5H2.5V10', 'M10 13.5h3.5V10'],
  gear:  ['M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z',
          'M12.6 9.6l1.2.7-1.3 2.2-1.3-.5a4.9 4.9 0 0 1-1.2.7L9.7 14h-2.6L6.9 12.7a4.9 4.9 0 0 1-1.2-.7l-1.3.5L3.1 10.3l1.2-.7a4.9 4.9 0 0 1 0-1.4l-1.2-.7 1.3-2.2 1.3.5a4.9 4.9 0 0 1 1.2-.7L7.1 3h2.6l.3 1.3c.43.17.83.4 1.2.7l1.3-.5 1.3 2.2-1.2.7a4.9 4.9 0 0 1 0 1.4z']
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
 * Run an item, then get out of the way.
 *
 * Closed here rather than waiting for the browser to do it: the command may
 * open a tab or a window, and a menu still sitting over the thing the user just
 * asked for is the most obvious way this could feel worse than the system one.
 */
function invoke(id) {
  api.send(id);
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

    if (item.kind === 'note') {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = item.label;
      el.sheet.append(note);
      continue;
    }

    if (item.kind === 'zoom') {
      el.sheet.append(zoomRow(item));
      continue;
    }

    const button = document.createElement('button');
    button.className = 'item';
    button.type = 'button';
    button.setAttribute('role', item.kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem');
    if (item.kind === 'checkbox') button.setAttribute('aria-checked', String(Boolean(item.checked)));
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

    button.addEventListener('click', () => invoke(item.id));
    el.sheet.append(button);
  }

  place();
  // The sheet itself, not the first item.
  //
  // The view has to hold focus for the keyboard to reach it at all, but
  // focusing an *item* draws it as though the user had arrowed onto it - so a
  // menu opened with the mouse came up with New tab already highlighted, which
  // reads as a selection nobody made. ArrowDown from here lands on the first
  // item, which is what a menu does everywhere else.
  el.sheet.focus();
}

/**
 * The zoom stepper.
 *
 * The only row that does not close the menu when it is used: stepping the zoom
 * is something you do two or three times while watching the page behind, and a
 * menu that vanished after the first press would make that four round trips.
 * After each step the model is asked for again, so the percentage shown is the
 * browser's answer rather than this file's arithmetic - the two lists of zoom
 * steps that would otherwise need to agree do not exist.
 */
function zoomRow(item) {
  const row = document.createElement('div');
  row.className = 'zoom';

  const label = document.createElement('span');
  label.className = 'zoom-label';
  label.textContent = item.label;

  const reset = document.createElement('button');
  reset.className = 'zoom-reset';
  reset.type = 'button';
  reset.textContent = 'Reset';
  reset.dataset.zoom = 'reset';
  reset.disabled = item.enabled === false || item.value === 100;
  reset.addEventListener('click', () => step('reset'));

  const out = document.createElement('button');
  out.className = 'step';
  out.type = 'button';
  out.textContent = '−';
  out.dataset.zoom = 'out';
  out.setAttribute('aria-label', 'Zoom out');
  out.disabled = item.enabled === false;
  out.addEventListener('click', () => step('out'));

  const value = document.createElement('span');
  value.className = 'zoom-value';
  value.textContent = `${item.value}%`;

  const into = document.createElement('button');
  into.className = 'step';
  into.type = 'button';
  into.textContent = '+';
  into.dataset.zoom = 'in';
  into.setAttribute('aria-label', 'Zoom in');
  into.disabled = item.enabled === false;
  into.addEventListener('click', () => step('in'));

  // Reset last, after the stepper it resets.
  //
  // It sat between the label and the minus, which put a word in the middle of
  // a control: the eye reads "Zoom … Reset … − 110% +" and has to work out
  // which of the three things the Reset belongs to. At the end it reads as what
  // it is - the way back from wherever the stepper has got to.
  row.append(label, out, value, into, reset);
  return row;
}

async function step(direction) {
  api.send('zoom', { direction });
  const res = await api.request('menu-model');
  if (!res || !res.items) return;

  const was = document.activeElement?.dataset?.zoom || null;
  render(res.items);
  // Put focus back on the button that was just pressed. Re-rendering moved it
  // to the first item, so without this a second press of Enter would open a new
  // tab instead of stepping the zoom again.
  if (was) {
    const again = el.sheet.querySelector(`[data-zoom="${was}"]`);
    if (again && !again.disabled) again.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Placement                                                           */
/* ------------------------------------------------------------------ */

/**
 * Under the button, right edges aligned, and never off the screen.
 *
 * Right-aligned because the button is at the top right of the window and the
 * menu is eight times its width: aligning the left edges would put the menu
 * out past the window. Flipping above the anchor when there is no room below is
 * the other half of what a system menu does for free and is why the anchor
 * carries its own coordinates rather than being inferred here.
 */
function place() {
  const sheet = el.sheet;
  const width = sheet.offsetWidth;
  const height = sheet.offsetHeight;
  const right = anchor.right || anchor.x;

  let left = right - width;
  left = Math.min(Math.max(EDGE, left), Math.max(EDGE, window.innerWidth - width - EDGE));

  let top = anchor.y + 6;
  if (top + height > window.innerHeight - EDGE) {
    // Above the button if it fits there, otherwise pinned to the bottom edge -
    // a menu hanging off the screen is worse than one that is not where it was
    // asked to be.
    const above = anchor.y - height - 40;
    top = above > EDGE ? above : Math.max(EDGE, window.innerHeight - height - EDGE);
  }

  sheet.style.left = `${Math.round(left)}px`;
  sheet.style.top = `${Math.round(top)}px`;
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

/** Everything that can be focused, in the order the eye reads them. */
function focusables() {
  return [...el.sheet.querySelectorAll('button:not(:disabled)')];
}

function focusItem(index) {
  const list = focusables();
  if (!list.length) return;
  const wrapped = (index + list.length) % list.length;
  list[wrapped].focus();
}

function moveFocus(delta) {
  const list = focusables();
  const at = list.indexOf(document.activeElement);
  focusItem(at === -1 ? 0 : at + delta);
}

window.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'Escape': close(); break;
    case 'ArrowDown': moveFocus(1); break;
    case 'ArrowUp': moveFocus(-1); break;
    case 'Home': focusItem(0); break;
    case 'End': focusItem(-1); break;
    case 'Tab':
      // Trapped. Focus leaving this view closes the menu (the browser watches
      // for that), so letting Tab walk out of the sheet would dismiss the menu
      // the user is trying to walk through.
      moveFocus(event.shiftKey ? -1 : 1);
      break;
    default:
      return;
  }
  event.preventDefault();
});

// Anywhere outside the sheet. This is the click-away a system menu gets from a
// pointer grab, and the reason the view is window-sized rather than menu-sized.
el.backdrop.addEventListener('mousedown', close);

/* ------------------------------------------------------------------ */

api.request('menu-model').then((res) => {
  if (!res) return;
  // Theme and accent ride along with the model rather than arriving on the
  // state broadcast: this view exists for a second or two, and subscribing it
  // to a message that reaches three other views twice a second would be paying
  // a running cost for a moment's worth of styling.
  applyThemePrefs(res.prefs);
  render(res.items || []);
});

window.addEventListener('resize', place);
