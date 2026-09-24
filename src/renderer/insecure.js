'use strict';

/**
 * Shown when a private window asked for a plain-HTTP page and the secure
 * version was not there. The choice is the user's, made knowing what it costs;
 * the browser neither refuses outright nor falls back behind their back.
 */

const api = window.debrowser;
const target = new URLSearchParams(location.search).get('url') || '';

let host = 'This site';
try {
  const parsed = new URL(target);
  if (parsed.protocol === 'http:') host = parsed.host;
} catch { /* not a URL: nothing to continue to */ }
document.getElementById('host').textContent = host;

const go = document.getElementById('go');
go.hidden = host === 'This site';
go.addEventListener('click', () => api.send('allow-http', { url: target }));
document.getElementById('back').addEventListener('click', () => api.send('back'));

api.onState((state) => applyThemePrefs(state.prefs));
