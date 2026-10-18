'use strict';

/**
 * The first-run tour.
 *
 * Every choice goes to the browser the moment it is made (set-pref, validated
 * against the same schema Settings uses) and comes back as state, which is
 * what marks the chosen button - so what this page shows as picked is what the
 * browser actually has, and the browser around it restyles as you click.
 */

const api = window.debrowser;

// Five: the default-browser button joined "How you browse", and the tips the
// last step, which until then said one line and showed an empty card.
const STEPS = ['hello', 'import', 'look', 'browsing', 'done'];
const NEXT_LABEL = { hello: 'Get started', done: 'Start browsing' };

// Settings' accent choices (settings.js, ACCENTS), in its order.
const ACCENTS = [
  { value: '#2f857b', name: 'Petrol' },
  { value: '#6f8f5f', name: 'Moss' },
  { value: '#a8694a', name: 'Clay' },
  { value: '#b08a3c', name: 'Ochre' },
  { value: '#7b6a9c', name: 'Iris' },
  { value: '#5f7d9c', name: 'Slate' }
];

let step = 0;
let prefs = null;
let engines = [];
/** What the import step brought over, for the last step to say. */
let imported = null;
/** Whether Debrowser is the default browser, as last asked. */
let isDefault = null;

const $ = (id) => document.getElementById(id);
const save = (key, value) => api.send('set-pref', { key, value });

/* ---------------------------------------------------------------- */
/* Steps                                                             */
/* ---------------------------------------------------------------- */

const progress = $('progress');
progress.replaceChildren(...STEPS.map(() => document.createElement('span')));

const card = document.querySelector('.card');
let shown = false;
const calm = matchMedia('(prefers-reduced-motion: reduce)');

function show(index) {
  step = Math.max(0, Math.min(STEPS.length - 1, index));
  const name = STEPS[step];
  // The card is as tall as its step, and slides between heights rather than
  // jumping: one height for every step left the short ones mostly empty.
  const from = card.getBoundingClientRect().height;
  for (const section of document.querySelectorAll('section[data-step]')) {
    section.hidden = section.dataset.step !== name;
  }
  if (name === 'done') {
    renderRecap();
    // Opened straight at the last step, the default has not been asked yet.
    if (isDefault === null) refreshDefault().then(renderRecap, () => {});
  }
  [...progress.children].forEach((bar, i) => {
    bar.className = i < step ? 'done' : i === step ? 'now' : '';
  });
  progress.setAttribute('aria-label', `Step ${step + 1} of ${STEPS.length}`);
  $('back').hidden = step === 0;
  $('skip').hidden = name === 'done';
  $('next').textContent = NEXT_LABEL[name] || 'Next';
  if (name === 'import') findProfiles();
  if (name === 'browsing') refreshDefault();
  const to = card.getBoundingClientRect().height;
  // Not on the first showing: there is nothing to slide from, only the
  // hello step's height, which is not where the page ever was.
  if (shown && from && Math.abs(from - to) > 1 && !calm.matches) {
    card.animate([{ height: `${from}px` }, { height: `${to}px` }],
      { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
  shown = true;
  $('next').focus({ preventScroll: true });
}

function finish() {
  // Marked done and moved on to a new tab, both by the browser.
  api.send('welcome-done');
}

$('next').addEventListener('click', () => (step === STEPS.length - 1 ? finish() : show(step + 1)));
$('back').addEventListener('click', () => show(step - 1));
$('skip').addEventListener('click', finish);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.target.closest('select, input, .list, .choices, .segmented, .swatches')) return;
  // Any other button does its own thing on Enter: Back goes back, Skip skips.
  const button = event.target.closest('button');
  if (button && button.id !== 'next') return;
  event.preventDefault();
  $('next').click();
});

/* ---------------------------------------------------------------- */
/* Choices                                                           */
/* ---------------------------------------------------------------- */

$('accents').replaceChildren(...ACCENTS.map(({ value, name }) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.value = value;
  b.title = name;
  b.setAttribute('aria-label', name);
  b.style.background = value;
  return b;
}));

for (const group of document.querySelectorAll('[data-pref]:not(input):not(select)')) {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (button) save(group.dataset.pref, button.dataset.value);
  });
}
for (const input of document.querySelectorAll('input[data-pref]')) {
  input.addEventListener('change', () => save(input.dataset.pref, input.checked));
}
$('engines').addEventListener('change', (event) => save('searchEngine', event.target.value));

function render() {
  if (!prefs) return;
  for (const group of document.querySelectorAll('[data-pref]:not(input):not(select)')) {
    const current = String(prefs[group.dataset.pref]);
    for (const button of group.querySelectorAll('button[data-value]')) {
      button.setAttribute('aria-pressed', String(button.dataset.value.toLowerCase() === current.toLowerCase()));
    }
  }
  for (const input of document.querySelectorAll('input[data-pref]')) {
    input.checked = prefs[input.dataset.pref] === true;
  }
  // The bookmarks bar is across the top only; down the side it has nowhere to be.
  const bar = document.querySelector('input[data-pref="showBookmarksBar"]');
  bar.disabled = prefs.tabBarPosition === 'left' && prefs.sidebarPinned !== false;
  bar.closest('label').title = bar.disabled ? 'With the tabs down the side, bookmarks are under Ctrl+Shift+O.' : '';
  const select = $('engines');
  if (select.options.length !== engines.length) {
    select.replaceChildren(...engines.map(({ id, name }) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = name;
      return option;
    }));
  }
  select.value = prefs.searchEngine;
}

api.onState((state) => {
  applyThemePrefs(state.prefs);
  if (!state.prefs) return;
  prefs = state.prefs;
  if (Array.isArray(state.searchEngines)) engines = state.searchEngines;
  render();
  if (STEPS[step] === 'done') renderRecap();
});

/* ---------------------------------------------------------------- */
/* Import                                                            */
/* ---------------------------------------------------------------- */

let profilesFound = false;

async function findProfiles() {
  if (profilesFound) return;
  profilesFound = true;
  const host = $('profiles');
  const res = await api.request('bookmark-profiles');
  const profiles = (res && res.profiles) || [];
  if (!profiles.length) {
    host.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'fine',
      textContent: 'No other browsers here to bring anything over from. If you’ve exported bookmarks from one as a file, you can choose it below.'
    }));
    return;
  }
  host.replaceChildren(...profiles.map((profile) => {
    const b = document.createElement('button');
    b.type = 'button';
    const name = document.createElement('span');
    name.textContent = profile.browser;
    const hint = document.createElement('small');
    hint.textContent = 'Import';
    b.append(name, hint);
    b.addEventListener('click', async () => {
      b.disabled = true;
      hint.textContent = 'Importing…';
      const r = await api.request('import-from-profile', { path: profile.path, withHistory: true });
      if (r && r.ok) {
        hint.textContent = 'Imported';
        const pages = r.pages ? ` and ${r.pages.toLocaleString()} page${r.pages === 1 ? '' : 's'} of history` : '';
        note(`Imported ${r.added} bookmark${r.added === 1 ? '' : 's'}${pages} from ${r.browser}.`, 'ok');
        imported = `${r.added} bookmark${r.added === 1 ? '' : 's'}${pages} from ${r.browser}`;
      } else {
        b.disabled = false;
        hint.textContent = 'Import';
        note((r && r.reason) ? `Couldn’t import: ${r.reason}.` : 'That import didn’t work.', 'bad');
      }
    });
    return b;
  }));
}

$('import-file').addEventListener('click', async () => {
  const r = await api.request('import-bookmark-file');
  if (!r || r.cancelled) return;
  if (r.ok) {
    note(`Imported ${r.added} bookmark${r.added === 1 ? '' : 's'} from ${r.browser}.`, 'ok');
    imported = `${r.added} bookmark${r.added === 1 ? '' : 's'} from ${r.browser}`;
  }
  else note(`Couldn’t import: ${r.reason}.`, 'bad');
});

function note(text, kind) {
  const el = $('import-note');
  el.textContent = text;
  el.className = `note ${kind || ''}`;
}

/* ---------------------------------------------------------------- */
/* Default browser                                                   */
/* ---------------------------------------------------------------- */

const HOW = {
  win32: 'Windows opens its Default apps settings: choose Debrowser there as your web browser.',
  darwin: 'Your Mac asks you to confirm: choose “Use Debrowser”.',
  linux: 'Makes Debrowser your default browser.'
};

async function refreshDefault() {
  const res = await api.request('default-browser-status');
  isDefault = Boolean(res && res.isDefault);
  const state = $('default-state');
  state.textContent = isDefault ? 'Debrowser is your default browser.' : '';
  state.className = `note ${isDefault ? 'ok' : ''}`;
  $('make-default').hidden = isDefault;
  $('default-how').textContent = isDefault ? 'Links from other apps open here.' : (HOW[res && res.platform] || HOW.linux);
}

$('make-default').addEventListener('click', () => api.send('make-default'));
// Coming back from the system's settings is when the answer may have changed.
window.addEventListener('focus', () => { if (STEPS[step] === 'browsing') refreshDefault(); });

/* ---------------------------------------------------------------- */
/* What was chosen                                                   */
/* ---------------------------------------------------------------- */

const DESIGNS = { ledger: 'Ledger', paper: 'Paper', grid: 'Grid', calm: 'Calm', legacy: 'Legacy' };
const THEMES = { system: 'light or dark with your system', light: 'light', dark: 'dark' };

/** The last step reads back what the browser now has - not what was clicked. */
function renderRecap() {
  if (!prefs) return;
  const rows = [];
  const row = (term, text, swatch) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    if (swatch) {
      const dot = document.createElement('i');
      dot.className = 'recap-swatch';
      dot.style.background = swatch;
      dd.append(dot);
    }
    dd.append(text);
    rows.push(dt, dd);
  };
  const accent = ACCENTS.find((a) => a.value.toLowerCase() === String(prefs.accent).toLowerCase());
  row('Look', `${DESIGNS[prefs.design] || 'Ledger'}, ${THEMES[prefs.theme] || prefs.theme}${accent ? `, ${accent.name} accent` : ''}`,
    accent ? accent.value : null);
  row('Tabs', prefs.tabBarPosition === 'left' ? 'Down the side'
    : `Across the top${prefs.showBookmarksBar ? ', with the bookmarks bar' : ''}`);
  const engine = engines.find((e) => e.id === prefs.searchEngine);
  if (engine) row('Search', engine.name);
  row('When you start', prefs.restoreTabs ? 'Your tabs from last time' : 'A fresh tab');
  if (imported) row('Brought over', imported);
  if (isDefault !== null) row('Default browser', isDefault ? 'Debrowser' : 'Not changed');
  $('recap').replaceChildren(...rows);
}

// A step named in the address (debrowser://welcome#look) opens at that step.
show(Math.max(0, STEPS.indexOf(decodeURIComponent(location.hash.slice(1)))));
