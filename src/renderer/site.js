'use strict';

/**
 * The site panel, under the padlock.
 *
 * Two faces, one sheet. When the site in front has asked for something, it
 * shows the question - Block or Allow, Enter for Allow, Escape or a click
 * away for "not now". Otherwise it shows what the padlock is about: the
 * connection, what this site has been allowed or refused, its zoom, and a way
 * to clear what it has stored.
 *
 * Everything it changes is about the active tab's own site. It never names a
 * site in what it sends; the browser takes the site from the tab.
 */

const api = window.debrowser;

const $ = (id) => document.getElementById(id);
const el = {
  sheet: $('sheet'), backdrop: $('backdrop'),
  ask: $('ask'), askHost: $('ask-host'), askKinds: $('ask-kinds'), allow: $('allow'), block: $('block'),
  info: $('info'), host: $('host'), connection: $('connection'), perms: $('perms'),
  privateNote: $('private-note'), zoomRow: $('zoom-row'), zoom: $('zoom'), zoomReset: $('zoom-reset'),
  clear: $('clear'), resetPerms: $('reset-perms')
};

const params = new URLSearchParams(location.search);
const anchor = { x: Number(params.get('x')) || 0, y: Number(params.get('y')) || 0 };

/** The four things a site can ask for, in the order they are listed. */
const KINDS = [
  ['camera', 'Use your camera', 'Camera',
    ['M2.5 5h7.5v6.5H2.5z', 'M10 7.2l3.5-2v6.1l-3.5-2']],
  ['microphone', 'Use your microphone', 'Microphone',
    ['M8 2.5a2 2 0 0 0-2 2v3a2 2 0 0 0 4 0v-3a2 2 0 0 0-2-2z', 'M4.5 7.5a3.5 3.5 0 0 0 7 0', 'M8 11v2.5']],
  ['location', 'Know your location', 'Location',
    ['M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14z', 'M8 5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z']],
  ['notifications', 'Show notifications', 'Notifications',
    ['M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1 1.5h-9z', 'M6.8 14h2.4']]
];

function icon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function item(paths, text) {
  const li = document.createElement('li');
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = text;
  li.append(icon(paths), label);
  return li;
}

const close = () => api.send('close-menu');

function showAsk(info) {
  el.askHost.textContent = info.host;
  for (const [kind, sentence, , paths] of KINDS) {
    if (info.ask.kinds.includes(kind)) el.askKinds.append(item(paths, sentence));
  }
  el.ask.hidden = false;
  el.allow.addEventListener('click', () => api.send('permission-answer', { allow: true }));
  el.block.addEventListener('click', () => api.send('permission-answer', { allow: false }));
  // The panel itself takes focus, not Allow: a site can ask on its own, and a
  // stray Enter or Space must not be the thing that grants it the camera.
  return el.sheet;
}

function showInfo(info) {
  el.host.textContent = info.host;
  el.connection.textContent = info.incognito
    ? 'Connected through Tor'
    : info.secure ? 'Connection is secure' : 'Connection isn’t secure';
  el.connection.classList.toggle('insecure', !info.secure && !info.incognito);

  // Only what this site has asked for. A list of four switches for a site
  // that never wanted any of them is four things to read for nothing.
  const decided = KINDS.filter(([kind]) => info.permissions[kind]);
  for (const [kind, , name, paths] of decided) {
    const li = item(paths, name);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = info.permissions[kind] === 'allow';
    box.setAttribute('aria-label', `Allow ${name.toLowerCase()}`);
    box.addEventListener('change', () => {
      api.send('site-permission', { kind, value: box.checked ? 'allow' : 'block' });
    });
    // The whole row toggles, not only the 17px box.
    li.addEventListener('click', (event) => { if (event.target !== box) box.click(); });
    li.append(box);
    el.perms.append(li);
  }
  el.perms.hidden = decided.length === 0;
  el.resetPerms.hidden = decided.length === 0;
  el.privateNote.hidden = !info.incognito;

  el.zoomRow.hidden = info.zoom === info.zoomDefault;
  el.zoom.textContent = `${info.zoom}%`;
  el.zoomReset.addEventListener('click', () => {
    api.send('zoom', { direction: 'reset' });
    el.zoomRow.hidden = true;
  });

  el.clear.hidden = info.incognito;
  // Two presses, as History's "Clear all" is: clearing signs you out of the
  // site, and there is no undo.
  let armed = false;
  el.clear.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      el.clear.textContent = 'Sign out and clear?';
      el.clear.classList.add('danger');
      return;
    }
    api.send('site-clear-data');
    el.clear.textContent = 'Cleared';
    el.clear.classList.remove('danger');
    el.clear.disabled = true;
    setTimeout(close, 700);
  });
  el.resetPerms.addEventListener('click', () => {
    for (const [kind] of decided) api.send('site-permission', { kind, value: null });
    el.perms.hidden = true;
    el.resetPerms.hidden = true;
  });

  const foot = el.clear.parentElement;
  foot.hidden = el.clear.hidden && el.resetPerms.hidden;
  el.resetPerms.addEventListener('click', () => { foot.hidden = el.clear.hidden; }, { once: true });

  el.info.hidden = false;
  return el.sheet;
}

async function load() {
  const info = await api.request('site-info');
  if (!info || (!info.website && !info.ask)) { close(); return; }
  const focus = info.ask ? showAsk(info) : showInfo(info);
  anchorSheet(el.sheet, anchor, 8, 'left');
  focus.focus();
}

el.backdrop.addEventListener('mousedown', close);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { close(); return; }
  if (event.key !== 'Tab') return;
  // The same focus loop as the other panels: Tab never leaves the sheet.
  const focusable = [...el.sheet.querySelectorAll('button:not([hidden]):not(:disabled), input')]
    .filter((node) => node.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === el.sheet)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
});

api.onState((state) => applyThemePrefs(state.prefs));
load();
