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
  info: $('info'), host: $('host'), connection: $('connection'), perms: $('perms'), shield: $('shield'),
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

  // The blocker, where there is one: on or off for this site, and what it
  // stopped on this page. Switching it reloads the page.
  if (info.blocking) {
    const li = item(['M8 1.8l5 1.9v3.9c0 3.2-2.2 5.6-5 6.6-2.8-1-5-3.4-5-6.6V3.7z'], 'Block ads and trackers');
    const count = document.createElement('small');
    count.className = 'count';
    count.textContent = info.blocking.on && info.blocking.blocked
      ? `${info.blocking.blocked} blocked on this page` : '';
    li.querySelector('.label').append(count);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = info.blocking.on;
    box.setAttribute('aria-label', 'Block ads and trackers on this site');
    box.addEventListener('change', () => {
      api.send('site-blocking', { on: box.checked });
      count.textContent = '';
    });
    li.addEventListener('click', (event) => { if (event.target !== box) box.click(); });
    li.append(box);
    el.shield.append(li);
    el.shield.hidden = false;
  }

  // Other sites' cookies: blocked unless let in for this site.
  if (info.thirdPartyCookies) {
    const li = item(['M8 2.2a5.8 5.8 0 1 0 5.8 5.8 2 2 0 0 1-2.3-2.3A2 2 0 0 1 9.2 3.4 2 2 0 0 1 8 2.2z',
      'M5.6 7.2h.01M8.4 10.6h.01M10.8 8.8h.01'], 'Block other sites’ cookies');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = info.thirdPartyCookies.blocked;
    box.setAttribute('aria-label', 'Block other sites’ cookies on this site');
    box.addEventListener('change', () => api.send('site-third-party', { allow: !box.checked }));
    li.addEventListener('click', (event) => { if (event.target !== box) box.click(); });
    li.append(box);
    el.shield.append(li);
    el.shield.hidden = false;
  }

  // Forget it on close: signed out, nothing kept, each time.
  if (info.forget !== null && info.forget !== undefined) {
    const li = item(['M3.5 4.5h9', 'M6.5 4.5V3h3v1.5', 'M4.5 4.5l.7 8.5h5.6l.7-8.5'], 'Forget this site when I close it');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = info.forget === true;
    box.setAttribute('aria-label', 'Forget this site when its last tab closes');
    box.addEventListener('change', () => api.send('site-forget', { on: box.checked }));
    li.addEventListener('click', (event) => { if (event.target !== box) box.click(); });
    li.append(box);
    el.shield.append(li);
    el.shield.hidden = false;
  }

  // What the user hid here, and their own style for the site.
  if (info.forget !== null && info.forget !== undefined) {
    const li = item(['M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z', 'M3 13L13 3'],
      info.hidden ? `${info.hidden} thing${info.hidden === 1 ? '' : 's'} hidden here` : 'Hide something on this page');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link';
    b.textContent = info.hidden ? 'Show again' : 'Choose';
    b.addEventListener('click', () => { api.send(info.hidden ? 'show-hidden' : 'hide-element'); close(); });
    li.append(b);
    el.shield.append(li);
    const style = item(['M3 13l1.2-3.6L11 2.6a1.7 1.7 0 0 1 2.4 2.4L6.6 11.8z'], info.styled ? 'Your style for this site' : 'Your own style for this site');
    const e = document.createElement('button');
    e.type = 'button';
    e.className = 'link';
    e.textContent = 'Edit';
    e.addEventListener('click', () => { api.send('open-site-style'); close(); });
    style.append(e);
    el.shield.append(style);
  }

  // How readily its tabs sleep. Kept awake: chat, music, a dashboard.
  if (info.sleep) {
    const li = item(['M12.5 9.6A5 5 0 0 1 6.4 3.5a5 5 0 1 0 6.1 6.1z'], 'Sleep when unused');
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'When this site’s tabs sleep');
    for (const [value, name] of [['normal', 'Normally'], ['early', 'Sooner'], ['never', 'Never']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = name;
      select.append(option);
    }
    select.value = info.sleep;
    select.addEventListener('change', () => api.send('site-sleep', { value: select.value }));
    li.append(select);
    el.shield.append(li);
    el.shield.hidden = false;
  }

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
