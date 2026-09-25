'use strict';

/**
 * Settings.
 *
 * Every control is generated from the descriptor list below. That is not
 * cleverness for its own sake: a preference otherwise has to be declared in
 * four places - the schema in prefs.js, the markup, a change handler, and the
 * code that writes the saved value back into the control on load - and the
 * fourth is the one that gets forgotten, producing a settings page that shows
 * defaults rather than what the user chose. Here there is one entry and the
 * render/apply path is shared.
 *
 * Nothing is saved locally. Every change goes to the browser process, which
 * validates it against the same schema that guards the file on disk, and comes
 * back as state - so a rejected value visibly snaps back instead of appearing
 * to have been accepted.
 */

const api = window.debrowser;

/** Set by watchSections: look again at which section is current. */
let remarkRail = () => {};

/** Why saved logins cannot be filled here, or '' - set by renderCredentials. */
let credentialsUnavailable = '';

/** A reason as a sentence: capital first, full stop last. */
function sentence(text) {
  const t = String(text).trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : '';
}

/**
 * Accent choices, and the reason none of them is bright.
 *
 * These were the six saturated primaries every colour picker offers - pure
 * blue, pure green, pure red - which is what made the browser look stock
 * whichever one you chose. Each of these is a real pigment name because each is
 * mixed like one: held around half the saturation, so the accent marks what is
 * selected without becoming the loudest thing on screen. Teal is first because
 * it is the default; the rest are what someone might actually want instead.
 */
const ACCENTS = [
  { value: '#2f857b', name: 'Petrol' },
  { value: '#6f8f5f', name: 'Moss' },
  { value: '#a8694a', name: 'Clay' },
  { value: '#b08a3c', name: 'Ochre' },
  { value: '#7b6a9c', name: 'Iris' },
  { value: '#5f7d9c', name: 'Slate' }
];

/** Tab strip colours. Muted on purpose: this is a large area, not an accent. */
const STRIP_COLORS = [
  { value: '#1b1f22', name: 'Graphite', css: '#1b1f22' },
  { value: '#1d1c22', name: 'Aubergine', css: '#1d1c22' },
  { value: '#171f1c', name: 'Pine',     css: '#171f1c' },
  { value: '#221c16', name: 'Umber',    css: '#221c16' },
  { value: '#231a1a', name: 'Oxblood',  css: '#231a1a' }
];

const SECTIONS = {
  appearance: [
    {
      key: 'theme',
      label: 'Theme',
      hint: 'System follows the machine.',
      type: 'select',
      options: [
        { value: 'system', name: 'System' },
        { value: 'light', name: 'Light' },
        { value: 'dark', name: 'Dark' }
      ]
    },
    { key: 'accent', label: 'Accent colour', type: 'accent' },
    {
      key: 'showBookmarksBar',
      label: 'Show the bookmarks bar',
      hint: 'A row of saved sites under the toolbar. Ctrl+Shift+B toggles it.',
      type: 'checkbox',
      unavailable: (state) => (state.prefs.tabBarPosition === 'left'
        ? 'Shown with tabs across the top. Down the side, bookmarks are under Ctrl+Shift+O.' : '')
    },
    {
      key: 'tabBarPosition',
      label: 'Tab bar position',
      hint: 'Across the top, as in most browsers; down the side, titles stay readable however many tabs are open.',
      type: 'select',
      options: [
        { value: 'top', name: 'Across the top' },
        { value: 'left', name: 'Down the left' }
      ]
    },
    {
      key: 'tabWidth',
      label: 'Tab width',
      hint: 'Compact fits more tabs before they start shrinking.',
      type: 'select',
      options: [
        { value: 'roomy', name: 'Roomy' },
        { value: 'compact', name: 'Compact' }
      ]
    },
    {
      key: 'tabBarColor',
      label: 'Tab strip colour',
      hint: 'Its own colour, or the second swatch to match your accent.',
      type: 'stripColor'
    },
    {
      key: 'windowOpacity',
      label: 'Tab bar translucency',
      hint: 'The strip alone, never pages. Needs a window material behind it.',
      unavailable: () => (api.platform === 'linux' ? 'Needs Windows or macOS: Linux has no window material to show through.' : ''),
      type: 'range',
      min: 0.4,
      max: 1,
      step: 0.02,
      format: (v) => `${Math.round(v * 100)}%`
    },
    {
      key: 'backgroundMaterial',
      label: 'Window material',
      hint: 'What shows through a translucent tab bar.',
      unavailable: () => (api.platform !== 'win32' ? 'Windows 11 only.' : ''),
      type: 'select',
      options: [
        { value: 'none', name: 'None' },
        { value: 'mica', name: 'Mica' },
        { value: 'acrylic', name: 'Acrylic' },
        { value: 'tabbed', name: 'Tabbed' }
      ]
    },
    {
      key: 'reduceMotion',
      label: 'Reduce motion',
      hint: 'Your system setting is honoured either way.',
      type: 'checkbox'
    },
    {
      key: 'showMemoryMeter',
      label: 'Show the memory meter',
      hint: 'The bar in the toolbar. Hiding it does not stop the governor.',
      type: 'checkbox'
    },
    {
      key: 'showTierDots',
      label: 'Show resource dots on tabs',
      hint: 'Whether a tab is active, idle, frozen or discarded.',
      type: 'checkbox'
    }
  ],

  browsing: [
    // First, because it is what someone looking for "why did my tabs vanish"
    // scans for, and it was once easy to miss below the search engine.
    {
      key: 'restoreSession',
      label: 'Continue where you left off',
      hint: 'Off opens a fresh tab each time you start. Restored tabs load when you visit them.',
      type: 'checkbox'
    },
    { key: 'searchEngine', label: 'Search engine', type: 'select', options: 'engines' },
    {
      key: 'inlineAutocomplete',
      label: 'Complete addresses as I type',
      hint: 'Fills in the rest of a site you have visited. Keep typing to replace it.',
      type: 'checkbox'
    },
    {
      key: 'bookmarkOpensIn',
      label: 'Clicking a bookmark',
      hint: 'Ctrl-click and the middle button always open a new tab.',
      type: 'select',
      options: [
        { value: 'new-tab', name: 'Opens a new tab' },
        { value: 'current-tab', name: 'Replaces the current tab' }
      ]
    },
    {
      key: 'homepage',
      label: 'New tab page',
      hint: 'Leave empty for the built-in page.',
      type: 'text',
      placeholder: 'https://'
    },
    {
      key: 'defaultZoom',
      label: 'Page zoom',
      hint: 'For every site you haven’t zoomed yourself. Resetting a site’s zoom brings it back to this.',
      type: 'select',
      numeric: true,
      options: [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
        .map((f) => ({ value: String(f), name: `${Math.round(f * 100)}%` }))
    },
    {
      key: 'clearHistoryOnExit',
      label: 'Clear history when I close the browser',
      hint: 'The list is emptied as the browser closes. Bookmarks and passwords stay.',
      type: 'checkbox'
    }
  ],

  tabs: [
    {
      key: 'newTabPosition',
      label: 'Tabs opened from links',
      hint: 'Beside the page they came from keeps related tabs together.',
      type: 'select',
      options: [
        { value: 'end', name: 'Go at the end' },
        { value: 'after-current', name: 'Go next to the current tab' }
      ]
    },
    {
      key: 'linkTabsInBackground',
      label: 'Open links in the background',
      hint: 'Off switches to a tab as soon as a link opens it.',
      type: 'checkbox'
    },
    {
      key: 'lastTabCloses',
      label: 'Closing the last tab',
      type: 'select',
      options: [
        { value: 'quit', name: 'Closes the window' },
        { value: 'new-tab', name: 'Leaves a new tab open' }
      ]
    },
    {
      key: 'confirmCloseTabs',
      label: 'Ask before closing a window with several tabs',
      type: 'checkbox'
    },
    {
      key: 'tabCloseButton',
      label: 'Close buttons on tabs',
      type: 'select',
      options: [
        { value: 'hover', name: 'On hover and the current tab' },
        { value: 'always', name: 'Always' }
      ]
    },
    {
      key: 'hoverPrefetch',
      label: 'Preload tabs when I hover them',
      hint: 'A head start on switching. Off saves the memory a hovered tab would wake.',
      type: 'checkbox'
    },
    {
      key: 'rememberWindowBounds',
      label: 'Remember the window size and position',
      hint: 'Takes effect the next time the browser starts.',
      type: 'checkbox'
    }
  ],

  resources: [
    {
      key: 'memoryBudgetMB',
      label: 'Memory budget',
      hint: 'What the browser may hold before it reclaims. Empty sizes it to this machine.',
      type: 'number',
      placeholder: 'Automatic',
      min: 256,
      max: 65536,
      unit: 'MB'
    },
    {
      key: 'maxLiveTabs',
      label: 'Tabs holding a renderer',
      hint: 'Tabs past this stay open but give their renderer back. 0 removes the limit.',
      type: 'number',
      placeholder: 'Automatic',
      min: 0,
      max: 200
    }
  ],

  downloads: [
    {
      key: 'downloadConnections',
      label: 'Connections per download',
      hint: 'Byte ranges fetched at once. Servers that refuse them are downloaded whole.',
      type: 'number',
      min: 1,
      max: 16
    },
    {
      key: 'askWhereToSave',
      label: 'Ask where to save each file',
      type: 'checkbox'
    },
    {
      key: 'downloadDir',
      label: 'Save files to',
      hint: 'A full folder path. Empty, or a folder that is missing, uses your Downloads folder.',
      type: 'text',
      placeholder: 'Your Downloads folder'
    }
  ],

  private: [
    {
      key: 'incognitoBridges',
      label: 'Connect to Tor',
      hint: 'Bridges hide from your ISP that you use Tor. A bridge of your own also hides it from lists of known bridges.',
      type: 'select',
      options: [
        { value: 'auto', name: 'Through built-in bridges' },
        { value: 'custom', name: 'Through my own bridges' },
        { value: 'none', name: 'Directly – fastest, and your ISP can see Tor' }
      ]
    },
    {
      key: 'incognitoBridgeLines',
      label: 'My bridges',
      hint: 'One per line, as your bridge gives them (obfs4, webtunnel or snowflake). The bridge kit that comes with Debrowser can set one up for you.',
      type: 'textarea',
      placeholder: 'obfs4 203.0.113.5:443 FINGERPRINT cert=… iat-mode=0'
    },
    {
      key: 'incognitoJsLevel',
      label: 'JavaScript security',
      // The costs are measured, by bench/js-levels: everyday page work (DOM,
      // JSON) runs the same at every level; heavy number-crunching and
      // WebAssembly are where the optimising compilers earn their keep.
      hint: 'Balanced turns off the optimising compilers, where most attacks on the engine land: everyday pages run as fast, heavy computation about half as fast. Maximum runs the interpreter alone. Applies to new private windows.',
      type: 'select',
      options: [
        { value: 'balanced', name: 'Balanced – heavy scripts ~2× slower' },
        { value: 'maximum', name: 'Maximum – no WebAssembly, text search ~4× slower' },
        { value: 'full', name: 'Full speed' }
      ]
    },
    {
      key: 'incognitoKeepTorState',
      label: 'Remember Tor between sessions',
      hint: 'Keeps the same entry guard, as Tor is designed to, and connects in seconds – sealed with your system keystore. Off leaves no trace of Tor here, but picks a new guard every time.',
      type: 'checkbox'
    },
    {
      key: 'incognitoPreferOnion',
      label: 'Use onion addresses when sites offer them',
      type: 'checkbox'
    },
    {
      key: 'incognitoCamouflage',
      label: 'Traffic camouflage',
      hint: 'Loads a decoy page from a built-in list of popular sites beside each real one, on another circuit, so timing and size tell an observer less. About twice the data; the decoy sites see visits you did not make. Applies to new private windows.',
      type: 'checkbox'
    },
    {
      key: 'incognitoKeepWarm',
      label: 'Keep a private window ready',
      hint: 'Connects to Tor in the background when Debrowser starts, so Ctrl+Shift+N opens at once. Costs about 300 MB of memory while it waits, and your network sees a Tor connection whenever Debrowser is open.',
      type: 'checkbox'
    },
    {
      key: 'incognitoIdleWipeMinutes',
      label: 'Close private windows when idle',
      hint: 'Minutes with no input anywhere on this computer. Then everything in them is erased at once, as Ctrl+Shift+Delete does. 0 never closes them.',
      type: 'number',
      min: 0,
      max: 240,
      unit: 'min'
    }
  ],

  credentials: [
    {
      key: 'requirePresence',
      label: 'Confirm it’s you first',
      hint: 'Before a saved password or card is shown or filled.',
      type: 'checkbox'
    },
    {
      key: 'fillPasswords',
      label: 'Fill saved passwords automatically',
      hint: 'Passwords only, and only when one saved sign-in matches the site.',
      unavailable: () => credentialsUnavailable,
      type: 'checkbox'
    }
  ],

  advanced: [
    {
      key: 'showMemoryDetail',
      label: 'Explain the memory figures',
      hint: 'Adds notes to the task manager about what each number counts.',
      type: 'checkbox'
    },
    {
      key: 'hardwareAcceleration',
      label: 'Use hardware acceleration',
      hint: 'Try this if pages flicker or the browser will not start. Needs a restart.',
      type: 'checkbox'
    },
    {
      key: 'devToolsDock',
      label: 'Developer tools open',
      hint: 'Beside the page, under it, or in a window of their own.',
      type: 'select',
      options: [
        { value: 'right', name: 'Beside the page' },
        { value: 'bottom', name: 'Under the page' },
        { value: 'window', name: 'In their own window' }
      ]
    }
  ],

  updates: [
    {
      key: 'autoUpdate',
      label: 'Install updates automatically',
      hint: 'Checks on launch and when you open this section. Downloads only what changed.',
      unavailable: (state) => (state.updates && state.updates.available === false
        ? sentence(state.updates.reason || 'Updates are not available for this copy.') : ''),
      type: 'checkbox'
    }
  ]
};

/**
 * How often a slider being dragged may write its value through.
 *
 * Fast enough that the browser appears to follow the thumb, slow enough that a
 * drag across the range is a handful of writes rather than one per pixel.
 */
const LIVE_SET_MS = 120;

/** Built controls, keyed by preference, so state only ever writes values. */
const controls = new Map();
let engines = [];
let built = false;

/* ------------------------------------------------------------------ */
/* Building                                                            */
/* ------------------------------------------------------------------ */

function buildAll() {
  for (const [sectionId, rows] of Object.entries(SECTIONS)) {
    // By attribute, not id. An id named like the section is what a
    // `settings#browsing` link scrolls to by itself, and it landed on these
    // rows with the section's heading above the top of the page.
    const host = document.querySelector(`[data-rows="${sectionId}"]`);
    for (const row of rows) host.append(buildRow(row));
  }
  built = true;
}

/**
 * Scroll to the section the address asked for, and say which one it was.
 *
 * `debrowser://settings#downloads` from the menu lands here. Done once, after
 * the page is built - the controls are generated, so before that there is
 * nothing to scroll to - and the brief highlight matters as much as the scroll:
 * a page that jumps to the middle of itself with no explanation reads as a page
 * that failed to load its top half.
 */
function revealSection() {
  const wanted = decodeURIComponent(location.hash.slice(1));
  if (!wanted) return;
  const section = document.querySelector(`section[data-section="${CSS.escape(wanted)}"]`);
  if (!section) return;
  section.scrollIntoView({ block: 'start', behavior: 'auto' });
  section.classList.add('landed');
  // Removed rather than left on the element: it is an arrival, not a state, and
  // a highlight that never goes away is just a differently coloured section.
  setTimeout(() => section.classList.remove('landed'), 1400);
}

function buildRow(spec) {
  const row = document.createElement('div');
  row.className = 'row';

  const text = document.createElement('div');
  text.className = 'row-text';

  const label = document.createElement('label');
  label.className = 'row-label';
  label.textContent = spec.label;
  text.append(label);

  let hint = null;
  if (spec.hint || spec.unavailable) {
    hint = document.createElement('span');
    hint.className = 'row-hint';
    hint.textContent = spec.hint || '';
    text.append(hint);
  }

  const holder = document.createElement('div');
  holder.className = 'row-control';
  const control = buildControl(spec);
  holder.append(control.node);
  if (control.input) {
    control.input.id = `pref-${spec.key}`;
    label.htmlFor = control.input.id;
  }

  row.append(text, holder);
  Object.assign(control, { spec, row, hint });
  controls.set(spec.key, control);
  return row;
}

function buildControl(spec) {
  switch (spec.type) {
    case 'select': {
      const select = document.createElement('select');
      // `numeric` for a choice of numbers: an option's value is always a string.
      select.addEventListener('change', () =>
        save(spec.key, spec.numeric ? Number(select.value) : select.value));
      return {
        node: select,
        input: select,
        // Options are filled on write, because the engine list arrives with
        // state rather than being known at build time.
        write(value) {
          const options = spec.options === 'engines'
            ? engines.map((e) => ({ value: e.id, name: e.name }))
            : spec.options;
          if (select.childElementCount !== options.length) {
            select.replaceChildren(...options.map((o) => {
              const node = document.createElement('option');
              node.value = o.value;
              node.textContent = o.name;
              return node;
            }));
          }
          if (select.value !== String(value)) select.value = String(value);
        }
      };
    }

    case 'checkbox': {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => save(spec.key, box.checked));
      return {
        node: box,
        input: box,
        write(value) { if (box.checked !== value) box.checked = Boolean(value); }
      };
    }

    case 'text': {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = spec.placeholder || '';
      input.addEventListener('change', () => save(spec.key, input.value.trim()));
      return {
        node: input,
        input,
        write(value) { if (document.activeElement !== input) input.value = value || ''; }
      };
    }

    case 'textarea': {
      const input = document.createElement('textarea');
      input.rows = 3;
      input.spellcheck = false;
      input.placeholder = spec.placeholder || '';
      input.addEventListener('change', () => save(spec.key, input.value.trim()));
      return {
        node: input,
        input,
        write(value) { if (document.activeElement !== input) input.value = value || ''; }
      };
    }

    case 'number': {
      const input = document.createElement('input');
      input.type = 'number';
      input.placeholder = spec.placeholder || '';
      if (spec.min != null) input.min = String(spec.min);
      if (spec.max != null) input.max = String(spec.max);
      input.addEventListener('change', () => {
        // An empty field is not zero. It means "no preference" - let the browser
        // size this to the machine - and zero is a meaningful value for the tab
        // cap, so the two must not collapse into each other.
        const raw = input.value.trim();
        save(spec.key, raw === '' ? null : Number(raw));
      });

      if (!spec.unit) return { node: input, input, write: writeNumber };

      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = spec.unit;
      const wrap = document.createDocumentFragment();
      wrap.append(input, unit);
      return { node: wrap, input, write: writeNumber };

      function writeNumber(value) {
        if (document.activeElement === input) return;
        const next = value == null ? '' : String(value);
        if (input.value !== next) input.value = next;
      }
    }

    case 'range': {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      const out = document.createElement('span');
      out.className = 'unit';

      const show = (v) => { out.textContent = spec.format ? spec.format(v) : String(v); };

      /*
       * The thing being set changes as the slider moves, not when it is let go.
       *
       * Translucency is the reason this matters: it is a setting you judge by
       * looking at it, and a slider that shows a number while the browser stays
       * as it was until you release is one you have to guess with. So the value
       * is sent while dragging.
       *
       * Rate-limited rather than sent per event, because every send is a write
       * to disk and a relayout: a drag across the range fires forty of them, and
       * forty atomic file writes for one decision is exactly the kind of waste
       * this browser is about. The trailing `change` is what stores the value
       * the user actually stopped on, whichever side of the window it lands.
       */
      let sentAt = 0;
      let pending = null;
      const push = () => {
        pending = null;
        sentAt = Date.now();
        save(spec.key, Number(input.value));
      };

      input.addEventListener('input', () => {
        show(Number(input.value));
        if (pending) return;
        const wait = Math.max(0, LIVE_SET_MS - (Date.now() - sentAt));
        pending = setTimeout(push, wait);
      });
      input.addEventListener('change', () => {
        if (pending) { clearTimeout(pending); pending = null; }
        push();
      });

      const wrap = document.createDocumentFragment();
      wrap.append(input, out);
      return {
        node: wrap,
        input,
        write(value) {
          const v = Number(value);
          // Neither the thumb nor its label while it is being dragged: the
          // broadcast carries the last *saved* value, and the label jumped
          // back to it on every tick.
          if (document.activeElement === input) return;
          input.value = String(v);
          show(v);
        }
      };
    }

    case 'stripColor': {
      const wrap = document.createElement('div');
      wrap.className = 'swatches';

      const choices = [
        { value: 'default', name: 'Default', css: 'var(--bg)' },
        { value: 'mirror', name: 'Match the accent colour', css: 'var(--accent)' },
        ...STRIP_COLORS
      ];
      const buttons = choices.map(({ value, name, css }) => {
        const button = document.createElement('button');
        button.className = 'swatch';
        button.style.background = css;
        button.title = name;
        button.setAttribute('aria-label', name);
        button.setAttribute('aria-pressed', 'false');
        if (value === 'mirror') button.classList.add('mirror');
        button.addEventListener('click', () => save(spec.key, value));
        wrap.append(button);
        return { button, value };
      });
      return {
        node: wrap,
        input: null,
        write(value) {
          for (const { button, value: own } of buttons) {
            button.setAttribute('aria-pressed', String(own === value));
          }
        }
      };
    }

    case 'accent': {
      const wrap = document.createElement('div');
      wrap.className = 'swatches';
      const buttons = ACCENTS.map(({ value, name }) => {
        const button = document.createElement('button');
        button.className = 'swatch';
        button.style.background = value;
        button.title = name;
        button.setAttribute('aria-label', name);
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => save(spec.key, value));
        wrap.append(button);
        return { button, value };
      });
      return {
        node: wrap,
        input: null,
        write(value) {
          for (const { button, value: own } of buttons) {
            button.setAttribute('aria-pressed', String(own === value));
          }
        }
      };
    }

    default:
      throw new Error(`unknown control type "${spec.type}"`);
  }
}

/* ------------------------------------------------------------------ */

function save(key, value) {
  api.send('set-pref', { key, value });
}

// Settings is a tab, so closing it closes the tab - the same thing the × on the
// tab strip does. There is no separate "close settings" concept any more, which
// is the point: the overlay that had one is what trapped the browser on it.
document.getElementById('close').addEventListener('click', () => api.send('close-tab'));
// What each field held when it was focused, so Escape can put it back.
const valueOnFocus = new WeakMap();
document.addEventListener('focusin', (event) => {
  if (event.target.matches?.('input, select, textarea')) valueOnFocus.set(event.target, event.target.value);
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  // Not from inside a field someone is filling in - the bookmark editor, the
  // homepage, a number. Escape there means "never mind this edit": the value
  // goes back to what it was before the blur, so the blur's `change` has
  // nothing to save. Closing the whole page threw away what was typed. The
  // search box has its own Escape, and is the exception.
  const t = event.target;
  if (t && t.id !== 'q' && t.matches && t.matches('input, select, textarea')) {
    if (valueOnFocus.has(t)) t.value = valueOnFocus.get(t);
    t.blur();
    return;
  }
  api.send('close-tab');
});

/**
 * The line under the update switch, and the button beside it.
 *
 * `unchecked` is its own case rather than falling through to "Up to date."
 * The first check is a minute after launch, so the old fallback spent that
 * minute asserting a version comparison the browser had not made yet - and it
 * would have gone on asserting it forever with automatic updates switched off.
 */
function renderUpdateState(u) {
  const el = document.getElementById('update-state');
  const button = document.getElementById('check-updates');
  if (!el) return;

  if (!u) {
    el.textContent = '';
    if (button) button.hidden = true;
    return;
  }

  if (!u.available) {
    el.textContent = `Updates are unavailable here: ${u.reason}.`;
    if (button) button.hidden = true;
    return;
  }

  switch (u.state) {
    case 'checking':    el.textContent = 'Checking for a new version…'; break;
    case 'available':   el.textContent =
      `${u.version} is available. Turn on automatic updates to download it.`; break;
    case 'downloading': el.textContent = `Downloading ${u.version} – ${u.progress}%.`; break;
    case 'ready':       el.textContent = `${u.version} is downloaded and installs when you restart.`; break;
    case 'error':       el.textContent = `Last check failed: ${u.error}`; break;
    case 'idle':        el.textContent = 'Up to date.'; break;
    default:            el.textContent = 'Not checked yet.';
  }

  if (button) {
    button.hidden = false;
    // Nothing to ask while an answer is already on its way, or while an update
    // is sitting downloaded waiting for a restart.
    button.disabled = u.state === 'checking' || u.state === 'downloading' || u.state === 'ready';
  }
}

document.getElementById('check-updates')?.addEventListener('click', async () => {
  renderUpdateState(await api.request('check-for-updates'));
});

/*
 * Looking at the Updates section is asking the question.
 *
 * The browser used to check every six hours for the life of a window, which is
 * it reaching out to GitHub on a schedule nobody asked for. It checks on launch,
 * when you press the button, and here - because scrolling to a section headed
 * "Updates" to read whether you have one is the same request as pressing it.
 *
 * The browser rate-limits this, so scrolling past twice is one check; see
 * MIN_AUTO_INTERVAL_MS in updater.js. The observer is disconnected after the
 * first sighting anyway, since a section that has been seen once has been asked
 * about once. It is sent as `auto`, so it is held to the automatic-updates
 * switch too: with that off, looking is not asking - only the button is.
 */
{
  const section = document.querySelector('section[data-section="updates"]');
  if (section && typeof IntersectionObserver === 'function') {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      api.request('check-for-updates', { auto: true }).then(renderUpdateState);
    }, { threshold: 0.4 });
    seen.observe(section);
  }
}

/* ------------------------------------------------------------------ */
/* Saved sign-ins and payment details                                  */
/* ------------------------------------------------------------------ */

/**
 * Drawn from an explicit request, never from the state broadcast.
 *
 * That broadcast reaches three views on every governor tick, and a list of
 * someone's accounts has no business being pushed into a renderer twice a
 * second on the chance this page is open. Secrets are not in the list at all:
 * a row needs a site and a username, and revealing is a separate deliberate
 * call that fetches one record.
 */
/**
 * Turn the presence control off where nothing can satisfy it.
 *
 * A checkbox that locks the user out of their own passwords is worse than no
 * checkbox, so it is disabled with the reason attached where the machine has no
 * Hello or Touch ID - and labelled experimental where it has one this has never
 * been able to test against.
 */
async function renderPresence() {
  const control = controls.get('requirePresence');
  if (!control || !control.input) return;
  const cap = await api.request('presence-capability');
  const row = control.input.closest('.row');
  const hint = row ? row.querySelector('.row-hint') : null;
  if (!cap) return;

  if (!cap.available) {
    control.input.disabled = true;
    // Turned off for real, not just unticked.
    //
    // Unticking alone left the saved preference true, so the next state
    // broadcast re-ticked it from prefs - and a profile carrying
    // `requirePresence: true` onto a machine with no Hello or Touch ID locked
    // the user out of their own saved passwords with no control left enabled to
    // clear it. Writing it back is the only way out that does not require
    // editing the file by hand.
    if (control.input.checked) {
      control.input.checked = false;
      api.send('set-pref', { key: 'requirePresence', value: false });
    }
    if (hint) {
      hint.textContent = `Not available: ${cap.reason}. Turned off, so your saved ` +
        'passwords stay reachable.';
    }
    return;
  }
  control.input.disabled = false;
  if (hint && cap.experimental) {
    hint.textContent = `Uses ${cap.mechanism}. This has never been run against real ` +
      'hardware, so try it before relying on it – if the prompt does not appear, the ' +
      'check refuses rather than letting the secret through.';
  } else if (hint) {
    hint.textContent = `Uses ${cap.mechanism}, before a saved password or card is shown or filled.`;
  }
}

async function renderCredentials() {
  const host = document.getElementById('credential-list');
  const state = document.getElementById('credential-state');
  if (!host) return;

  const data = await api.request('list-credentials');
  if (!data) return;

  credentialsUnavailable = data.available ? '' : 'Needs saving to be available – see above.';
  if (!data.available) {
    state.textContent = `Saving is unavailable: ${data.reason}. Nothing is written to disk ` +
                        'unless it can be encrypted by the operating system.';
    host.replaceChildren();
    return;
  }

  const count = data.logins.length + data.payments.length;
  state.textContent = count
    ? 'Encrypted with a key held by your operating system. Nothing leaves this machine.'
    : 'Nothing saved yet. Sign in to a site and the browser will offer to remember it.';

  const rows = [];
  for (const item of data.logins) rows.push(credentialRow('login', item.id, item.origin, item.username));
  for (const item of data.payments) {
    rows.push(credentialRow('payment', item.id, item.label, `•••• ${item.last4} · ${item.expiry}`));
  }
  host.replaceChildren(...rows);
  reapplyFilter();
}

function credentialRow(kind, id, title, subtitle) {
  const row = document.createElement('div');
  row.className = 'row';

  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = title;
  const hint = document.createElement('span');
  hint.className = 'row-hint';
  hint.textContent = subtitle || '(no username)';
  text.append(label, hint);

  const control = document.createElement('div');
  control.className = 'row-control';

  const reveal = document.createElement('button');
  reveal.className = 'ghost-btn';
  reveal.textContent = 'Show';
  reveal.addEventListener('click', async () => {
    if (reveal.dataset.shown === 'yes') {
      hint.textContent = subtitle || '(no username)';
      reveal.textContent = 'Show';
      reveal.dataset.shown = 'no';
      return;
    }
    const secret = await api.request('reveal-credential', { kind, id });
    if (!secret) return;
    // A refused presence check answers `{ denied: true }`, which is an object
    // and therefore truthy - so it sailed past the guard above and rendered the
    // literal word "undefined" where the password goes, with the button flipped
    // to Hide. A refusal has to look like a refusal.
    if (secret.denied) {
      hint.textContent = 'Not shown – the identity check was not completed.';
      return;
    }
    hint.textContent = kind === 'login' ? secret.password : secret.number;
    reveal.textContent = 'Hide';
    reveal.dataset.shown = 'yes';
  });

  const remove = document.createElement('button');
  remove.className = 'ghost-btn danger';
  remove.textContent = 'Delete';
  remove.addEventListener('click', async () => {
    await api.request('delete-credential', { kind, id });
    renderCredentials();
  });

  control.append(reveal, remove);
  if (kind === 'payment') {
    const fill = document.createElement('button');
    fill.className = 'ghost-btn';
    fill.textContent = 'Fill';
    fill.title = 'Put these details into the page in the tab behind this one';
    fill.addEventListener('click', () => api.request('fill-payment', { id }));
    control.prepend(fill);
  }

  row.append(text, control);
  return row;
}

/** The bookmarks revision the list was last drawn at. */
let bookmarksShown = null;

api.onState((state) => {
  applyThemePrefs(state.prefs);
  renderUpdateState(state.updates);
  if (!state.prefs) return;
  if (Array.isArray(state.searchEngines)) engines = state.searchEngines;
  if (!built) {
    buildAll(); renderCredentials(); renderBookmarks(); renderPresence();
    buildRail();
    revealSection();
  }
  renderDownloads();
  // A bookmark saved elsewhere - the star, Ctrl+D - shows here while Settings
  // is open, not after a reload. Held while someone is typing in the section,
  // which the redraw would throw away.
  if (built && state.bookmarksRevision !== bookmarksShown) {
    const typing = document.activeElement &&
      document.activeElement.closest('#bookmark-list, #bookmark-actions');
    if (!typing) {
      if (bookmarksShown !== null) renderBookmarks();
      bookmarksShown = state.bookmarksRevision;
    }
  }
  for (const [key, control] of controls) {
    control.write(state.prefs[key]);
    if (control.spec?.unavailable) markUnavailable(control, control.spec.unavailable(state));
  }
});

/**
 * A setting that cannot do anything here - on this platform, in this layout -
 * is shown switched off and says why, instead of accepting a change that goes
 * nowhere.
 */
function markUnavailable(control, why) {
  const off = Boolean(why);
  if (control.input && control.input.disabled !== off) control.input.disabled = off;
  control.row.classList.toggle('unavailable', off);
  if (control.hint) {
    const text = off ? why : (control.spec.hint || '');
    if (control.hint.textContent !== text) control.hint.textContent = text;
  }
}

/* ------------------------------------------------------------------ */
/* The rail, and search                                                */
/* ------------------------------------------------------------------ */

/**
 * A list of the sections, built from the sections.
 *
 * Deliberately not a second list of names: the page is eight sections long now,
 * and a hand-written rail is a list that goes out of step with the page the
 * first time someone adds a heading. Each button takes its label from the
 * section's own <h2>.
 */
const railButtons = new Map();

/**
 * The sections, collected once.
 *
 * Three pieces of code wanted this list - the rail, the scroll-spy and the
 * filter - and each re-queried for it, which is three copies of one selector to
 * keep in step. Sections are static markup; they do not appear or disappear.
 */
let sections = [];

function buildRail() {
  const rail = document.getElementById('rail');
  if (!rail) return;

  sections = [...document.querySelectorAll('section[data-section]')];

  for (const section of sections) {
    const name = section.dataset.section;
    const heading = section.querySelector('h2');
    const button = document.createElement('button');
    button.className = 'rail-item';
    button.type = 'button';
    button.textContent = heading ? heading.textContent : name;
    button.addEventListener('click', () => {
      section.scrollIntoView({ block: 'start', behavior: 'smooth' });
      // Marked immediately rather than waiting for the observer: a smooth
      // scroll takes a few hundred milliseconds, and a rail that lights up
      // after the page has finished moving feels like it did not register the
      // click.
      markRail(name);
    });
    rail.append(button);
    railButtons.set(name, button);
  }

  watchSections();
}

function markRail(name) {
  for (const [key, button] of railButtons) {
    button.classList.toggle('current', key === name);
  }
}

/**
 * Which section the reader is in.
 *
 * The topmost section still intersecting the viewport wins, which is what makes
 * the mark move *as* you scroll rather than jumping when a section's midpoint
 * crosses some line. An observer rather than a scroll handler: this fires only
 * when a boundary is crossed, where a scroll listener would run on every frame
 * of every scroll for the life of the page.
 *
 * Whether a section is on screen is recorded on the section, so the callback
 * does not keep a second collection in step with the first.
 */
function watchSections() {
  const main = document.querySelector('main');
  if (!main) return;

  /*
   * The section being read is the last one whose heading has passed a line a
   * quarter of the way down the page - or, at the very end of the page, the
   * last one showing, since short final sections never reach that line.
   *
   * This replaced a rule of "the topmost section still in the top 45%", which
   * lagged: a long section kept the mark while the next section's heading was
   * already well up the screen.
   */
  let queued = false;
  const mark = () => {
    queued = false;
    const box = main.getBoundingClientRect();
    const shown = sections.filter((s) => !s.hidden);
    if (!shown.length) return;
    const atEnd = main.scrollTop + main.clientHeight >= main.scrollHeight - 2;
    let current = shown[0];
    if (atEnd) {
      current = shown.filter((s) => s.getBoundingClientRect().top < box.bottom).pop() || current;
    } else {
      const line = box.top + box.height * 0.25;
      for (const section of shown) if (section.getBoundingClientRect().top <= line) current = section;
    }
    markRail(current.dataset.section);
  };
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(mark);
  };
  main.addEventListener('scroll', soon, { passive: true });
  window.addEventListener('resize', soon);
  remarkRail = soon;
  soon();
}

/**
 * Filter the rows to the ones that match what was typed.
 *
 * Over the rows that are already on the page rather than over a list of
 * settings kept for the purpose: there is one list of settings in this file,
 * and a second one written for search is a second one to forget to update. A
 * row's whole text is matched - label and hint both - because people search for
 * what a setting does at least as often as for what it is called.
 *
 * The text is taken once, when a row is filtered for the first time, and kept
 * on the row. `textContent` walks the row's whole subtree and allocates a
 * string, and this page can hold five hundred bookmark rows.
 */
function filterSettings(query) {
  requestAnimationFrame(() => remarkRail());
  const needle = query.trim().toLowerCase();
  let shown = 0;

  for (const section of sections) {
    let any = false;
    for (const row of section.querySelectorAll('.row')) {
      if (row.dataset.find === undefined) row.dataset.find = row.textContent.toLowerCase();
      const hit = !needle || row.dataset.find.includes(needle);
      // Written only on a change: `hidden` is an attribute, and setting it
      // invalidates style for the row whether or not the value moved.
      if (row.hidden === hit) row.hidden = !hit;
      if (hit) { any = true; shown += 1; }
    }
    // A section whose rows have all gone takes its heading and its notes with
    // it. A page of empty headings is a worse answer than a short list.
    const gone = Boolean(needle) && !any;
    if (section.hidden !== gone) section.hidden = gone;
    const button = railButtons.get(section.dataset.section);
    if (button && button.hidden !== gone) button.hidden = gone;
  }

  const note = document.getElementById('no-match');
  note.hidden = !needle || shown > 0;
  note.textContent = shown ? '' : `No setting matches “${query.trim()}”.`;
}

/**
 * Re-run the current filter over rows that have just been rebuilt.
 *
 * Called by the three lists that rebuild themselves, not by the state
 * broadcast: that arrives twice a second for the life of the tab, and nothing
 * else in it touches a row.
 */
function reapplyFilter() {
  const search = document.getElementById('q');
  if (search && search.value.trim()) filterSettings(search.value);
}

{
  const search = document.getElementById('q');
  if (search) {
    search.addEventListener('input', () => filterSettings(search.value));
    // Escape clears the field first; the page's own Escape closes it only
    // when there is nothing to clear. See `clearOnEscape` in theme.js.
    clearOnEscape(search);
  }
}

/* ------------------------------------------------------------------ */
/* Bookmarks                                                           */
/* ------------------------------------------------------------------ */

/**
 * The bookmark list and the import controls.
 *
 * Importing is deliberately two offers rather than one. "Import from a browser
 * on this machine" is the path that needs no work from the user, and it is
 * tried first; "open an exported file" is the one that always works, including
 * for browsers whose bookmarks live in a database we will not read while it is
 * locked. Offering only the first would strand Firefox, Zen and every fork of
 * them; offering only the second would make the easy case needlessly manual.
 */
/**
 * The downloads list.
 *
 * Re-rendered from the browser's state rather than kept here, because progress
 * arrives on the state broadcast and a copy in this page would be a second
 * thing to keep in step with it.
 */
/*
 * Keyed rows, updated in place.
 *
 * This runs on every state broadcast, and it used to rebuild the list each
 * time - so a Cancel pressed across a tick was lost with the button it was
 * pressed on, and keyboard focus fell off the list twice a second. A sequence
 * number drops answers that arrive after a newer one.
 */
const downloadRows = new Map();
let downloadsAsked = 0;

async function renderDownloads() {
  const host = document.getElementById('download-list');
  if (!host) return;
  const asked = ++downloadsAsked;
  const res = await api.request('list-downloads');
  if (asked !== downloadsAsked) return;
  const items = (res && res.items) || [];

  const live = new Set(items.map((item) => item.id));
  for (const [id, node] of downloadRows) {
    if (!live.has(id)) { node.row.remove(); downloadRows.delete(id); }
  }
  items.forEach((item, index) => {
    let node = downloadRows.get(item.id);
    if (!node) { node = downloadRow(item.id); downloadRows.set(item.id, node); }
    updateDownloadRow(node, item);
    if (host.children[index] !== node.row) host.insertBefore(node.row, host.children[index] || null);
  });
  // A new row has never been filtered, and this list redraws itself while a
  // search is on screen.
  reapplyFilter();
}

function downloadRow(id) {
  const row = document.createElement('div');
  row.className = 'row';

  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  const hint = document.createElement('span');
  hint.className = 'row-hint';
  text.append(label, hint);

  const control = document.createElement('div');
  control.className = 'row-control';
  const button = document.createElement('button');
  const node = { row, label, hint, button, running: null };
  button.addEventListener('click', async () => {
    await api.request(node.running ? 'cancel-download' : 'clear-download', { id });
    renderDownloads();
  });
  control.append(button);

  row.append(text, control);
  return node;
}

function updateDownloadRow(node, item) {
  const running = item.state === 'running' || item.state === 'starting';
  // Written only on a change: this runs for every row on every broadcast.
  const label = item.filename || item.url;
  const hint = describeDownload(item);
  if (node.label.textContent !== label) node.label.textContent = label;
  if (node.hint.textContent !== hint) node.hint.textContent = hint;
  if (node.running !== running) {
    node.running = running;
    node.button.className = running ? 'ghost-btn danger' : 'ghost-btn';
    node.button.textContent = running ? 'Cancel' : 'Clear';
  }
}

async function renderBookmarks() {
  const host = document.getElementById('bookmark-list');
  const actions = document.getElementById('bookmark-actions');
  const state = document.getElementById('bookmark-state');
  if (!host || !actions) return;

  actions.replaceChildren(
    // First, because adding one by hand is the thing a bookmarks page is for.
    // Importing is a once-a-year operation and sat above it until now.
    bookmarkForm(),
    bookmarkAction(
      'Import from a browser on this machine',
      'Looks for Chrome, Edge, Brave, Vivaldi, Arc, Firefox, Zen and their relatives.',
      'Find browsers',
      async (button) => {
        button.disabled = true;
        const res = await api.request('bookmark-profiles');
        button.disabled = false;
        const profiles = (res && res.profiles) || [];
        if (!profiles.length) {
          state.textContent = 'No other browsers found on this computer. ' +
            'Export a bookmarks file from the browser you use and choose it below.';
          return;
        }
        renderProfiles(profiles, state, host);
      }),
    bookmarkAction(
      'Import an exported file',
      'The bookmarks HTML that every browser exports, or a Chromium Bookmarks file.',
      'Choose file…',
      async (button) => {
        button.disabled = true;
        const res = await api.request('import-bookmark-file');
        button.disabled = false;
        if (!res || res.cancelled) return;
        state.textContent = res.ok
          ? `Imported ${res.added} from ${res.browser}${res.skipped ? `, skipped ${res.skipped} already saved or unsupported` : ''}.`
          : `Could not import: ${res.reason}`;
        renderBookmarks();
      })
  );

  const res = await api.request('list-bookmarks');
  const items = (res && res.items) || [];

  if (!items.length) {
    host.replaceChildren();
    if (!state.textContent) {
      state.textContent = 'Nothing saved yet. The star in the toolbar saves the page you are on.';
    }
    return;
  }

  host.replaceChildren(...items.slice(0, 500).map(bookmarkRow));
  if (items.length > 500) {
    const more = document.createElement('div');
    more.className = 'row';
    more.textContent = `…and ${items.length - 500} more, saved but not listed here.`;
    host.appendChild(more);
  }
  reapplyFilter();
}

function bookmarkAction(title, hint, buttonText, onClick) {
  const row = document.createElement('div');
  row.className = 'row';
  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = title;
  const sub = document.createElement('span');
  sub.className = 'row-hint';
  sub.textContent = hint;
  text.append(label, sub);

  const control = document.createElement('div');
  control.className = 'row-control';
  const button = document.createElement('button');
  button.className = 'ghost-btn';
  button.textContent = buttonText;
  button.addEventListener('click', () => onClick(button));
  control.append(button);

  row.append(text, control);
  return row;
}

/**
 * One row per profile found, each with its own button.
 *
 * A Firefox-family profile gets a button too, and it explains rather than
 * imports - saying "Zen: not supported" would be worse than useless when the
 * answer is one export away, and the reason comes from the browser rather than
 * being guessed at here.
 */
function renderProfiles(profiles, state, host) {
  state.textContent = `Found ${profiles.length} profile${profiles.length === 1 ? '' : 's'}.`;
  const rows = profiles.map((profile) => bookmarkAction(
    profile.browser,
    profile.kind === 'firefox' ? 'Firefox-family profile' : 'Chromium-family profile',
    'Import',
    async (button) => {
      button.disabled = true;
      const res = await api.request('import-from-profile', { path: profile.path });
      button.disabled = false;
      if (res && res.ok) {
        state.textContent = `Imported ${res.added} from ${res.browser}` +
          `${res.skipped ? `, skipped ${res.skipped} already saved or unsupported` : ''}.`;
        renderBookmarks();
      } else {
        state.textContent = (res && res.reason) || 'That import did not work.';
      }
    }));
  host.replaceChildren(...rows);
}

function bookmarkRow(item) {
  const row = document.createElement('div');
  row.className = 'row bookmark-row';
  // The site's mark, as on the bar, so a long list can be scanned by eye.
  row.append(siteChip(item.url, { icon: item.icon }));

  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = item.title;
  const hint = document.createElement('span');
  hint.className = 'row-hint';
  hint.textContent = item.folder ? `${item.folder} – ${item.url}` : item.url;
  text.append(label, hint);

  const control = document.createElement('div');
  control.className = 'row-control';
  const open = document.createElement('button');
  open.className = 'ghost-btn';
  open.textContent = 'Open';
  open.addEventListener('click', () => api.send('new-tab', { url: item.url }));
  const edit = document.createElement('button');
  edit.className = 'ghost-btn';
  edit.textContent = 'Edit';
  // The form replaces the row it edits rather than opening beside it, so the
  // list never shows a bookmark twice and nothing below it moves.
  edit.addEventListener('click', () => row.replaceWith(bookmarkForm(item)));
  const remove = document.createElement('button');
  remove.className = 'ghost-btn danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    await api.request('remove-bookmark', { id: item.id });
    renderBookmarks();
  });
  control.append(open, edit, remove);

  row.append(text, control);
  return row;
}

/**
 * The editor, for both jobs it has.
 *
 * With an item it edits that one; without, it adds a new bookmark and stays
 * open so several can be typed in a row. One function for both because they
 * are the same two fields with the same validation behind them, and two
 * near-identical forms is how the add path ends up accepting something the
 * edit path refuses.
 *
 * Nothing is validated here. The address is handed to the browser and the
 * answer comes back: `bookmarks.js` is the one place that decides what may be
 * stored - it is what refuses `javascript:` in an imported file - and a second
 * opinion in a renderer would eventually disagree with it.
 */
function bookmarkForm(item = null) {
  const row = document.createElement('div');
  row.className = 'row bookmark-form';

  const fields = document.createElement('div');
  fields.className = 'row-text bookmark-fields';

  // Two unlabelled boxes at the top of a page are a puzzle; every other row in
  // Settings says what it is, and this one has to as well.
  const heading = document.createElement('span');
  heading.className = 'row-label';
  heading.textContent = item ? 'Editing this bookmark' : 'Add a bookmark';
  fields.append(heading);

  const title = document.createElement('input');
  title.type = 'text';
  title.placeholder = 'Name';
  title.value = item ? item.title : '';
  // Typed and unsent, so the governor knows not to discard this page under it.
  title.setAttribute('data-transient', '');

  const url = document.createElement('input');
  url.type = 'text';
  url.placeholder = 'https://';
  url.value = item ? item.url : '';
  url.setAttribute('data-transient', '');

  const problem = document.createElement('span');
  problem.className = 'row-hint';

  fields.append(title, url, problem);

  const control = document.createElement('div');
  control.className = 'row-control';

  const save = document.createElement('button');
  save.className = 'ghost-btn';
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    save.disabled = true;
    const res = await api.request('save-bookmark', {
      id: item ? item.id : '',
      url: url.value.trim(),
      title: title.value.trim() || url.value.trim()
    });
    save.disabled = false;
    if (!res || !res.ok) {
      problem.textContent = (res && res.reason) || 'That could not be saved.';
      return;
    }
    // Adding leaves the form up with empty fields; editing closes it, because
    // the row it came from is what the user wants to see again.
    if (!item) { title.value = ''; url.value = ''; problem.textContent = ''; }
    await renderBookmarks();
    // Cleared or replaced without an input event; say the page is clean.
    reportTransient();
  });

  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = item ? 'Cancel' : 'Clear';
  cancel.addEventListener('click', () => {
    if (item) row.replaceWith(bookmarkRow(item));
    else { title.value = ''; url.value = ''; problem.textContent = ''; }
    reportTransient();
  });

  control.append(save, cancel);
  row.append(fields, control);

  // Enter saves, from either field. A two-field form where the keyboard does
  // nothing is a form that has to be finished with the mouse.
  // Escape is Cancel, and handled: the page's own Escape would otherwise put
  // back the value the field had on focus, undoing the Clear.
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); save.click(); }
    else if (event.key === 'Escape') { event.preventDefault(); cancel.click(); }
  });

  return row;
}

// The bookmark editor's fields are `data-transient`: a half-typed bookmark
// keeps this page off the reclaim ladder, as a half-typed search does
// elsewhere. See theme.js.
const reportTransient = watchTransientInput(api);
