'use strict';

/**
 * Saved sign-ins and cards, behind the lock.
 *
 * Everything here is asked of the browser one request at a time, and the
 * browser answers `{ locked: true }` to any of them once the vault has locked
 * itself (five minutes without use; see src/main/data/vault.js). So the page never
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
  locked: $('locked'), lockedNote: $('locked-note'), presence: $('presence'), or: $('or'),
  passcode: $('passcode'), unlock: $('unlock'), unlockError: $('unlock-error'),
  open: $('open'), logins: $('logins'), loginsEmpty: $('logins-empty'),
  cards: $('cards'), cardsEmpty: $('cards-empty'),
  passkeys: $('passkeys'), passkeysSection: $('passkeys-section'),
  cardForm: $('card-form'), cardError: $('card-error'), addCard: $('add-card')
};

/** Show one state: 'off', 'unavailable', 'locked' or 'open'. */
function show(state) {
  for (const name of ['off', 'unavailable', 'locked', 'open']) el[name].hidden = name !== state;
  el.lock.hidden = state !== 'open';
  el.query.hidden = state !== 'open';
  if (state === 'locked') el.passcode.value = '';
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
    // Locked by time as well as by the button: a password shown before the
    // vault locked itself stayed in the page, hidden, until the next unlock.
    if (el.locked.hidden) { clearLists(); show('locked'); }
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
  el.or.hidden = !presence.available;
  // One primary action: Windows Hello where there is one, the passcode where
  // there is not. Focus goes to it, so Enter does the obvious thing - the
  // field took focus even beside Windows Hello, and its ring was the loudest
  // thing on the page.
  el.unlock.classList.toggle('primary', !presence.available);
  if (presence.available) el.presence.textContent = `Unlock with ${presence.mechanism}`;
  // Not on the half-minute check, while someone is typing their passcode.
  if (!el.locked.contains(document.activeElement)) {
    requestAnimationFrame(() => (presence.available ? el.presence : el.passcode).focus());
  }
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
  el.unlockError.textContent = 'That isn’t the passcode.';
  el.passcode.focus();
});

el.presence.addEventListener('click', async () => {
  el.presence.disabled = true;
  const res = await api.request('vault-unlock', { method: 'presence' });
  el.presence.disabled = false;
  if (res && res.ok) { el.unlockError.textContent = ''; refresh(); return; }
  el.unlockError.textContent = `${presence.mechanism} didn’t confirm it was you. Use the passcode instead.`;
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

let data = { logins: [], payments: [], passkeys: [] };

function clearLists() {
  data = { logins: [], payments: [], passkeys: [] };
  el.logins.replaceChildren();
  el.cards.replaceChildren();
  el.passkeys.replaceChildren();
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

const importButton = document.getElementById('import-logins');
const importNote = document.getElementById('import-note');
importButton.addEventListener('click', async () => {
  importButton.disabled = true;
  const res = await ask('import-logins-file');
  importButton.disabled = false;
  if (!res || res.cancelled) return;
  if (res.ok) {
    importNote.textContent = `Imported ${res.added} sign-in${res.added === 1 ? '' : 's'}. ` +
      'Now delete the file you imported from: it holds them in plain text.';
    importNote.classList.add('ok');
    await load();
  } else {
    importNote.textContent = `Couldn’t import: ${res.reason || 'that file didn’t work'}.`;
    importNote.classList.remove('ok');
  }
});

async function load() {
  const res = await ask('list-credentials');
  if (!res) return;
  data = { logins: res.logins || [], payments: res.payments || [], passkeys: res.passkeys || [] };
  render();
}

function render() {
  const needle = el.query.value.trim().toLowerCase();
  const hit = (...texts) => !needle || texts.some((t) => String(t || '').toLowerCase().includes(needle));

  const logins = data.logins.filter((l) => hit(l.origin, l.username));
  el.logins.replaceChildren(...logins.map((l) => row({
    kind: 'login', id: l.id, title: host(l.origin), site: l.origin, detail: l.username || '(no username)',
    flag: flagFor(checkup && checkup.results[l.id])
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

  // Only where Debrowser keeps passkeys itself (macOS, Linux), and has some.
  const passkeys = data.passkeys.filter((p) => hit(p.rpId, p.name, p.display));
  el.passkeys.replaceChildren(...passkeys.map((p) => row({
    kind: 'passkey', id: p.id, title: p.rpId, site: `https://${p.rpId}`,
    detail: p.name || p.display || 'Passkey'
  })));
  el.passkeysSection.hidden = data.passkeys.length === 0;
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

/* ------------------------------------------------------------------ */
/* The check-up                                                        */
/* ------------------------------------------------------------------ */

let checkup = null;

/** What a row says about its password after a check, worst first. */
function flagFor(result) {
  if (!result) return null;
  if (result.breached) {
    return { level: 'crit', text: `Found in ${result.breached.toLocaleString()} data breach${result.breached === 1 ? '' : 'es'} – change it` };
  }
  if (result.reused) return { level: 'warn', text: 'Used on more than one site' };
  if (result.weak) return { level: 'warn', text: 'Weak – easy to guess' };
  return null;
}

const checkButton = document.getElementById('check');
const checkNote = document.getElementById('checkup');
checkButton.addEventListener('click', async () => {
  checkButton.disabled = true;
  checkButton.textContent = 'Checking…';
  const res = await ask('check-passwords');
  checkButton.disabled = false;
  checkButton.textContent = 'Check passwords';
  if (!res) return;
  checkup = res;
  const all = Object.values(res.results);
  const breached = all.filter((r) => r.breached).length;
  const reused = all.filter((r) => !r.breached && r.reused).length;
  const weak = all.filter((r) => !r.breached && !r.reused && r.weak).length;
  const parts = [];
  if (breached) parts.push(`${breached} found in data breaches`);
  if (reused) parts.push(`${reused} used on more than one site`);
  if (weak) parts.push(`${weak} weak`);
  checkNote.textContent = (parts.length ? `${parts.join(', ')}.` : 'No problems found.') +
    (res.checked ? '' : ' Breaches couldn’t be checked: no connection.');
  checkNote.classList.toggle('ok', !parts.length && res.checked);
  checkNote.hidden = false;
  render();
});

function row({ kind, id, title, site, detail, flag = null }) {
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
  if (flag) {
    const note = document.createElement('span');
    note.className = `row-flag ${flag.level}`;
    note.textContent = flag.text;
    text.append(note);
  }
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
      copy.textContent = 'Couldn’t copy';
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
  // A passkey has nothing to show or copy - its key never leaves the browser.
  if (kind === 'passkey') controls.append(remove);
  else controls.append(reveal, copy, remove);

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
  if (!saved) { el.cardError.textContent = 'Couldn’t save that card.'; return; }
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
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  // Not mid-form: Escape in the card form or the passcode field (say, to
  // dismiss autofill) used to close the tab and lose what was typed.
  const t = event.target;
  if (t !== el.query && t.closest && t.closest('input, textarea, select, #card-form, #locked')) return;
  api.send('close-tab');
});

api.onState((state) => applyThemePrefs(state.prefs));

// Locking happens in the browser, on a timer; the page finds out when it looks.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 30_000);

watchTransientInput(api);
refresh();
