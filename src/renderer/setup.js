'use strict';

/**
 * The setup window (src/main/setup/setup-window.js): installing or uninstalling,
 * one question at a time. What it says comes from the browser as a spec;
 * this draws it, measures it and sends the answer back. Cancel has the
 * focus - the other answer moves or removes a program - and Escape cancels
 * from anywhere.
 */

const api = window.setup;
const $ = (id) => document.getElementById(id);
let spec = null;

function fit() {
  api.size($('card').getBoundingClientRect().height);
}

function answer() {
  // Not before the question has arrived: the window can be shown by its
  // fallback timer first, with nothing yet to answer.
  if (!spec) return;
  document.body.classList.add('working');
  $('error').hidden = true;
  $('confirm').textContent = spec.busy || spec.confirm;
  api.confirm($('check').checked);
}

$('cancel').addEventListener('click', () => api.cancel());
$('confirm').addEventListener('click', answer);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); api.cancel(); }
});

api.onFailed((message) => {
  document.body.classList.remove('working');
  $('confirm').textContent = spec.confirm;
  $('error').textContent = message;
  $('error').hidden = false;
});

api.info().then((info) => {
  if (!info) return;
  spec = info.spec;
  applyThemePrefs(info.prefs);
  document.title = spec.title;
  $('title').textContent = spec.title;
  $('lead').textContent = spec.lead;
  if (spec.check) {
    $('choice').hidden = false;
    $('choice').classList.toggle('danger', spec.check.danger === true);
    $('check-label').textContent = spec.check.label;
    $('check-detail').textContent = spec.check.detail || '';
    $('check-detail').hidden = !spec.check.detail;
  }
  $('cancel').textContent = spec.cancel;
  $('confirm').textContent = spec.confirm;
  $('confirm').classList.toggle('danger', spec.danger === true);
  // Measured again whenever the card changes size, not once: a face that
  // arrives after the first layout makes the text taller, and a window cut
  // to the first measurement then scrolled its top out of sight.
  new ResizeObserver(fit).observe($('card'));
  $('cancel').focus({ preventScroll: true });
});
