'use strict';

/** The quick window's bar: what is open in it, and its two choices. */

const api = window.debrowser;
const $ = (id) => document.getElementById(id);

api.onMessage((m) => {
  if (m.kind !== 'quick') return;
  let host = '';
  try { host = new URL(m.url).hostname.replace(/^www\./, ''); } catch { /* none */ }
  $('title').textContent = m.title && m.title !== m.url ? m.title : host || 'Loading…';
  $('host').textContent = m.title && m.title !== m.url ? host : '';
  $('spinner').hidden = !m.loading;
});
$('promote').addEventListener('click', () => api.send('quick-promote'));
$('close').addEventListener('click', () => api.send('quick-close'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.send('quick-close');
});
