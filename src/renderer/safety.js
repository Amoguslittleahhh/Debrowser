'use strict';

/**
 * The safety check. One request for the state of everything, drawn as rows;
 * the only thing it changes itself is taking a site's permissions away.
 */

const api = window.debrowser;
const $ = (id) => document.getElementById(id);

const KIND_NAMES = { camera: 'camera', microphone: 'microphone', location: 'location', notifications: 'notifications' };

function row({ state = 'ok', label, detail = '', action = null }) {
  const el = document.createElement('div');
  el.className = 'row';
  const dot = document.createElement('span');
  dot.className = `dot ${state === 'ok' ? '' : state}`;
  const text = document.createElement('div');
  text.className = 'text';
  const name = document.createElement('span');
  name.className = 'label';
  name.textContent = label;
  text.append(name);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'detail';
    d.textContent = detail;
    text.append(d);
  }
  el.append(dot, text);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.text;
    b.addEventListener('click', () => action.run(b));
    el.append(b);
  }
  return el;
}

const toSettings = { text: 'Change', run: () => api.send('open-settings', { section: 'browsing' }) };
const since = (ms) => {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

async function load() {
  const s = await api.request('safety-status');
  if (!s) return;

  $('browser').replaceChildren(
    row({ label: `Debrowser ${s.version}`, detail: `Built on Chromium ${s.chromium}` }),
    row({ state: s.autoUpdate ? 'ok' : 'off', label: s.autoUpdate ? 'Updates install automatically' : 'Updates aren’t automatic',
      detail: s.autoUpdate ? 'Chromium’s security fixes reach you as soon as a release carries them.'
        : 'Security fixes wait until you install an update yourself.',
      action: s.autoUpdate ? null : { text: 'Change', run: () => api.send('open-settings', { section: 'updates' }) } })
  );

  const off = s.protections.filter((p) => !p.on);
  $('protections').replaceChildren(...s.protections.map((p) => row({
    state: p.on ? 'ok' : 'off', label: p.label, detail: p.on ? (p.detail || 'On') : 'Off', action: p.on ? null : toSettings
  })));

  $('passwords').replaceChildren(row({
    state: s.passwords.configured ? 'ok' : 'off',
    label: s.passwords.configured ? 'Check your saved passwords' : 'Saved passwords are off',
    detail: s.passwords.configured ? 'Find the ones in data breaches, used twice, or weak.'
      : 'Set a passcode in Settings to save and fill passwords.',
    action: { text: 'Open', run: () => api.send('open-passwords') }
  }));

  $('permissions').replaceChildren(...s.permissions.map((p) => {
    const kinds = Object.keys(KIND_NAMES).filter((k) => p[k] === 'allow').map((k) => KIND_NAMES[k]);
    return row({
      label: new URL(p.origin).host,
      detail: `May use your ${kinds.join(', ')}` + (p.usedAt ? ` · last used ${since(p.usedAt)}` : ''),
      action: { text: 'Remove', run: async (b) => { await api.request('safety-revoke', { origin: p.origin }); b.closest('.row').remove(); } }
    });
  }));
  $('permissions-empty').hidden = s.permissions.length > 0;
  if (s.revoked.length) {
    $('revoked').hidden = false;
    $('revoked').textContent = `Removed by themselves from ${s.revoked.map((r) => new URL(r.origin).host).join(', ')}: ` +
      'not used for three months. They will ask again if they need to.';
  }

  $('summary').textContent = off.length
    ? `${off.length} protection${off.length === 1 ? ' is' : 's are'} off.`
    : 'Every protection is on.';
}

api.onState((state) => applyThemePrefs(state.prefs));
load();
window.addEventListener('focus', load);
