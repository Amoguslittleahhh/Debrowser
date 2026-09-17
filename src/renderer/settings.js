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
      hint: 'System follows whatever the machine is set to.',
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
      hint: 'Down the side, a tab keeps its title however many are open, because the ' +
            'column divides height rather than a fixed width. It costs some width, ' +
            'which is why across the top is the default.',
      type: 'select',
      options: [
        { value: 'top', name: 'Across the top' },
        { value: 'left', name: 'Down the left' }
      ]
    },
    {
      key: 'tabWidth',
      label: 'Tab width',
      hint: 'Compact fits more tabs on the strip before they start shrinking.',
      type: 'select',
      options: [
        { value: 'roomy', name: 'Roomy' },
        { value: 'compact', name: 'Compact' }
      ]
    },
    {
      key: 'tabBarColor',
      label: 'Tab strip colour',
      hint: 'Separate from the accent, because the strip is the largest painted area ' +
            'in the window and the colour that works as a focus ring rarely works across it. ' +
            'The second swatch follows the accent instead.',
      type: 'stripColor'
    },
    {
      key: 'windowOpacity',
      label: 'Tab bar translucency',
      hint: 'The strip alone, never the page - fading a whole window fades the text on it. ' +
            'Painted by the system compositor, which is already drawing this window, so it ' +
            'costs essentially nothing. Turns on a window material to show through to, and ' +
            'needs a desktop that composites.',
      type: 'range',
      min: 0.6,
      max: 1,
      step: 0.02,
      format: (v) => `${Math.round(v * 100)}%`
    },
    {
      key: 'backgroundMaterial',
      label: 'Window material',
      hint: 'Windows 11 only. Lets the system paint its own blurred backdrop, which is ' +
            'cheaper than doing it ourselves. Ignored elsewhere.',
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
      hint: 'Stops the small entrance and press animations. Your system setting is ' +
            'always honoured regardless of this.',
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
      hint: 'The coloured dot showing whether a tab is active, idle, frozen or discarded.',
      type: 'checkbox'
    }
  ],

  browsing: [
    { key: 'searchEngine', label: 'Search engine', type: 'select', options: 'engines' },
    {
      key: 'homepage',
      label: 'New tab page',
      hint: 'Leave empty for the default.',
      type: 'text',
      placeholder: 'https://'
    }
  ],

  resources: [
    {
      key: 'memoryBudgetMB',
      label: 'Memory budget',
      hint: 'How much the browser may hold before it starts reclaiming. ' +
            'Empty sizes it to this machine.',
      type: 'number',
      placeholder: 'Automatic',
      min: 256,
      max: 65536,
      unit: 'MB'
    },
    {
      key: 'maxLiveTabs',
      label: 'Tabs holding a renderer',
      hint: 'Tabs past this limit stay open and keep their scroll and typed input, ' +
            'but give their renderer back. 0 removes the limit. Empty sizes it to this machine.',
      type: 'number',
      placeholder: 'Automatic',
      min: 0,
      max: 200
    }
  ],

  credentials: [
    {
      key: 'fillPasswords',
      label: 'Fill saved passwords automatically',
      hint: 'Only when exactly one saved sign-in matches the page\'s origin, and only ' +
            'passwords. Payment details are never filled without a click, because a page ' +
            'can hide a card field and a card number is not bound to any one site.',
      type: 'checkbox'
    }
  ],

  advanced: [
    {
      key: 'showMemoryDetail',
      label: 'Explain the memory figures',
      hint: 'Adds the notes about what the numbers mean and where they over-count to ' +
            'the task manager. Off by default, because a live instrument reads better ' +
            'without a wall of text beside it.',
      type: 'checkbox'
    },
    {
      key: 'hardwareAcceleration',
      label: 'Use hardware acceleration',
      hint: 'Turn off if pages flicker, views come up blank, or the browser will not ' +
            'start — that is almost always a GPU driver. Chromium decides this at ' +
            'launch, so it takes effect when you restart.',
      type: 'checkbox'
    }
  ],

  updates: [
    {
      key: 'autoUpdate',
      label: 'Install updates automatically',
      hint: 'Downloads only the parts that changed rather than the whole browser. ' +
            'Settings, open tabs and saved data are never touched by an update. ' +
            'Off means the browser never checks.',
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
  if (!built) { buildAll(); renderCredentials(); renderBookmarks(); }
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
