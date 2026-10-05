'use strict';

/**
 * The site's passkeys, as the browser's own list (passkeys.js in main).
 *
 * Two shapes from one card: a dropdown under the sign-in field, which leaves
 * the keyboard in the field until the arrow key brings it here, and a chooser
 * under the address bar, which takes the keyboard at once. Picking a row hands
 * that one credential back to the page; Windows Hello then only confirms it is
 * you. Nothing here is the page's: the names are shown in the browser's view,
 * and the page hears only which one was picked.
 */

const api = window.debrowser;

const el = {
  card: document.getElementById('card'),
  head: document.getElementById('head'),
  title: document.getElementById('title'),
  rows: document.getElementById('rows'),
  other: document.getElementById('other'),
  sub: document.getElementById('sub'),
  sep: document.getElementById('sep'),
  verify: document.getElementById('verify'),
  passcode: document.getElementById('passcode'),
  error: document.getElementById('verify-error')
};

/** The card's height, for the view to be exactly that tall. */
function measure() {
  requestAnimationFrame(() => {
    // The card and the margin its shadow is drawn in.
    const box = el.card.getBoundingClientRect();
    api.send('passkey-size', { height: Math.ceil(box.bottom + 16) });
  });
}

/** Asking for the passcode instead of a choice: the list has been made. */
function askPasscode(model) {
  el.head.hidden = false;
  if (model.title) el.title.textContent = model.title;
  el.sub.textContent = 'Enter your Debrowser passcode to continue';
  for (const node of [el.rows, el.sep, el.other]) node.hidden = true;
  el.verify.hidden = false;
  el.error.textContent = model.error || '';
  el.passcode.value = '';
  el.passcode.focus();
  measure();
}

el.verify.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!el.passcode.value) return;
  api.send('passkey-passcode', { passcode: el.passcode.value });
  el.passcode.value = '';
});

/** The rows the keyboard moves through, the "different passkey" one last. */
const items = () => [...el.rows.querySelectorAll('.row'), el.other];

function render(model) {
  if (model.prefs) applyThemePrefs(model.prefs);
  const chooser = model.mode !== 'dropdown';
  document.body.dataset.mode = chooser ? 'chooser' : 'dropdown';
  el.head.hidden = !chooser;
  el.title.textContent = `Sign in to ${model.site}`;
  el.sub.textContent = 'Choose a passkey saved on this device';
  for (const node of [el.rows, el.sep, el.other]) node.hidden = false;
  el.verify.hidden = true;
  el.rows.textContent = '';
  for (const account of model.accounts || []) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    row.setAttribute('role', 'option');
    const label = account.display || account.name || 'Passkey';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = (label.trim()[0] || '?').toUpperCase();
    const text = document.createElement('span');
    text.className = 'text';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;
    const meta = document.createElement('span');
    meta.className = 'meta';
    // The username under the name, where they differ; otherwise what it is.
    meta.textContent = account.name && account.name !== label ? account.name : 'Passkey · Windows Hello';
    text.append(name, meta);
    row.append(avatar, text);
    row.addEventListener('click', () => api.send('passkey-pick', { id: account.id }));
    el.rows.append(row);
  }
  measure();
  if (chooser) requestAnimationFrame(() => items()[0].focus());
}

el.other.addEventListener('click', () => api.send('passkey-other'));

document.addEventListener('keydown', (event) => {
  if (!el.verify.hidden && event.key !== 'Escape') return;
  const list = items();
  const at = list.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    api.send('passkey-close');
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    list[(at + step + list.length) % list.length].focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    list[event.key === 'Home' ? 0 : list.length - 1].focus();
  }
});

api.onMessage((message) => {
  if (!message) return;
  if (message.kind === 'passkeys') render(message);
  // Down from the field: the first passkey, as in Chrome's dropdown.
  if (message.kind === 'passkeys-focus' && el.verify.hidden) items()[0].focus();
  if (message.kind === 'passkeys-passcode') askPasscode(message);
});
