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
      label: 'Window translucency',
      hint: 'Asked of the system compositor, which is already drawing this window, ' +
            'so it costs essentially nothing. Needs a desktop that composites.',
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

api.onState((state) => {
  applyThemePrefs(state.prefs);
  renderUpdateState(state.updates);
  if (!state.prefs) return;
  if (Array.isArray(state.searchEngines)) engines = state.searchEngines;
  if (!built) buildAll();
  for (const [key, control] of controls) control.write(state.prefs[key]);
});
