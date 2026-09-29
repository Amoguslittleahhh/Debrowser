'use strict';

/**
 * Shown when a private window asked for a plain-HTTP page and the secure
 * version was not there. The choice is the user's, made knowing what it costs;
 * the browser neither refuses outright nor falls back behind their back.
 */

const api = window.debrowser;
const params = new URLSearchParams(location.search);
const target = params.get('url') || '';

// The ordinary browser's HTTPS-first (strict mode) shows this page too, where
// the risk is the network in between rather than a Tor exit.
if (params.get('secure') === 'first') {
  document.title = 'Not secure';
  document.querySelector('h1').textContent = 'This site doesn’t offer a secure connection';
  document.querySelector('.detail').textContent =
    'Its pages come over plain HTTP, which anyone on the network between you and it - a café’s Wi-Fi, ' +
    'your provider - can read and change, including what you type into it.';
  document.getElementById('go').textContent = 'Continue to site';
  document.querySelector('.note').textContent =
    'Continuing allows plain HTTP for this site until Debrowser restarts. Settings can turn this check off.';
}

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
