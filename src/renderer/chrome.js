'use strict';

/**
 * Browser chrome logic.
 *
 * State arrives from the governor on every tick and on every tab event, so
 * this file is written to make an update cheap: tab elements are keyed and
 * reused, individual properties are written only when they actually changed,
 * and the memory meter animates via a transform so a tick never causes layout.
 * A browser UI that repaints its whole tab strip twice a second would undo a
 * good part of what the governor saves.
 */

const api = window.debrowser;

// Tells the stylesheet how much room the system's window buttons need on the
// right. Set before first paint rather than on load, so the strip is never laid
// out once without the gutter and then reflowed with it.
if (api && api.platform) document.body.dataset.platform = api.platform;

/**
 * How long the pointer must rest on a tab before its renderer is rebuilt
 * speculatively. Long enough that sweeping across the strip costs nothing,
 * short enough to still be ahead of the click.
 */
const HOVER_DWELL_MS = 150;

const el = {
  tabs: document.getElementById('tabs'),
  newTab: document.getElementById('new-tab'),
  back: document.getElementById('back'),
  forward: document.getElementById('forward'),
  reload: document.getElementById('reload'),
  url: document.getElementById('url'),
  scheme: document.getElementById('scheme'),
  meter: document.getElementById('meter'),
  meterFill: document.getElementById('meter-fill'),
  meterText: document.getElementById('meter-text'),
  menu: document.getElementById('menu'),
  reloadIcon: document.getElementById('reload-icon')
};

/**
 * The reload button's two glyphs, as path data.
 *
 * Swapping `d` rather than the button's text, which is what this used to do:
 * the button holds an SVG now, and writing `textContent` on it would delete the
 * icon and leave a bare character behind for the rest of the session.
 */
const RELOAD_PATHS = {
  reload: ['M13.5 8a5.5 5.5 0 1 1-1.6-3.9', 'M13.5 2v3.2h-3.2'],
  stop: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7']
};

/** Keyed tab elements, so an update never rebuilds the strip. */
const tabEls = new Map();

/** True while the user is editing the address bar; we must not overwrite it. */
let urlFocused = false;
let lastActiveId = null;
/** What the reload button currently shows, so it is only rewritten on a change. */
let reloadShows = null;

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderTabs(tabs) {
  const seen = new Set();

  tabs.forEach((tab, index) => {
    seen.add(tab.id);
    let node = tabEls.get(tab.id);

    if (!node) {
      node = createTabElement(tab.id);
      tabEls.set(tab.id, node);
    }

    // Keep DOM order in sync with tab order without touching untouched nodes.
    const current = el.tabs.children[index];
    if (current !== node.root) el.tabs.insertBefore(node.root, current || null);

    updateTabElement(node, tab);
  });

  for (const [id, node] of tabEls) {
    if (!seen.has(id)) {
      node.root.remove();
      tabEls.delete(id);
    }
  }
}

function createTabElement(id) {
  const root = document.createElement('div');
  root.className = 'tab';

  const tier = document.createElement('span');
  tier.className = 'tier';

  const favicon = document.createElement('img');
  favicon.className = 'tab-favicon';
  favicon.alt = '';
  favicon.hidden = true;

  const audio = document.createElement('span');
  audio.className = 'audio-dot';
  audio.textContent = '▶';
  audio.hidden = true;

  const title = document.createElement('span');
  title.className = 'tab-title';

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close tab');

  root.append(tier, favicon, title, audio, close);

  root.addEventListener('mousedown', (event) => {
    if (event.button === 1) { api.send('close-tab', { id }); return; }
    if (event.button === 0) api.send('activate-tab', { id });
  });

  // Start restoring a discarded tab while the pointer is still on its way to
  // the click. A restore takes long enough to be worth the head start, and the
  // dwell is what keeps it from firing on every tab the pointer crosses on the
  // way somewhere else - which, on a strip of thirty, would rebuild renderers
  // faster than the governor reclaims them.
  let dwell = null;
  const cancelDwell = () => { clearTimeout(dwell); dwell = null; };
  root.addEventListener('pointerenter', () => {
    cancelDwell();
    dwell = setTimeout(() => api.send('prefetch-tab', { id }), HOVER_DWELL_MS);
  });
  root.addEventListener('pointerleave', cancelDwell);
  // A click has already asked for the real thing; the speculation is redundant.
  root.addEventListener('mousedown', cancelDwell);
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    api.send('close-tab', { id });
  });

  return { root, tier, favicon, title, audio, close, state: {} };
}

/** Write only what changed - the cheapest update is the one we skip. */
function updateTabElement(node, tab) {
  const prev = node.state;

  if (prev.title !== tab.title) {
    node.title.textContent = tab.title || 'New tab';
    node.root.title = `${tab.title || ''}\n${tab.url || ''}`;
    prev.title = tab.title;
  }

  if (prev.favicon !== tab.favicon) {
    if (tab.favicon) { node.favicon.src = tab.favicon; node.favicon.hidden = false; }
    else node.favicon.hidden = true;
    prev.favicon = tab.favicon;
  }

  if (prev.tier !== tab.tier) {
    node.tier.dataset.tier = tab.tier;
    node.tier.title = tierLabel(tab);
    prev.tier = tab.tier;
  }

  if (prev.active !== tab.visible) {
    node.root.classList.toggle('active', tab.visible);
    prev.active = tab.visible;
  }

  if (prev.boosted !== tab.boosted) {
    node.root.classList.toggle('boosted', tab.boosted);
    prev.boosted = tab.boosted;
  }

  if (prev.audible !== tab.audible) {
    node.audio.hidden = !tab.audible;
    prev.audible = tab.audible;
  }
}

function tierLabel(tab) {
  switch (tab.tier) {
    case 'active': return tab.boosted ? 'Active - boosted for animation' : 'Active';
    case 'warm': return `Background - ${tab.rssMB}MB`;
    case 'cold': return `Idle, may be discarded to save memory - ${tab.rssMB}MB`;
    case 'frozen': return `Frozen - no CPU, ${tab.rssMB}MB retained`;
    case 'hibernated': return 'Hibernated - memory compressed, opens instantly';
    case 'discarded': return 'Discarded - reloads when opened';
    default: return tab.tier;
  }
}

function renderToolbar(state) {
  const active = state.tabs.find((tab) => tab.visible);

  if (active && !urlFocused && active.url !== el.url.value) {
    // Only rewrite the address when the tab actually changed or navigated,
    // never mid-edit.
    if (active.id !== lastActiveId || document.activeElement !== el.url) {
      setAddress(active.url);
    }
  }
  if (active) lastActiveId = active.id;

  el.back.disabled = !active?.canGoBack;
  el.forward.disabled = !active?.canGoForward;

  const shows = active?.loading ? 'stop' : 'reload';
  if (shows !== reloadShows) {
    const paths = el.reloadIcon.querySelectorAll('path');
    RELOAD_PATHS[shows].forEach((d, i) => paths[i].setAttribute('d', d));
    el.reload.title = shows === 'stop' ? 'Stop' : 'Reload (Ctrl+R)';
    reloadShows = shows;
  }
}


function setAddress(url) {
  try {
    const parsed = new URL(url);
    el.scheme.textContent = parsed.protocol === 'https:' ? '\u{1F512}' : '';
    el.url.value = url;
  } catch {
    el.scheme.textContent = '';
    el.url.value = url || '';
  }
}

function renderMeter(state) {
  const ratio = state.budgetMB ? state.totalMB / state.budgetMB : 0;
  el.meterFill.style.transform = `scaleX(${Math.min(1, Math.max(0, ratio))})`;
  el.meter.dataset.pressure = state.pressure;
  el.meterText.textContent = `${state.totalMB} MB`;
  el.meter.title =
    `${state.totalMB} MB of ${state.budgetMB} MB budget\n` +
    `${state.liveTabs}${state.maxLiveTabs ? `/${state.maxLiveTabs}` : ''} tabs holding a renderer ` +
    `(${state.rendererCount} process(es)), ${state.tabs.length} tab(s) open\n` +
    `Pressure: ${state.pressure} - click for the task manager`;
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

el.newTab.addEventListener('click', () => api.send('new-tab'));
el.back.addEventListener('click', () => api.send('back'));
el.forward.addEventListener('click', () => api.send('forward'));
el.reload.addEventListener('click', () => api.send(reloadShows === 'stop' ? 'stop' : 'reload'));
el.meter.addEventListener('click', () => api.send('toggle-panel'));

// The menu is drawn by the OS, which cannot see where the button is. Send the
// button's bottom-left corner so the menu hangs off it the way a menu attached
// to a control should, rather than appearing wherever the pointer happened to be.
el.menu.addEventListener('click', () => {
  const box = el.menu.getBoundingClientRect();
  api.send('open-menu', { x: Math.round(box.left), y: Math.round(box.bottom) });
});

el.url.addEventListener('focus', () => { urlFocused = true; el.url.select(); });
el.url.addEventListener('blur', () => { urlFocused = false; });

el.url.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    api.send('navigate', { url: el.url.value });
    el.url.blur();
  } else if (event.key === 'Escape') {
    el.url.blur();
  }
});

window.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return;

  switch (event.key.toLowerCase()) {
    case 't': api.send('new-tab'); break;
    case 'w': api.send('close-tab'); break;
    case 'r': api.send('reload'); break;
    case 'l': el.url.focus(); break;
    case 'm': api.send('toggle-panel'); break;
    case ',': api.send('open-settings'); break;
    default: return;
  }
  event.preventDefault();
});

api.onState((state) => {
  applyThemePrefs(state.prefs);
  renderTabs(state.tabs);
  renderToolbar(state);
  renderMeter(state);
});
