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
 * What this file holds is what is particular to *this* menu: the model it asks
 * for, the zoom stepper, and where it opens. The glyph table, the keyboard and
 * the click-away are shared with the page's context menu - see sheet-menu.js,
 * which also says why owning them at all is not optional.
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
  anchorSheet(el.sheet, anchor, EDGE);
}

/* ------------------------------------------------------------------ */

// The keyboard and the click-away are the same in both menus; see sheet-menu.js.
wireMenuKeyboard(el.sheet, el.backdrop, close);

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
