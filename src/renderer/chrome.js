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
  schemePaths: ['scheme-a', 'scheme-b', 'scheme-c'].map((id) => document.getElementById(id)),
  meter: document.getElementById('meter'),
  meterFill: document.getElementById('meter-fill'),
  meterText: document.getElementById('meter-text'),
  menu: document.getElementById('menu'),
  reloadIcon: document.getElementById('reload-icon'),
  progress: document.getElementById('progress'),
  star: document.getElementById('star'),
  bookmarks: document.getElementById('bookmarks'),
  downloads: document.getElementById('downloads'),
  downloadsRing: document.getElementById('downloads-ring'),
  pin: document.getElementById('pin'),
  omnibox: document.getElementById('omnibox')
};

// The whole pill focuses the address bar, not just the text inside it.
//
// The input is 20px tall inside a 32px pill, so six pixels along the top and
// bottom of the widest control in the browser did nothing at all when clicked -
// which reads as the address bar ignoring you rather than as a near miss.
el.omnibox.addEventListener('mousedown', (event) => {
  if (event.target === el.url) return;      // let the caret land where it was aimed
  event.preventDefault();                   // no focus flash on the pill itself
  el.url.focus();
  el.url.select();
});

/** Whether the loading line is currently running, so it is only re-armed on a change. */
let progressRunning = null;

/**
 * Whether the page in front of the user is bookmarked.
 *
 * Asked of the browser rather than tracked here, because the list can change
 * from Settings - an import or a deletion has to move the star, and a copy kept
 * in this renderer would go stale the moment it did.
 */
let starred = null;
let starUrl = null;

async function refreshStar(url) {
  if (!url) { setStar(false); starUrl = null; return; }
  if (url === starUrl) return;
  starUrl = url;
  const res = await api.request('list-bookmarks');
  const items = (res && res.items) || [];
  // Compared against the URL asked for, not the current one: the answer may
  // arrive after the user has moved on, and applying it then would light the
  // star for the wrong page.
  if (starUrl === url) setStar(items.some((b) => b.url === url));
}

function setStar(on) {
  if (on === starred) return;
  starred = on;
  el.star.classList.toggle('on', Boolean(on));
  el.star.title = on ? 'Remove bookmark' : 'Bookmark this page (Ctrl+D)';
}

/* ------------------------------------------------------------------ */
/* The sliding side strip                                              */
/* ------------------------------------------------------------------ */

/**
 * Tell the browser when the pointer is over the strip.
 *
 * Unpinned, the strip's *view* is ten pixels wide until the pointer reaches it,
 * and the whole width once it has - so this is what drives the slide. It has to
 * come from here because the view is what the pointer enters and leaves, and a
 * view is the only thing that can be told either.
 *
 * Sent on change only. `mouseenter` fires once per entry and `mouseleave` once
 * per exit, but a page that reloads its own layout can produce a burst of them,
 * and this is a message to another process.
 */
let pointerOver = null;

function reportHover(over) {
  if (over === pointerOver) return;
  pointerOver = over;
  api.send('sidebar-hover', { over });
}

document.addEventListener('mouseenter', () => reportHover(true));
document.addEventListener('mouseleave', () => reportHover(false));
// `mousemove` as well, because entering a view the pointer is *already* inside
// - which is what happens when the strip slides out from under it - does not
// fire `mouseenter`.
document.addEventListener('mousemove', () => reportHover(true));

el.pin.addEventListener('click', () => api.send('toggle-sidebar-pin'));

/**
 * Whether the strip is pinned, and whether it is currently out.
 *
 * Both come from the browser: the first is a preference it owns, and the second
 * is a property of the *window*, since what slides is the view's width. The
 * strip only draws itself to match.
 */
function renderSidebar(sidebar) {
  const side = Boolean(sidebar);
  if (document.body.dataset.sidebar !== String(side)) {
    document.body.dataset.sidebar = String(side);
  }
  if (!side) return;

  const pinned = sidebar.pinned === true;
  if (el.pin.getAttribute('aria-pressed') !== String(pinned)) {
    el.pin.setAttribute('aria-pressed', String(pinned));
    el.pin.title = pinned ? 'Let the tab strip slide away' : 'Keep the tab strip open';
    el.pin.setAttribute('aria-label', el.pin.title);
  }
  // The contents are faded out rather than removed while the strip is a
  // ten-pixel edge: at that width they would be a column of clipped glyphs,
  // and rebuilding them on every slide would be work for something the pointer
  // opens and closes by accident all day.
  const open = sidebar.open === true;
  if (document.body.dataset.sidebarOpen !== String(open)) {
    document.body.dataset.sidebarOpen = String(open);
  }
}

/* ------------------------------------------------------------------ */
/* The downloads button                                                */
/* ------------------------------------------------------------------ */

/**
 * A count and a fraction, from the state broadcast.
 *
 * The list itself never comes through here - the flyout asks for it when it
 * opens, which is the only moment anyone can read it. See
 * `DownloadManager#summary`.
 */
function renderDownloadsButton(summary) {
  const count = summary ? summary.count : 0;
  // Hidden until there is something to show, as Chrome and Edge both do it. A
  // button that does nothing for the first hour of a session is a button in
  // the way of the ones that do.
  const hide = count === 0;
  if (el.downloads.hidden !== hide) el.downloads.hidden = hide;
  if (hide) return;

  const active = summary.active > 0;
  if (el.downloads.dataset.active !== String(active)) {
    el.downloads.dataset.active = String(active);
  }

  // A transform, so a download updating twice a second never lays out the
  // toolbar. An indeterminate one - no server-declared size - leaves the ring
  // empty rather than sitting at zero, which would read as stalled.
  const part = active && typeof summary.progress === 'number' ? summary.progress : 0;
  el.downloadsRing.style.transform = `scaleX(${part})`;
}

/** The flyout anchors to this button, so the chrome is what measures it. */
function openDownloads() {
  if (el.downloads.hidden) {
    // Nothing to fly out over. The page is still the right answer for someone
    // who pressed Ctrl+J on purpose.
    api.send('open-downloads-page');
    return;
  }
  const rect = el.downloads.getBoundingClientRect();
  api.send('open-downloads', {
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
    right: Math.round(rect.right)
  });
}

el.downloads.addEventListener('click', openDownloads);

/* ------------------------------------------------------------------ */
/* The bookmarks bar                                                   */
/* ------------------------------------------------------------------ */

/**
 * Redrawn when the browser says the list changed, and not otherwise.
 *
 * The state broadcast reaches this view on every governor tick, and it carries
 * a revision number rather than the bookmarks themselves - so the list crosses
 * the process boundary when the user adds or removes one, not twice a second
 * for the life of the window.
 */
let bookmarksRevision = null;

/** Titles are trimmed to a few words: a bar is a row of labels, not a list. */
const BOOKMARK_LABEL_MAX = 22;

async function refreshBookmarks(revision) {
  if (revision === bookmarksRevision) return;
  bookmarksRevision = revision;
  const res = await api.request('list-bookmarks');
  // Only if nothing has changed again while we were asking.
  if (revision === bookmarksRevision) renderBookmarks((res && res.items) || []);
}

function renderBookmarks(items) {
  const bar = document.createDocumentFragment();

  for (const item of items) {
    const button = document.createElement('button');
    button.className = 'bookmark';
    button.type = 'button';
    button.title = `${item.title || item.url}\n${item.url}`;

    const chip = document.createElement('span');
    chip.className = 'bookmark-chip';
    chip.setAttribute('aria-hidden', 'true');
    const host = siteOf(item.url);
    chip.textContent = (host.replace(/^[^a-z0-9]+/i, '')[0] || '?');
    chip.style.setProperty('--hue', String(siteHue(host)));

    // The site's own logo over its letter, through the browser's icon route -
    // never fetched by this page, which would send this session's cookies to
    // every bookmarked site every time the window opened. See icons.js.
    const src = iconSrc(item.icon || defaultIconFor(item.url));
    if (src) {
      const icon = document.createElement('img');
      icon.className = 'bookmark-icon';
      icon.alt = '';
      icon.decoding = 'async';
      icon.src = src;
      icon.addEventListener('load', () => chip.classList.add('has-icon'));
      icon.addEventListener('error', () => icon.remove());
      chip.append(icon);
    }

    const label = document.createElement('span');
    label.className = 'bookmark-label';
    const text = item.title || host;
    label.textContent = text.length > BOOKMARK_LABEL_MAX
      ? `${text.slice(0, BOOKMARK_LABEL_MAX - 1).trimEnd()}…`
      : text;

    button.append(chip, label);

    // Same three gestures a bookmark has in any browser.
    button.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey) api.send('new-tab', { url: item.url });
      else api.send('navigate', { url: item.url });
    });
    button.addEventListener('auxclick', (event) => {
      if (event.button === 1) api.send('new-tab', { url: item.url });
    });

    bar.append(button);
  }

  el.bookmarks.replaceChildren(bar);
  el.bookmarks.classList.toggle('empty', items.length === 0);
}

/** Where a site's icon is if it never said - the address Chromium would try. */
function defaultIconFor(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

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
  // Decoded off the main thread. The strip is the one renderer that must stay
  // responsive while a page is busy, and a synchronous decode of a 128px PNG in
  // the middle of a tab switch is exactly the kind of hitch that shows.
  favicon.decoding = 'async';

  // Shown until a favicon arrives, and for good on the many sites that never
  // send one. Both elements exist for the life of the tab and one of them is
  // hidden: swapping which element is in the DOM would relayout the strip every
  // time an icon loaded.
  const chip = document.createElement('span');
  chip.className = 'tab-chip';
  chip.setAttribute('aria-hidden', 'true');

  // One 15px box holding both, stacked rather than side by side: the letter is
  // underneath until an icon replaces it, and the spinner replaces both while
  // the page loads. Laying them out in a row instead would move the title every
  // time an icon arrived.
  const icon = document.createElement('span');
  icon.className = 'tab-icon';
  icon.append(chip, favicon);

  /*
   * An icon that does not load falls back to the letter, rather than to a
   * broken image.
   *
   * This is not an edge case. Chromium reports a favicon URL for *every* page:
   * measured, a page that declares no icon at all still arrives here as
   * `<origin>/favicon.ico`, because that is the address Chromium would try.
   * Plenty of sites do not serve it. Without this the strip showed a broken
   * image where the site's logo should be - worse than the letter it replaced,
   * and the reason tabs looked wrong.
   */
  favicon.addEventListener('error', () => {
    favicon.hidden = true;
    icon.classList.remove('has-icon');
  });

  /*
   * And the chip goes away when one *does* load.
   *
   * The two are stacked, and the original comment claimed the icon "covers" the
   * letter underneath. It does not. Nearly every favicon is a transparent PNG
   * or SVG, and `object-fit: contain` letterboxes the ones that are not square,
   * so the hue-coloured square and its initial showed through and around every
   * site logo in the browser - Gmail's M sitting on a green tile with a `g`
   * behind it. The chip is a *fallback*, so it has to stop painting once it has
   * been replaced.
   *
   * A class rather than `chip.hidden = true`. Both work now - theme.css carries
   * an author-level `[hidden]` rule, added after that collision turned up in
   * three more places - but this is a state with a transition on it, and a
   * class is what a state should be.
   */
  favicon.addEventListener('load', () => icon.classList.add('has-icon'));

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

  root.append(tier, icon, title, audio, close);

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
  // Stopped on `mousedown`, not only on `click`.
  //
  // The tab root listens on mousedown, which fires first - so pressing x sent
  // `activate-tab` before `close-tab` ever ran. On a discarded tab that rebuilt
  // the renderer and started a page load purely so it could be torn down a
  // moment later, which is the exact opposite of what this browser is for.
  close.addEventListener('mousedown', (event) => event.stopPropagation());
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    api.send('close-tab', { id });
  });

  return { root, tier, icon, favicon, chip, title, audio, close, state: {} };
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
    // Through the browser's icon route, never at the site: see `iconSrc`.
    const src = iconSrc(tab.favicon);
    // Back to the letter until this one decodes. Without the reset a tab that
    // navigates from a site with an icon to one without keeps showing the old
    // site's chip state, which is the previous page's identity on this page.
    node.icon.classList.remove('has-icon');
    if (src) {
      // The letter shows during the fetch rather than a gap, and the `load`
      // handler swaps it out; the `error` handler leaves it in place.
      node.favicon.src = src;
      node.favicon.hidden = false;
    } else {
      node.favicon.removeAttribute('src');
      node.favicon.hidden = true;
    }
    prev.favicon = tab.favicon;
  }

  // The chip only changes when the site does, which is far less often than the
  // URL: a page moving between paths on one host keeps its letter and colour,
  // and rewriting them on every navigation would be work for no visible change.
  const host = siteOf(tab.url);
  if (prev.host !== host) {
    node.chip.textContent = (host.replace(/^[^a-z0-9]+/i, '')[0] || '?');
    node.chip.style.setProperty('--hue', String(siteHue(host)));
    prev.host = host;
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

  // The spinner is Chrome's, and it belongs in the tab rather than only in the
  // line under the toolbar: with twenty tabs open and three of them loading, a
  // single bar at the top says that *something* is loading and not which.
  if (prev.loading !== tab.loading) {
    node.root.dataset.loading = tab.loading ? 'on' : 'off';
    prev.loading = tab.loading;
  }
}

/** The site a tab is on, for the fallback chip's letter and colour. */
function siteOf(url) {
  try {
    const parsed = new URL(url);
    // The browser's own pages are one "site" as far as this is concerned, so
    // Settings and the new tab page do not each get a colour of their own.
    if (parsed.protocol === 'debrowser:') return 'debrowser';
    return parsed.hostname.replace(/^www\./, '') || parsed.protocol;
  } catch {
    return '';
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

  // Only touched when it actually changes. This runs on every state broadcast,
  // twice a second, and restarting a CSS animation on each one would keep the
  // line pinned at its first frame forever - which is a bar that never moves,
  // the one thing worse than no bar.
  const loading = Boolean(active?.loading);
  if (loading !== progressRunning) {
    progressRunning = loading;
    if (loading) {
      // Rewind before re-arming. Removing and re-adding a class in the same
      // frame is coalesced away, so without forcing a reflow between them a
      // second navigation would resume the first one's animation part-way.
      el.progress.classList.remove('loading', 'done');
      void el.progress.offsetWidth;
      el.progress.classList.add('loading');
    } else {
      el.progress.classList.remove('loading');
      el.progress.classList.add('done');
    }
  }

  refreshStar(active && !active.internal ? active.url : null);

  const shows = active?.loading ? 'stop' : 'reload';
  if (shows !== reloadShows) {
    const paths = el.reloadIcon.querySelectorAll('path');
    RELOAD_PATHS[shows].forEach((d, i) => paths[i].setAttribute('d', d));
    el.reload.title = shows === 'stop' ? 'Stop' : 'Reload (Ctrl+R)';
    reloadShows = shows;
  }
}


/**
 * What the padlock says, as path data.
 *
 * Three slots because the widest glyph needs three; a shorter one leaves the
 * rest empty rather than adding and removing elements on every navigation.
 */
const SCHEME_GLYPHS = {
  secure: ['M4.6 7.4h6.8v5.1H4.6z', 'M6.2 7.4V5.9a1.8 1.8 0 0 1 3.6 0v1.5', ''],
  insecure: ['M8 2.9a5.1 5.1 0 1 0 0 10.2 5.1 5.1 0 0 0 0-10.2z', 'M8 5.3v3.5', 'M8 10.7h.01']
};

/** What the indicator currently shows, so it is only rewritten on a change. */
let schemeShows = null;

/*
 * Shown and hidden by `data-kind`, never by the `hidden` property.
 *
 * This is an <svg>, and `hidden` is defined on HTMLElement - SVGElement does
 * not have it. Measured: `'hidden' in svg` is false, so `svg.hidden = false`
 * silently defines an expando and never touches the attribute, and Chromium's
 * UA `[hidden] { display: none }` rule does not apply to SVG either, so the
 * attribute that *was* in the markup did nothing.
 *
 * Both halves of that cancelled out into a real fault: the indicator could be
 * set but never cleared, so a padlock drawn on the last website stayed on
 * screen when the user moved to `debrowser://settings` - an encrypted-
 * connection claim on a page that has no connection at all. A security
 * indicator that can lie in the reassuring direction is worse than none.
 *
 * So the paths are cleared as well as the element hidden. Either alone would
 * do it; both, because this is the one element in the browser where being
 * wrong is not a cosmetic bug.
 */
function setScheme(kind) {
  if (kind === schemeShows) return;
  schemeShows = kind;

  if (!kind) {
    delete el.scheme.dataset.kind;
    el.scheme.removeAttribute('aria-label');
    for (const path of el.schemePaths) path.removeAttribute('d');
    return;
  }

  el.scheme.dataset.kind = kind;
  SCHEME_GLYPHS[kind].forEach((d, i) => {
    if (d) el.schemePaths[i].setAttribute('d', d);
    else el.schemePaths[i].removeAttribute('d');
  });
  el.scheme.setAttribute('aria-label',
    kind === 'secure' ? 'Connection is encrypted' : 'Connection is not encrypted');
}

function setAddress(url) {
  try {
    const parsed = new URL(url);
    // Nothing at all for the browser's own pages: they are not a connection,
    // and a padlock on Settings would be claiming something that has no
    // meaning there.
    if (parsed.protocol === 'https:') setScheme('secure');
    else if (parsed.protocol === 'http:') setScheme('insecure');
    else setScheme(null);
    el.url.value = url;
  } catch {
    setScheme(null);
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
    `${state.liveTabs} tabs holding a renderer ` +
    `(${state.rendererCount} process(es)), ${state.tabs.length} tab(s) open\n` +
    `Pressure: ${state.pressure} - click for the task manager`;
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

el.newTab.addEventListener('click', () => api.send('new-tab'));

/*
 * Start the renderer while the pointer is still on its way.
 *
 * Measured: a new tab page costs 79ms when no page of the browser's own is
 * live, and 46ms when the renderer is already up - and every page the browser
 * serves itself shares one, so warming it on the way to the + also covers
 * Settings and History from the menu. The same dwell as the tab strip's
 * speculation, and for the same reason: sweeping the pointer across the
 * toolbar must not start a renderer.
 */
for (const button of [el.newTab, el.menu]) {
  let dwell = null;
  const cancel = () => { clearTimeout(dwell); dwell = null; };
  button.addEventListener('pointerenter', () => {
    cancel();
    dwell = setTimeout(() => api.send('prefetch-new-tab'), HOVER_DWELL_MS);
  });
  button.addEventListener('pointerleave', cancel);
  // The click has asked for the real thing; the guess is redundant now.
  button.addEventListener('mousedown', cancel);
}
el.back.addEventListener('click', () => api.send('back'));
el.forward.addEventListener('click', () => api.send('forward'));
el.reload.addEventListener('click', () => api.send(reloadShows === 'stop' ? 'stop' : 'reload'));

el.star.addEventListener('click', async () => {
  const res = await api.request('toggle-bookmark');
  if (!res) return;
  // The browser decides, and says so. Toggling optimistically here would light
  // the star for a page that cannot be bookmarked at all - the store refuses
  // anything that is not http, https or one of our own pages.
  setStar(Boolean(res.bookmarked));
});
el.meter.addEventListener('click', () => api.send('toggle-panel'));

// The menu is drawn in a view of its own, which cannot see where the button is.
// Both edges are sent: the menu is eight times the button's width and hangs off
// its *right* edge, so the left one alone would put it out past the window.
el.menu.addEventListener('click', () => {
  const box = el.menu.getBoundingClientRect();
  api.send('open-menu', {
    x: Math.round(box.left),
    y: Math.round(box.bottom),
    right: Math.round(box.right)
  });
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
    // The star's tooltip has advertised this since the star existed; it was
    // never bound, so the one discoverable way to learn the shortcut taught it
    // wrongly.
    case 'd': api.request('toggle-bookmark').then((res) => {
      if (res) setStar(Boolean(res.bookmarked));
    }); break;
    // Ctrl+Shift+B shows and hides the bookmarks bar, as it does everywhere
    // else. The browser owns the preference, so this asks rather than toggling
    // a class here - the window has to give the page its 34px back too.
    case 'b':
      if (event.shiftKey) api.send('toggle-bookmarks-bar');
      break;
    case ',': api.send('open-settings'); break;
    case 'h': api.send('open-history'); break;
    case 'j': openDownloads(); break;
    // Ctrl+Shift+I, the other half of F12. F12 itself needs no modifier and is
    // handled below.
    case 'i': if (event.shiftKey) api.send('toggle-devtools'); else return; break;
    default: return;
  }
  event.preventDefault();
});

// Unmodified keys, which the loop above deliberately ignores.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'F12') return;
  api.send('toggle-devtools');
  event.preventDefault();
});

api.onState((state) => {
  applyThemePrefs(state.prefs);
  renderTabs(state.tabs);
  renderToolbar(state);
  renderMeter(state);

  // The bar is hidden rather than emptied when it is off or when the strip runs
  // down the side: the window has already given its 34px back to the page, and
  // a bar drawn into space nobody reserved would sit over the top of it.
  renderDownloadsButton(state.downloads);
  renderSidebar(state.sidebar);
  document.body.classList.toggle('with-bookmarks', state.bookmarksBar !== false);
  if (state.bookmarksBar !== false) refreshBookmarks(state.bookmarksRevision);
});
