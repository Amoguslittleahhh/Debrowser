'use strict';

/** Peek's backdrop: shows what is in the card, and sends its two choices. */

const api = window.debrowser;
const $ = (id) => document.getElementById(id);

api.onMessage((m) => {
  if (m.kind !== 'peek') return;
  let host = '';
  try { host = new URL(m.url).hostname.replace(/^www\./, ''); } catch { /* none */ }
  $('title').textContent = m.title && m.title !== m.url ? m.title : host || 'Loading…';
  $('host').textContent = m.title && m.title !== m.url ? host : '';
  $('spinner').hidden = !m.loading;
});
$('promote').addEventListener('click', () => api.send('peek-promote'));
$('close').addEventListener('click', () => api.send('peek-close'));
// A click on the dimmed page, not on the bar, puts it away.
document.body.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.bar')) api.send('peek-close');
});
api.onState((state) => applyThemePrefs(state.prefs));
