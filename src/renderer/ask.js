'use strict';

/**
 * A question from the browser, in its own sheet: what `dialog.showMessageBox`
 * used to draw in the system's style. The question comes from the browser
 * (`ask-spec`) and the answer goes back as an index into its buttons, exactly
 * as the message box answered - see `BrowserShell.ask`.
 *
 * Dismissing it - Escape, a click outside - is the cancel answer, as closing a
 * message box was.
 */

const api = window.debrowser;

const $ = (id) => document.getElementById(id);
let spec = null;
const buttons = [];

function answer(response) {
  api.send('ask-answer', { response, checked: $('checkbox').checked });
}

function show(next) {
  spec = next;
  if (!spec) { api.send('close-menu'); return; }
  $('title').textContent = spec.title;
  $('lead').textContent = spec.message;
  $('lead').hidden = !spec.message;
  $('detail').textContent = spec.detail;
  $('detail').hidden = !spec.detail;
  $('check').hidden = !spec.checkboxLabel;
  $('check-label').textContent = spec.checkboxLabel;
  $('title').classList.toggle('end', !spec.message && !spec.detail);
  $('lead').classList.toggle('end', Boolean(spec.message) && !spec.detail);

  // In the order a platform puts them: the default last, at the right, where
  // the eye ends; everything else before it in the order given.
  const order = spec.buttons.map((_, i) => i).filter((i) => i !== spec.defaultId).concat(spec.defaultId);
  $('actions').replaceChildren(...order.map((i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = i === spec.defaultId ? `btn primary${spec.danger ? ' danger' : ''}` : 'btn ghost';
    b.textContent = spec.buttons[i];
    b.addEventListener('click', () => answer(i));
    buttons[i] = b;
    return b;
  }));
  (buttons[spec.focusId] || $('sheet')).focus();
}

$('backdrop').addEventListener('mousedown', () => spec && answer(spec.cancelId));

window.addEventListener('keydown', (event) => {
  if (!spec) return;
  if (event.key === 'Escape') { event.preventDefault(); answer(spec.cancelId); return; }
  // A tab loop that cannot leave the sheet, as the update prompt's.
  if (event.key !== 'Tab') return;
  const focusable = [...document.querySelectorAll('#sheet input:not([hidden]), #actions button')]
    .filter((el) => !el.closest('[hidden]'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === $('sheet'))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

api.onState((state) => applyThemePrefs(state.prefs));
api.request('ask-spec').then(show, () => api.send('close-menu'));
