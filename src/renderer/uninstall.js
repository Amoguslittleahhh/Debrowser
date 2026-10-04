'use strict';

/**
 * The uninstall window (src/main/uninstall.js). One question, one choice:
 * keep the browsing data or delete it. Cancel has the focus, since the other
 * answer removes a program; Escape cancels from anywhere.
 */

const api = window.uninstaller;
const $ = (id) => document.getElementById(id);

function fit() {
  api.size($('card').getBoundingClientRect().height);
}

function leave() {
  document.body.classList.add('leaving');
  $('confirm').textContent = 'Uninstalling…';
  api.confirm($('remove-data').checked);
}

$('cancel').addEventListener('click', () => api.cancel());
$('confirm').addEventListener('click', leave);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); api.cancel(); }
});

api.onFailed((message) => {
  document.body.classList.remove('leaving');
  $('confirm').textContent = 'Uninstall';
  $('error').textContent = message;
  $('error').hidden = false;
});

api.info().then((info) => {
  if (!info) return;
  applyThemePrefs(info.prefs);
  if (info.browserOpen) $('lead').textContent = 'Debrowser is open. It will close first, then be removed from this computer.';
  // Measured again whenever the card changes size, not once: a face that
  // arrives after the first layout makes the text taller, and a window cut
  // to the first measurement then scrolled its top out of sight.
  new ResizeObserver(fit).observe($('card'));
  $('cancel').focus({ preventScroll: true });
});
