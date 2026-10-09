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

const STEPS = ['hello', 'import', 'look', 'browsing', 'default', 'tour', 'done'];
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

const $ = (id) => document.getElementById(id);
const save = (key, value) => api.send('set-pref', { key, value });

/* ---------------------------------------------------------------- */
/* Steps                                                             */
/* ---------------------------------------------------------------- */

const progress = $('progress');
progress.replaceChildren(...STEPS.map(() => document.createElement('span')));

function show(index) {
  step = Math.max(0, Math.min(STEPS.length - 1, index));
  const name = STEPS[step];
  for (const section of document.querySelectorAll('section[data-step]')) {
    section.hidden = section.dataset.step !== name;
  }
  [...progress.children].forEach((bar, i) => {
    bar.className = i < step ? 'done' : i === step ? 'now' : '';
  });
  progress.setAttribute('aria-label', `Step ${step + 1} of ${STEPS.length}`);
  $('back').hidden = step === 0;
  $('skip').hidden = name === 'done';
  $('next').textContent = NEXT_LABEL[name] || 'Next';
  if (name === 'import') findProfiles();
  if (name === 'default') refreshDefault();
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
  bar.disabled = prefs.tabBarPosition === 'left';
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
      textContent: 'No other browsers found on this computer. If you have a bookmarks file exported from one, choose it below.'
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
  if (r.ok) note(`Imported ${r.added} bookmark${r.added === 1 ? '' : 's'} from ${r.browser}.`, 'ok');
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
  win32: 'Windows opens its Default apps settings. Choose Debrowser there as your web browser.',
  darwin: 'macOS asks you to confirm. Choose "Use Debrowser".',
  linux: 'Set through your desktop\'s default applications.'
};

async function refreshDefault() {
  const res = await api.request('default-browser-status');
  const isDefault = Boolean(res && res.isDefault);
  const state = $('default-state');
  state.textContent = isDefault ? 'Debrowser is your default browser.' : '';
  state.className = `note ${isDefault ? 'ok' : ''}`;
  $('make-default').hidden = isDefault;
  $('default-how').textContent = isDefault ? '' : (HOW[res && res.platform] || '');
}

$('make-default').addEventListener('click', () => api.send('make-default'));
// Coming back from the system's settings is when the answer may have changed.
window.addEventListener('focus', () => { if (STEPS[step] === 'default') refreshDefault(); });

// A step named in the address (debrowser://welcome#look) opens at that step.
show(Math.max(0, STEPS.indexOf(decodeURIComponent(location.hash.slice(1)))));
