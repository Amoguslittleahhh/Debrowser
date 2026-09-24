'use strict';

/** The keyboard shortcut sheet: drawn from the browser's own table. */

const api = window.debrowser;
const groups = document.getElementById('groups');
const sheet = document.getElementById('sheet');
const close = () => api.send('close-menu');

document.getElementById('close').append(crossIcon());
document.getElementById('close').addEventListener('click', close);
document.getElementById('backdrop').addEventListener('mousedown', close);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') close();
});

async function load() {
  const res = await api.request('shortcut-list');
  for (const group of res?.groups || []) {
    const section = document.createElement('section');
    section.className = 'keys-group';
    const title = document.createElement('h3');
    title.textContent = group.title;
    section.append(title);
    for (const row of group.rows) {
      const line = document.createElement('div');
      line.className = 'keys-row';
      const label = document.createElement('span');
      label.textContent = row.label;
      const keys = document.createElement('kbd');
      keys.textContent = row.keys;
      line.append(label, keys);
      section.append(line);
    }
    groups.append(section);
  }
  sheet.focus();
}

api.onState((state) => applyThemePrefs(state.prefs));
load();
