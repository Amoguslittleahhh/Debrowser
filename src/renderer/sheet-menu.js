'use strict';

/**
 * What the app menu and the page's context menu have in common.
 *
 * Both are a card of rows in a window-sized transparent view: same stylesheet,
 * same roles, same dismissal, same keyboard. They were written as two files
 * with the same code in each, and had already drifted - the two focus loops
 * disagreed about where Shift+Tab lands from nothing, which is the kind of
 * difference nobody chooses.
 *
 * So the parts that are the same live here, and each menu keeps only what is
 * genuinely its own: where it gets its model, how it draws a row, and where it
 * opens. Loaded by `menu.html` and `context.html` only - the chrome does not
 * need it, and the chrome is the renderer that is alive all session.
 *
 * Replacing a platform menu means owning what a platform menu did for free.
 * The two that matter are here and are not optional: the keyboard (arrows,
 * Home/End, Escape, and a tab loop that cannot leave the menu) and the
 * accessibility tree - a real `role="menu"` of real buttons, so a screen reader
 * announces this as a menu rather than as a page with buttons on it.
 */

/**
 * The glyphs, as path data.
 *
 * Inline rather than a font or a sprite, for the reason the rest of this UI is:
 * no request, no decode, nothing to load before a menu that has to be drawn
 * within a frame of the click. One table for both menus, because five of these
 * were already in both of them character for character.
 */
const MENU_ICONS = {
  plus:  ['M8 3v10M3 8h10'],
  minus: ['M3 8h10'],
  pin:   ['M9.5 2.5l4 4', 'M12 5l-3.5 3.5-3-.5-1 1 4 4 1-1-.5-3', 'M6.5 9.5l-4 4'],
  shield: ['M8 2.5l4.5 1.8v3.4c0 2.8-1.9 4.8-4.5 5.8-2.6-1-4.5-3-4.5-5.8V4.3z'],
  print: ['M4.5 6V2.5h7V6', 'M4.5 11.5h-2v-4h11v4h-2', 'M4.5 9.5h7v4h-7z'],
  clock: ['M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z', 'M8 5v3.2l2.2 1.3'],
  gauge: ['M2.5 11.5a5.5 5.5 0 1 1 11 0', 'M8 11.5L10.6 7'],
  code:  ['M6 5.5L3 8l3 2.5', 'M10 5.5L13 8l-3 2.5'],
  download: ['M8 2.5v7', 'M5 7l3 3 3-3', 'M3 11.5v1.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-1.5'],
  star:  ['M8 2.6l1.7 3.45 3.8.55-2.75 2.68.65 3.79L8 11.28l-3.4 1.79.65-3.79L2.5 6.6l3.8-.55z'],
  key:   ['M5.5 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M8.2 8.8l5.3 0', 'M11.5 8.8v2', 'M13.5 8.8v1.5'],
  expand: ['M6 2.5H2.5V6', 'M10 2.5h3.5V6', 'M6 13.5H2.5V10', 'M10 13.5h3.5V10'],
  keyboard: ['M2.5 4.5h11v7h-11z', 'M5 7h.01', 'M8 7h.01', 'M11 7h.01', 'M5.5 9.5h5'],
  gear:  ['M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z',
          'M12.6 9.6l1.2.7-1.3 2.2-1.3-.5a4.9 4.9 0 0 1-1.2.7L9.7 14h-2.6L6.9 12.7a4.9 4.9 0 0 1-1.2-.7l-1.3.5L3.1 10.3l1.2-.7a4.9 4.9 0 0 1 0-1.4l-1.2-.7 1.3-2.2 1.3.5a4.9 4.9 0 0 1 1.2-.7L7.1 3h2.6l.3 1.3c.43.17.83.4 1.2.7l1.3-.5 1.3 2.2-1.2.7a4.9 4.9 0 0 1 0 1.4z'],
  copy: ['M5.5 5.5h7v8h-7z', 'M3.5 10.5v-8h7'],
  scissors: ['M4.5 3l7 9', 'M11.5 3l-7 9', 'M4 12.5a1.5 1.5 0 1 0 0 .01', 'M12 12.5a1.5 1.5 0 1 0 0 .01'],
  clipboard: ['M6 3.5H4.5v10h7v-10H10', 'M6 2.5h4v2H6z'],
  select: ['M3 3.5h10v9H3z', 'M5.5 8h5'],
  search: ['M7 3.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z', 'M9.8 9.8l3 3'],
  back: ['M10 3L5 8l5 5'],
  forward: ['M6 3l5 5-5 5'],
  reload: ['M13.5 8a5.5 5.5 0 1 1-1.6-3.9', 'M13.5 2v3.2h-3.2'],
  inspect: ['M2.5 2.5h5v5h-5z', 'M7.5 7.5l6 6', 'M9.5 13.5h4v-4'],
  // Drawn to the same 11px extent as the rest of the set, so a cross in a menu
  // is the weight of the glyph above it rather than whatever an X happens to be.
  close: ['M3.5 3.5l9 9', 'M12.5 3.5l-9 9'],
  // A speaker with the sound struck through. One glyph for both directions:
  // the label says which way the item goes, and a menu that changes its icon as
  // well as its words is two things to read where one would do.
  mute: ['M8.5 3.5L5.5 6H3.5v4h2l3 2.5z', 'M11 6.5l3 3', 'M14 6.5l-3 3']
};

/* eslint-disable-next-line no-unused-vars -- read by menu.js and context.js */
function menuIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of MENU_ICONS[name] || []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * The keyboard, and the click-away.
 *
 * Both menus are dismissed the same way and walked the same way, and both are
 * inside a view the browser closes when focus leaves it - which is why Tab is
 * trapped here: letting it walk out of the sheet would dismiss the menu the
 * user is trying to walk through.
 *
 * @param {HTMLElement} sheet - the card holding the items
 * @param {HTMLElement} backdrop - the invisible full-window dismiss target
 * @param {() => void} close - what dismissing means to this menu
 */
/* eslint-disable-next-line no-unused-vars -- read by menu.js and context.js */
function wireMenuKeyboard(sheet, backdrop, close) {
  const focusables = () => [...sheet.querySelectorAll('button:not(:disabled)')];

  const focusItem = (index) => {
    const list = focusables();
    if (!list.length) return;
    list[(index + list.length) % list.length].focus();
  };

  const moveFocus = (delta) => {
    const list = focusables();
    const at = list.indexOf(document.activeElement);
    // From nothing, ArrowDown lands on the first item and ArrowUp on the last -
    // the two files disagreed about this, and starting at 0 for both means
    // Shift+Tab out of the sheet jumped to the top rather than the bottom.
    focusItem(at === -1 ? (delta > 0 ? 0 : -1) : at + delta);
  };

  window.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'Escape': close(); break;
      case 'ArrowDown': moveFocus(1); break;
      case 'ArrowUp': moveFocus(-1); break;
      case 'Home': focusItem(0); break;
      case 'End': focusItem(-1); break;
      case 'Tab': moveFocus(event.shiftKey ? -1 : 1); break;
      default: return;
    }
    event.preventDefault();
  });

  // The click-away a system menu gets from a pointer grab, and the reason the
  // view is window-sized rather than menu-sized.
  backdrop.addEventListener('mousedown', close);
}

// A theme changed while a menu is open reaches it too; it used to keep the
// palette it opened with until it closed.
window.debrowser.onState((state) => applyThemePrefs(state.prefs));

// The pointer moves the keyboard's place. With the two apart, a menu showed
// two highlighted rows - one hovered, one focused - and the next arrow key
// went on from the one the pointer had left.
document.addEventListener('mousemove', (event) => {
  const item = event.target.closest && event.target.closest('.item');
  if (item && !item.disabled && document.activeElement !== item) item.focus({ preventScroll: true });
});
