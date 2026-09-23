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
      type: 'checkbox'
    },
    {
      key: 'tabBarPosition',
      label: 'Tab bar position',
      hint: 'Down the side, titles stay readable however many tabs are open.',
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
      hint: 'Separate from the accent. The second swatch follows it.',
      type: 'stripColor'
    },
    {
      key: 'windowOpacity',
      label: 'Tab bar translucency',
      hint: 'The strip alone, never pages. Needs a window material behind it.',
      type: 'range',
      min: 0.4,
      max: 1,
      step: 0.02,
      format: (v) => `${Math.round(v * 100)}%`
    },
    {
      key: 'backgroundMaterial',
      label: 'Window material',
      hint: 'Windows 11 only. Ignored elsewhere.',
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
      hint: 'Where new pages start, and where resetting zoom returns to.',
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

  credentials: [
    {
      key: 'requirePresence',
      label: 'Ask for Windows Hello or Touch ID first',
      hint: 'Before a saved password or card is shown or filled.',
      type: 'checkbox'
    },
    {
      key: 'fillPasswords',
      label: 'Fill saved passwords automatically',
      hint: 'Passwords only, and only when one saved sign-in matches the site.',
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
    const host = document.getElementById(sectionId);
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

  if (spec.hint) {
    const hint = document.createElement('span');
    hint.className = 'row-hint';
    hint.textContent = spec.hint;
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
          if (document.activeElement !== input) input.value = String(v);
          show(v);
        }
      };
    }

    case 'stripColor': {
      const wrap = document.createElement('div');
      wrap.className = 'swatches';

      const choices = [
        { value: 'default', name: 'Default', css: '#161614' },
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
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.send('close-tab');
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
    case 'downloading': el.textContent = `Downloading ${u.version} — ${u.progress}%.`; break;
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
 * about once.
 */
{
  const section = document.querySelector('section[data-section="updates"]');
  if (section && typeof IntersectionObserver === 'function') {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      api.request('check-for-updates').then(renderUpdateState);
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
      'hardware, so try it before relying on it — if the prompt does not appear, the ' +
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
      hint.textContent = 'Not shown — the identity check was not completed.';
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
  for (const [key, control] of controls) control.write(state.prefs[key]);
});

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
  if (typeof IntersectionObserver !== 'function') return;

  const main = document.querySelector('main');
  if (!main) return;

  /**
   * The end of the page, watched as a thing in its own right.
   *
   * Without it the mark stopped moving two sections early, and the reason is
   * the band below: the last sections are shorter than the scroller, so once
   * the page has scrolled as far as it goes they never reach the top 45% and
   * the topmost-intersecting rule keeps naming whichever section does. Reported
   * as the rail sticking on "Passwords and payment" while Advanced and Updates
   * were both on screen.
   *
   * A sentinel rather than a scroll handler, so the whole thing stays in one
   * mechanism: when the last pixel of the page is in view, the reader is in the
   * last section, whichever section that happens to be after a filter.
   */
  const end = document.createElement('div');
  end.className = 'rail-end';
  end.setAttribute('aria-hidden', 'true');
  main.append(end);

  let atEnd = false;

  const mark = () => {
    // Two different questions, and the second one is why this went wrong the
    // first time. "Which section is the reader in" is answered against the top
    // band; "which section is last on screen" has to be answered against the
    // whole scroller, because a section sitting below the band is exactly the
    // case at the end of the page - and asking the band about it returned the
    // section above, which is how the mark stopped one short of the last.
    const key = atEnd ? 'inView' : 'onScreen';
    const visible = sections.filter((s) => !s.hidden && s.dataset[key] === 'true');
    if (!visible.length) return;
    markRail((atEnd ? visible[visible.length - 1] : visible[0]).dataset.section);
  };

  // The reading position: the topmost section still in the top 45%.
  const reading = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.dataset.onScreen = String(entry.isIntersecting);
    mark();
  }, { root: main, rootMargin: '0px 0px -55% 0px' });

  // What is actually on screen, and whether the end of the page is.
  const onScreen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === end) atEnd = entry.isIntersecting;
      else entry.target.dataset.inView = String(entry.isIntersecting);
    }
    mark();
  }, { root: main });

  for (const section of sections) {
    reading.observe(section);
    onScreen.observe(section);
  }
  onScreen.observe(end);
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
    // Escape clears the field first and closes the page only when there is
    // nothing to clear - the same order every search field in this browser
    // uses, and the reason the page's own Escape handler is not enough.
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !search.value) return;
      event.stopPropagation();
      search.value = '';
      filterSettings('');
    });
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
async function renderDownloads() {
  const host = document.getElementById('download-list');
  if (!host) return;
  const res = await api.request('list-downloads');
  const items = (res && res.items) || [];
  if (!items.length) { host.replaceChildren(); return; }
  host.replaceChildren(...items.map(downloadRow));
  // A rebuilt row has never been filtered, and this list redraws itself while
  // a search is on screen.
  reapplyFilter();
}

function downloadRow(item) {
  const row = document.createElement('div');
  row.className = 'row';

  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = item.filename || item.url;
  const hint = document.createElement('span');
  hint.className = 'row-hint';
  hint.textContent = describeDownload(item);
  text.append(label, hint);

  const control = document.createElement('div');
  control.className = 'row-control';
  const button = document.createElement('button');
  const running = item.state === 'running' || item.state === 'starting';
  button.className = running ? 'ghost-btn danger' : 'ghost-btn';
  button.textContent = running ? 'Cancel' : 'Clear';
  button.addEventListener('click', async () => {
    await api.request(running ? 'cancel-download' : 'clear-download', { id: item.id });
    renderDownloads();
  });
  control.append(button);

  row.append(text, control);
  return row;
}

function describeDownload(item) {
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  switch (item.state) {
    case 'done':
      return `Finished — ${mb(item.received)} over ${item.segments} connection${item.segments === 1 ? '' : 's'}`;
    case 'failed':
      return `Failed — ${item.error}`;
    case 'cancelled':
      return 'Cancelled';
    default: {
      const rate = item.bytesPerSecond ? `, ${mb(item.bytesPerSecond)}/s` : '';
      return item.total
        ? `${mb(item.received)} of ${mb(item.total)} over ${item.segments} connection${item.segments === 1 ? '' : 's'}${rate}`
        : `${mb(item.received)}${rate}`;
    }
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
          state.textContent = 'No other browser profiles found in the usual places. ' +
            'Export a bookmarks file from that browser instead.';
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
  row.className = 'row';

  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = item.title;
  const hint = document.createElement('span');
  hint.className = 'row-hint';
  hint.textContent = item.folder ? `${item.folder} — ${item.url}` : item.url;
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
    renderBookmarks();
  });

  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = item ? 'Cancel' : 'Clear';
  cancel.addEventListener('click', () => {
    if (item) row.replaceWith(bookmarkRow(item));
    else { title.value = ''; url.value = ''; problem.textContent = ''; }
  });

  control.append(save, cancel);
  row.append(fields, control);

  // Enter saves, from either field. A two-field form where the keyboard does
  // nothing is a form that has to be finished with the mouse.
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); save.click(); }
  });

  return row;
}
