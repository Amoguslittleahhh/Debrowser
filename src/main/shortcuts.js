'use strict';

/**
 * Every keyboard shortcut the browser has, in one table.
 *
 * There used to be two, and they disagreed. The chrome bound its own set in the
 * DOM (`Ctrl+L`, `Ctrl+D`, `Ctrl+Shift+B`) and the browser process bound
 * another to each page's renderer (`Ctrl+P`, `Ctrl+Shift+O`) - so which
 * shortcuts existed depended on which view happened to hold focus, and since a
 * page holds it nearly all the time, the address bar could not be reached from
 * the keyboard at all. Settings advertised `Ctrl+Shift+B` for a binding that
 * only ever ran when the toolbar was focused, which is almost never.
 *
 * So: one table, here, and `before-input-event` on every view including the
 * chrome. That hook is the only one that sees a keystroke before the page does,
 * and it is per-webContents, which is why every view has to be bound rather
 * than there being one global handler. Nothing is registered as a system
 * accelerator: this browser has no application menu, and a global shortcut
 * would fire while another application was in front.
 *
 * The same table names the accelerators shown in the menu, so a label and the
 * key it advertises cannot drift apart - which is the failure this replaces.
 */

const IS_MAC = process.platform === 'darwin';

/** What to call the modifier in a label. */
const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';
const ALT_LABEL = IS_MAC ? '⌥' : 'Alt';
const SHIFT_LABEL = IS_MAC ? '⇧' : 'Shift';

/**
 * The bindings.
 *
 * `key` is matched against `input.key`, lowercased - so it is the character the
 * layout actually produces, not a scan code. `keys` lists alternatives where a
 * shortcut genuinely has more than one spelling (`Ctrl+=` and `Ctrl++` are the
 * same keypress on most layouts, and `+` is what a US layout reports).
 *
 * Modifiers are exact unless a row says `shift: 'any'`: an entry with no
 * `shift` requires shift *up*, so `Ctrl+Shift+T` cannot be swallowed by the
 * `Ctrl+T` row above it. That
 * exactness is the whole reason the old chrome-side table mis-bound
 * `Ctrl+Shift+B` - it matched `b` first and only then looked at shift.
 *
 * Order matters only for `accelFor`, which reports the first spelling listed.
 */
const TABLE = [
  // Tabs
  { command: 'new-tab', mod: true, key: 't' },
  { command: 'new-incognito-window', mod: true, shift: true, key: 'n' },
  // Private windows only; the same keys Tor Browser uses.
  { command: 'new-circuit', mod: true, shift: true, key: 'l' },
  { command: 'new-identity', mod: true, shift: true, key: 'u' },
  // The panic key: the private window, Tor and every file gone at once.
  { command: 'panic', mod: true, shift: true, key: 'delete' },
  { command: 'close-tab', mod: true, key: 'w' },
  { command: 'reopen-closed-tab', mod: true, shift: true, key: 't' },
  { command: 'cycle-tab', payload: { delta: 1 }, mod: true, key: 'tab' },
  { command: 'cycle-tab', payload: { delta: -1 }, mod: true, shift: true, key: 'tab' },
  { command: 'cycle-tab', payload: { delta: 1 }, mod: true, key: 'pagedown' },
  { command: 'cycle-tab', payload: { delta: -1 }, mod: true, key: 'pageup' },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
    { command: 'select-tab', payload: { index: n - 1 }, mod: true, key: String(n) })),
  // The ninth is the last tab, not the ninth tab, in every browser that has it.
  { command: 'select-tab', payload: { index: -1 }, mod: true, key: '9' },

  // Navigation
  { command: 'reload', mod: true, key: 'r' },
  { command: 'reload', key: 'f5' },
  { command: 'reload-hard', mod: true, shift: true, key: 'r' },
  // Alt on a Mac is Option, and Option+arrows move by word and Option+D types
  // a character - taking them would break every text field. A Mac browser uses
  // Cmd+[ and Cmd+] for history, and Cmd+L alone for the address bar.
  ...(IS_MAC ? [
    { command: 'back', mod: true, key: '[' },
    { command: 'forward', mod: true, key: ']' }
  ] : [
    { command: 'back', alt: true, key: 'arrowleft' },
    { command: 'forward', alt: true, key: 'arrowright' }
  ]),
  { command: 'focus-address', mod: true, key: 'l' },
  ...(IS_MAC ? [] : [{ command: 'focus-address', alt: true, key: 'd' }]),
  { command: 'focus-address', key: 'f6' },

  // Find
  { command: 'find-open', mod: true, key: 'f' },
  { command: 'find-next', key: 'f3' },
  { command: 'find-next', mod: true, key: 'g' },
  { command: 'find-prev', shift: true, key: 'f3' },
  { command: 'find-prev', mod: true, shift: true, key: 'g' },

  // Zoom. Both spellings of the same physical key, plus the numpad's. Shift
  // either way, because `+` and `_` are the shifted spellings on a US layout
  // while the numpad's `+` and `-`, and `+` on many other layouts, are not -
  // requiring shift up made the main-row `Ctrl++` a key that did nothing.
  { command: 'zoom', payload: { direction: 'in' }, mod: true, shift: 'any', keys: ['=', '+'] },
  { command: 'zoom', payload: { direction: 'out' }, mod: true, shift: 'any', keys: ['-', '_'] },
  { command: 'zoom', payload: { direction: 'reset' }, mod: true, key: '0' },

  // Places
  { command: 'bookmark-page', mod: true, key: 'd' },
  { command: 'toggle-bookmarks-bar', mod: true, shift: true, key: 'b' },
  { command: 'open-bookmarks', mod: true, shift: true, key: 'o' },
  { command: 'open-history', mod: true, key: 'h' },
  { command: 'open-downloads', mod: true, key: 'j' },
  { command: 'open-settings', mod: true, key: ',' },

  // Tools
  { command: 'print', mod: true, key: 'p' },
  { command: 'save-page', mod: true, key: 's' },
  { command: 'view-source', mod: true, key: 'u' },
  { command: 'toggle-panel', mod: true, key: 'm' },
  { command: 'toggle-devtools', key: 'f12' },
  { command: 'toggle-devtools', mod: true, shift: true, key: 'i' },
  { command: 'toggle-fullscreen', key: 'f11' },
  { command: 'show-shortcuts', mod: true, key: '/' }
];

// Every entry answers to a list of spellings, normalised once here rather than
// built per row per keystroke. `match` runs on every key the browser sees, and
// a modified keystroke reaches most of the table: the old shape allocated a
// throwaway array for each row it tested.
for (const entry of TABLE) {
  if (!entry.keys) entry.keys = [entry.key];
}

/**
 * The command a keystroke means, or null to leave it to the page.
 *
 * Deliberately conservative: anything not in the table above is passed straight
 * through, including every shortcut a web application defines for itself. A
 * browser that swallowed `Ctrl+S` in a document editor because it might one day
 * want the key would be worse than one with no shortcuts at all.
 *
 * @param {Electron.Input} input
 * @returns {{command: string, payload: object|null}|null}
 */
function match(input) {
  if (!input || input.type !== 'keyDown') return null;

  // Cmd on a Mac, Ctrl everywhere else. Never both: `Ctrl+T` on macOS is a
  // terminal binding (transpose) and taking it would be rude.
  const mod = IS_MAC ? Boolean(input.meta) : Boolean(input.control);
  // The other one is a modifier we must *not* see. Without this, `Ctrl+Alt+T`
  // - which is a desktop-wide terminal shortcut on most Linux machines - would
  // open a tab here as well.
  const other = IS_MAC ? Boolean(input.control) : Boolean(input.meta);
  if (other) return null;

  const key = String(input.key || '').toLowerCase();
  const shift = Boolean(input.shift);
  const alt = Boolean(input.alt);

  for (const entry of TABLE) {
    if (Boolean(entry.mod) !== mod) continue;
    if (entry.shift !== 'any' && Boolean(entry.shift) !== shift) continue;
    if (Boolean(entry.alt) !== alt) continue;
    if (!entry.keys.includes(key)) continue;
    return { command: entry.command, payload: entry.payload || null };
  }
  return null;
}

/** How a key is written in a menu. */
function labelFor(entry) {
  const parts = [];
  if (entry.mod) parts.push(MOD_LABEL);
  if (entry.alt) parts.push(ALT_LABEL);
  if (entry.shift === true) parts.push(SHIFT_LABEL);

  const key = entry.keys[0];
  const named = {
    arrowleft: '←', arrowright: '→', pagedown: 'PgDn', pageup: 'PgUp',
    tab: 'Tab', '=': '+', '-': '−'
  };
  parts.push(named[key] || key.toUpperCase());
  // A Mac menu writes ⌘T with nothing between the symbols; everywhere else the
  // parts are joined with a plus.
  return IS_MAC ? parts.join('') : parts.join('+');
}

/**
 * The accelerator to print beside a menu item, or '' if the command has none.
 *
 * Takes the first entry for the command, which is why the table lists the
 * canonical spelling first - `Ctrl+R` before `F5`.
 */
function accelFor(command, payload = null) {
  const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  const entry = TABLE.find((row) => row.command === command && (!payload || same(row.payload, payload)));
  return entry ? labelFor(entry) : '';
}

/**
 * The keyboard shortcut sheet (Ctrl+/): the table above, as people think of
 * it - by what they want to do rather than by key - and in words. Read from
 * the table, so a binding changed there is a binding changed here.
 *
 * @param {{incognito?: boolean}} [options]
 * @returns {Array<{title: string, rows: Array<{label: string, keys: string}>}>}
 */
function sheet({ incognito = false } = {}) {
  // Every spelling of a command, not only the first: F5 is how many people
  // reload, and a list that leaves it out suggests it does not work.
  const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  const row = (label, command, payload) => ({
    label,
    keys: TABLE.filter((r) => r.command === command && (!payload || same(r.payload, payload)))
      .map(labelFor).join('  ·  ')
  });
  const groups = [
    { title: 'Tabs', rows: [
      row('New tab', 'new-tab'),
      row('Close tab', 'close-tab'),
      row('Reopen closed tab', 'reopen-closed-tab'),
      row('Next tab', 'cycle-tab', { delta: 1 }),
      row('Previous tab', 'cycle-tab', { delta: -1 }),
      { label: 'Go to tab 1 to 8', keys: `${accelFor('select-tab', { index: 0 }).slice(0, -1)}1–8` },
      row('Go to last tab', 'select-tab', { index: -1 })
    ] },
    { title: 'Going places', rows: [
      row('Address bar', 'focus-address'),
      row('Back', 'back'),
      row('Forward', 'forward'),
      row('Reload', 'reload'),
      row('Hard reload', 'reload-hard'),
      row('Bookmarks', 'open-bookmarks'),
      row('History', 'open-history'),
      row('Downloads', 'open-downloads')
    ] },
    { title: 'This page', rows: [
      row('Find', 'find-open'),
      row('Next match', 'find-next'),
      row('Previous match', 'find-prev'),
      row('Zoom in', 'zoom', { direction: 'in' }),
      row('Zoom out', 'zoom', { direction: 'out' }),
      row('Actual size', 'zoom', { direction: 'reset' }),
      row('Bookmark', 'bookmark-page'),
      row('Save', 'save-page'),
      row('Print', 'print'),
      row('View source', 'view-source')
    ] },
    { title: 'Browser', rows: [
      row('Settings', 'open-settings'),
      row('Bookmarks bar', 'toggle-bookmarks-bar'),
      row('Full screen', 'toggle-fullscreen'),
      row('Task manager', 'toggle-panel'),
      row('Developer tools', 'toggle-devtools'),
      row('New private window', 'new-incognito-window'),
      row('This list', 'show-shortcuts')
    ] }
  ];
  if (incognito) {
    groups.push({ title: 'Private window', rows: [
      row('New circuit for this tab', 'new-circuit'),
      row('New identity', 'new-identity'),
      row('Close and erase now', 'panic')
    ] });
  }
  for (const group of groups) group.rows = group.rows.filter((r) => r.keys);
  return groups;
}

module.exports = { match, accelFor, sheet, TABLE, IS_MAC };
