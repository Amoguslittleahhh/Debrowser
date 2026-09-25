'use strict';

/**
 * Saved sign-ins and cards, behind the lock.
 *
 * Everything here is asked of the browser one request at a time, and the
 * browser answers `{ locked: true }` to any of them once the vault has locked
 * itself (five minutes without use; see src/main/vault.js). So the page never
 * decides it is unlocked on its own: it asks, and a locked answer anywhere
 * sends it back to the lock screen.
 *
 * Secrets are fetched one at a time on a press, shown in the row that asked,
 * and dropped from the page when hidden again.
 */

const api = window.debrowser;
const $ = (id) => document.getElementById(id);

const el = {
  query: $('q'), lock: $('lock'), close: $('close'),
  off: $('off'), unavailable: $('unavailable'), unavailableWhy: $('unavailable-why'),
  locked: $('locked'), lockedNote: $('locked-note'), presence: $('presence'),
  passcode: $('passcode'), unlock: $('unlock'), unlockError: $('unlock-error'),
  open: $('open'), logins: $('logins'), loginsEmpty: $('logins-empty'),
  cards: $('cards'), cardsEmpty: $('cards-empty'),
  cardForm: $('card-form'), cardError: $('card-error'), addCard: $('add-card')
};

/** Show one state: 'off', 'unavailable', 'locked' or 'open'. */
function show(state) {
  for (const name of ['off', 'unavailable', 'locked', 'open']) el[name].hidden = name !== state;
  el.lock.hidden = state !== 'open';
  el.query.hidden = state !== 'open';
  if (state === 'locked') {
    el.passcode.value = '';
    requestAnimationFrame(() => el.passcode.focus());
  }
}

/* ------------------------------------------------------------------ */
/* The lock                                                            */
/* ------------------------------------------------------------------ */

let presence = null;

async function refresh() {
  const status = await api.request('vault-status');
  if (!status) return;
  if (!status.available) {
    el.unavailableWhy.textContent = `${status.reason}. Nothing is written to disk unless the ` +
      'operating system can encrypt it.';
    show('unavailable');
    return;
  }
  if (!status.configured) { show('off'); return; }
  if (!status.unlocked) {
    if (el.locked.hidden) show('locked');
    await offerPresence();
    waitNote(status.waitMs);
    return;
  }
  // Only on the way in. Reading the list counts as using the vault, so reading
  // it on every check would keep an open page unlocked for ever.
  if (el.open.hidden) {
    show('open');
    await load();
  }
}

/** The Windows Hello or Touch ID button, where the machine has one. */
async function offerPresence() {
  if (presence === null) presence = (await api.request('presence-capability')) || { available: false };
  el.presence.hidden = !presence.available;
  if (presence.available) el.presence.textContent = `Unlock with ${presence.mechanism}`;
}

let waitTimer = null;
/** After too many wrong guesses: how long until the next one is heard. */
function waitNote(ms) {
  clearTimeout(waitTimer);
  if (!ms) { el.unlock.disabled = false; return; }
  el.unlock.disabled = true;
  el.unlockError.textContent = `Too many tries. Wait ${Math.ceil(ms / 1000)} seconds.`;
  waitTimer = setTimeout(() => { el.unlock.disabled = false; el.unlockError.textContent = ''; }, ms);
}

el.locked.addEventListener('submit', async (event) => {
  event.preventDefault();
  const passcode = el.passcode.value;
  if (!passcode) return;
  el.unlock.disabled = true;
  const res = await api.request('vault-unlock', { method: 'passcode', passcode });
  el.unlock.disabled = false;
  el.passcode.value = '';
  if (res && res.ok) { el.unlockError.textContent = ''; refresh(); return; }
  if (res && res.waitMs) { waitNote(res.waitMs); return; }
  el.unlockError.textContent = 'That is not the passcode.';
  el.passcode.focus();
});

el.presence.addEventListener('click', async () => {
  el.presence.disabled = true;
  const res = await api.request('vault-unlock', { method: 'presence' });
  el.presence.disabled = false;
  if (res && res.ok) { el.unlockError.textContent = ''; refresh(); return; }
  el.unlockError.textContent = `${presence.mechanism} did not confirm it was you. Use the passcode instead.`;
});

el.lock.addEventListener('click', async () => {
  await api.request('vault-lock');
  clearLists();
  show('locked');
  offerPresence();
});

$('setup').addEventListener('click', () => api.send('open-settings', { section: 'credentials' }));

/* ------------------------------------------------------------------ */
/* The lists                                                           */
/* ------------------------------------------------------------------ */

let data = { logins: [], payments: [] };

function clearLists() {
  data = { logins: [], payments: [] };
  el.logins.replaceChildren();
  el.cards.replaceChildren();
}

/** Ask for something that needs the vault open; a locked answer shows the lock. */
async function ask(command, payload) {
  const res = await api.request(command, payload);
  if (res && res.locked) {
    clearLists();
    show('locked');
    offerPresence();
    return null;
  }
  return res;
}

async function load() {
  const res = await ask('list-credentials');
  if (!res) return;
  data = { logins: res.logins || [], payments: res.payments || [] };
  render();
}

function render() {
  const needle = el.query.value.trim().toLowerCase();
  const hit = (...texts) => !needle || texts.some((t) => String(t || '').toLowerCase().includes(needle));

  const logins = data.logins.filter((l) => hit(l.origin, l.username));
  el.logins.replaceChildren(...logins.map((l) => row({
    kind: 'login', id: l.id, title: host(l.origin), site: l.origin, detail: l.username || '(no username)'
  })));
  el.loginsEmpty.hidden = data.logins.length > 0;
  if (needle && data.logins.length && !logins.length) {
    el.loginsEmpty.hidden = false;
    el.loginsEmpty.textContent = 'No sign-ins match.';
  } else {
    el.loginsEmpty.textContent = 'None yet. Sign in to a site and the browser offers to remember it.';
  }

  const cards = data.payments.filter((p) => hit(p.label));
  el.cards.replaceChildren(...cards.map((p) => row({
    kind: 'payment', id: p.id, title: p.label, detail: `•••• ${p.last4} · ${p.expiry}`
  })));
  el.cardsEmpty.hidden = data.payments.length > 0;
}

function host(origin) {
  try { return new URL(origin).host; } catch { return origin; }
}

function button(text, className = 'ghost-btn') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  return b;
}

function row({ kind, id, title, site, detail }) {
  const root = document.createElement('div');
  root.className = 'row';

  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = title;
  const hint = document.createElement('span');
  hint.className = 'row-hint';
  hint.textContent = detail;
  text.append(label, hint);
  if (site) root.append(siteChip(site));

  const controls = document.createElement('div');
  controls.className = 'row-control';

  const secret = document.createElement('span');
  secret.className = 'secret';
  secret.hidden = true;

  // Show, then Hide: the secret is fetched on the press and forgotten on hide.
  const reveal = button('Show');
  reveal.addEventListener('click', async () => {
    if (!secret.hidden) {
      secret.hidden = true;
      secret.textContent = '';
      reveal.textContent = 'Show';
      return;
    }
    const res = await ask('reveal-credential', { kind, id });
    if (!res) return;
    secret.textContent = kind === 'login' ? res.password : spaced(res.number);
    secret.hidden = false;
    reveal.textContent = 'Hide';
  });

  const copy = button('Copy');
  copy.addEventListener('click', async () => {
    const res = await ask('reveal-credential', { kind, id });
    if (!res) return;
    try {
      await navigator.clipboard.writeText(kind === 'login' ? res.password : res.number);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    } catch {
      copy.textContent = 'Could not copy';
    }
  });

  // Delete takes two presses, as Clear does on History.
  const remove = button('Delete', 'ghost-btn danger');
  let armed = null;
  remove.addEventListener('click', async () => {
    if (!armed) {
      remove.textContent = 'Delete?';
      armed = setTimeout(() => { armed = null; remove.textContent = 'Delete'; }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    await ask('delete-credential', { kind, id });
    load();
  });
  remove.addEventListener('blur', () => {
    if (!armed) return;
    clearTimeout(armed);
    armed = null;
    remove.textContent = 'Delete';
  });

  if (kind === 'payment') {
    const fill = button('Fill');
    fill.title = 'Put this card into the page you were on before this one';
    fill.addEventListener('click', async () => {
      const ok = await ask('fill-payment', { id });
      fill.textContent = ok ? 'Filled' : 'No page to fill';
      setTimeout(() => { fill.textContent = 'Fill'; }, 1500);
    });
    controls.append(fill);
  }
  controls.append(reveal, copy, remove);

  const body = document.createElement('div');
  body.className = 'row-body';
  body.append(text, secret);
  root.append(body, controls);
  return root;
}

const spaced = (number) => String(number || '').replace(/(\d{4})(?=\d)/g, '$1 ');

/* ------------------------------------------------------------------ */
/* Adding a card                                                       */
/* ------------------------------------------------------------------ */

// MM/YY as it is typed: the slash goes in by itself.
$('card-expiry').addEventListener('input', (event) => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 4);
  event.target.value = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
});

el.cardForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const card = {
    label: $('card-label').value.trim(),
    number: $('card-number').value.replace(/[\s-]/g, ''),
    expiry: $('card-expiry').value.trim(),
    holder: $('card-holder').value.trim()
  };
  if (!/^[0-9]{12,19}$/.test(card.number)) { el.cardError.textContent = 'The card number is 12 to 19 digits.'; return; }
  if (!/^(0[1-9]|1[0-2])\/[0-9]{2}$/.test(card.expiry)) { el.cardError.textContent = 'The expiry is MM/YY.'; return; }
  const saved = await ask('save-payment', card);
  if (saved === null) return;
  if (!saved) { el.cardError.textContent = 'Could not save that card.'; return; }
  el.cardError.textContent = '';
  el.cardForm.reset();
  el.addCard.open = false;
  load();
});

/* ------------------------------------------------------------------ */

el.query.addEventListener('input', render);
clearOnEscape(el.query);
el.close.addEventListener('click', () => api.send('close-tab'));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.defaultPrevented) api.send('close-tab');
});

api.onState((state) => applyThemePrefs(state.prefs));

// Locking happens in the browser, on a timer; the page finds out when it looks.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 30_000);

watchTransientInput(api);
refresh();
