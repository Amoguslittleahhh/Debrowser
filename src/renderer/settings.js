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

/** Accent choices. Named so the swatches have something to announce. */
const ACCENTS = [
  { value: '#5b8cff', name: 'Blue' },
  { value: '#49c17d', name: 'Green' },
  { value: '#b07cf0', name: 'Purple' },
  { value: '#e0a33e', name: 'Amber' },
  { value: '#e2564a', name: 'Red' },
  { value: '#43b8c4', name: 'Teal' }
];

/** Tab strip colours. Muted on purpose: this is a large area, not an accent. */
const STRIP_COLORS = [
  { value: '#1b2430', name: 'Slate',   css: '#1b2430' },
  { value: '#241c2e', name: 'Plum',    css: '#241c2e' },
  { value: '#1a2622', name: 'Pine',    css: '#1a2622' },
  { value: '#2b2119', name: 'Umber',   css: '#2b2119' },
  { value: '#2a1c22', name: 'Wine',    css: '#2a1c22' }
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
      min: 0.6,
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
    { key: 'searchEngine', label: 'Search engine', type: 'select', options: 'engines' },
    {
      key: 'homepage',
      label: 'New tab page',
      hint: 'Leave empty for the built-in page.',
      type: 'text',
      placeholder: 'https://'
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
    }
  ],

  updates: [
    {
      key: 'autoUpdate',
      label: 'Install updates automatically',
      hint: 'Downloads only what changed. Your settings, tabs and data are untouched.',
      type: 'checkbox'
    }
  ]
};

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
      select.addEventListener('change', () => save(spec.key, select.value));
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
          if (select.value !== value) select.value = value;
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
      // `input` for the live preview as it is dragged, `change` to save - so a
      // drag across the range is one write to disk rather than forty.
      input.addEventListener('input', () => show(Number(input.value)));
      input.addEventListener('change', () => save(spec.key, Number(input.value)));

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
        { value: 'default', name: 'Default', css: '#16181d' },
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

function renderUpdateState(u) {
  const el = document.getElementById('update-state');
  if (!el) return;
  if (!u) { el.textContent = ''; return; }
  if (!u.available) { el.textContent = `Updates are unavailable here: ${u.reason}.`; return; }
  switch (u.state) {
    case 'checking':    el.textContent = 'Checking for a new version…'; break;
    case 'downloading': el.textContent = `Downloading ${u.version} — ${u.progress}%.`; break;
    case 'ready':       el.textContent = `${u.version} is downloaded and installs when you restart.`; break;
    case 'error':       el.textContent = `Last check failed: ${u.error}`; break;
    default:            el.textContent = 'Up to date.';
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
  if (!built) { buildAll(); renderCredentials(); renderBookmarks(); renderPresence(); }
  renderDownloads();
  for (const [key, control] of controls) control.write(state.prefs[key]);
});

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
  const remove = document.createElement('button');
  remove.className = 'ghost-btn danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    await api.request('remove-bookmark', { id: item.id });
    renderBookmarks();
  });
  control.append(open, remove);

  row.append(text, control);
  return row;
}
