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
  site: document.getElementById('site'),
  schemePaths: ['scheme-a', 'scheme-b', 'scheme-c'].map((id) => document.getElementById(id)),
  meter: document.getElementById('meter'),
  meterFill: document.getElementById('meter-fill'),
  meterText: document.getElementById('meter-text'),
  menu: document.getElementById('menu'),
  reloadIcon: document.getElementById('reload-icon'),
  progress: document.getElementById('progress'),
  star: document.getElementById('star'),
  privatePill: document.getElementById('private'),
  onion: document.getElementById('onion'),
  slowJs: document.getElementById('slow-js'),
  privateText: document.getElementById('private-text'),
  bookmarks: document.getElementById('bookmarks'),
  downloads: document.getElementById('downloads'),
  downloadsRing: document.getElementById('downloads-ring'),
  pin: document.getElementById('pin'),
  omnibox: document.getElementById('omnibox'),
  findbar: document.getElementById('findbar'),
  findInput: document.getElementById('find-input'),
  findCount: document.getElementById('find-count'),
  findPrev: document.getElementById('find-prev'),
  findNext: document.getElementById('find-next'),
  findClose: document.getElementById('find-close')
};

// The whole pill focuses the address bar, not just the text inside it: the
// padding and the padlock are the pill's, and a click on them that did nothing
// would read as the address bar ignoring you rather than as a near miss.
el.omnibox.addEventListener('mousedown', (event) => {
  if (event.target === el.url) return;      // let the caret land where it was aimed
  if (el.site.contains(event.target)) return;   // the padlock is its own button
  event.preventDefault();                   // no focus flash on the pill itself
  el.url.focus();
  el.url.select();
});

/**
 * The site panel hangs from the padlock, a little below the address bar, its
 * left edge just left of the glyph. The browser opens it here too when a site
 * asks for something, so the question appears where the answer is kept.
 */
function openSite() {
  const pill = el.omnibox.getBoundingClientRect();
  const lock = el.site.getBoundingClientRect();
  api.send('open-site', {
    x: Math.round((lock.width ? lock.left : pill.left + 8) - 4),
    y: Math.round(pill.bottom + 6)
  });
}
el.site.addEventListener('click', openSite);

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
let starRevision = null;

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
  // A private window cannot save bookmarks - see renderPrivate.
  if (document.body.classList.contains('incognito')) {
    el.star.title = 'Bookmarks cannot be saved from a private window';
    return;
  }
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

// Collapsed, the chrome is the whole window under the page, so being over it
// is not the signal: only the edge opens the strip, never the toolbar above.
const EDGE = 12;
const TOP_BAND = 40;
const opens = (e) => document.body.dataset.compact !== 'true' || (e.clientX <= EDGE && e.clientY >= TOP_BAND);
document.addEventListener('mouseenter', (e) => reportHover(opens(e)));
document.addEventListener('mouseleave', () => reportHover(false));
// `mousemove` as well, because entering a view the pointer is *already* inside
// - which is what happens when the strip slides out from under it - does not
// fire `mouseenter`.
document.addEventListener('mousemove', (e) => reportHover(opens(e)));

/*
 * The wheel over the tab strip moves the strip.
 *
 * Across the top the strip scrolls sideways once the tabs stop shrinking, and
 * a mouse with one wheel has no sideways to give - so a vertical wheel is taken
 * as horizontal here, which is what every browser does over a tab strip. A
 * trackpad's horizontal swipe arrives as `deltaX` and is used directly.
 *
 * Down the side the strip scrolls vertically and the browser needs no help, so
 * this stands aside. Ctrl is never touched: that is the zoom gesture, and it
 * belongs to the page.
 */
el.tabs.addEventListener('wheel', (event) => {
  if (event.ctrlKey) return;
  if (document.body.dataset.layout === 'left') return;
  const by = event.deltaX || event.deltaY;
  if (!by) return;
  event.preventDefault();
  // Instant: the strip is `scroll-behavior: smooth`, and adding to a
  // scrollLeft that is still mid-animation dropped distance on every notch.
  el.tabs.scrollBy({ left: by, behavior: 'instant' });
}, { passive: false });

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
  if (!side) { document.body.dataset.compact = 'false'; return; }

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
  const compact = sidebar.compact === true;
  if (document.body.dataset.compact !== String(compact)) {
    document.body.dataset.compact = String(compact);
  }

  // Full screen: the strip is a panel drawn over the page rather than a column
  // beside it, so it stops filling its view and reports what it comes to
  // instead. See `reportChromeHeight`.
  const floating = sidebar.floating === true;
  if (document.body.dataset.floating !== String(floating)) {
    document.body.dataset.floating = String(floating);
    reportChromeHeight();
  }
}

/**
 * Say how tall the chrome's contents are, for the window to size the panel.
 *
 * Only while floating, and only on a change. Every other shape is a rectangle
 * the window decides on its own, and a message per animation frame to say a
 * number that has not moved is exactly the kind of idle cost this browser is
 * supposed to be about.
 *
 * The measurement is of what is in the chrome, not of the chrome: the body is
 * the view, and the view is the thing being sized - asking it would be asking
 * the answer to the question. So the panel's height is the bottom of its last
 * visible child, plus whatever padding sits under it.
 */
let reportedHeight = 0;

function reportChromeHeight() {
  if (document.body.dataset.floating !== 'true') return;

  let bottom = 0;
  for (const child of document.body.children) {
    if (child.hidden) continue;
    const box = child.getBoundingClientRect();
    if (box.height === 0) continue;
    bottom = Math.max(bottom, box.bottom);
  }
  if (!bottom) return;

  const pad = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
  const height = Math.ceil(bottom + pad);
  // A pixel of hysteresis. The window rounds, the panel is re-measured after it
  // is resized, and without this the two could trade a pixel back and forth for
  // as long as the browser is full screen.
  if (Math.abs(height - reportedHeight) < 2) return;
  reportedHeight = height;
  api.send('chrome-size', { height });
}

if (typeof ResizeObserver === 'function') {
  const watch = new ResizeObserver(() => reportChromeHeight());
  for (const child of document.body.children) watch.observe(child);
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

/**
 * Where a clicked bookmark goes.
 *
 * Kept on the bar itself rather than in a variable here, because the bar is
 * only redrawn when the bookmarks change while this preference can change at
 * any time - so the click handler reads it at the click, from the one place
 * that is always current, and the bar's state is visible in the inspector
 * beside the buttons it governs.
 */
function bookmarkOpensIn() {
  return el.bookmarks.dataset.opensIn === 'current-tab' ? 'current-tab' : 'new-tab';
}

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
    button.dataset.id = item.id;
    button.title = `${item.title || item.url}\n${item.url}`;

    // The site's own logo over its letter, through the browser's icon route -
    // never fetched by this page, which would send this session's cookies to
    // every bookmarked site every time the window opened. See `siteChip`.
    const host = siteOf(item.url);
    const chip = siteChip(item.url,
      { icon: item.icon, chipClass: 'bookmark-chip', iconClass: 'bookmark-icon' });

    const label = document.createElement('span');
    label.className = 'bookmark-label';
    const text = item.title || host;
    label.textContent = text.length > BOOKMARK_LABEL_MAX
      ? `${text.slice(0, BOOKMARK_LABEL_MAX - 1).trimEnd()}…`
      : text;

    button.append(chip, label);

    // Same three gestures a bookmark has in any browser. A plain click follows
    // the preference - a new tab unless the user asked for the other - while
    // Ctrl-click and the middle button always mean a new tab, because those two
    // mean that in every browser and a preference should not redefine them.
    //
    // The preference is read here, at the click, rather than captured when the
    // bar was drawn: the bar is only redrawn when the bookmarks themselves
    // change, so a captured value would go on opening tabs the old way until
    // the next time the user saved one.
    button.addEventListener('click', (event) => {
      const newTab = event.ctrlKey || event.metaKey || bookmarkOpensIn() !== 'current-tab';
      api.send(newTab ? 'new-tab' : 'navigate', { url: item.url });
    });
    button.addEventListener('auxclick', (event) => {
      if (event.button === 1) api.send('new-tab', { url: item.url });
    });

    bar.append(button);
  }

  // The chevron lives at the end and only appears when something did not fit.
  // Built here rather than in the markup so the bar is one list either way.
  const more = document.createElement('button');
  more.className = 'bookmark bookmark-more';
  more.type = 'button';
  more.hidden = true;
  more.title = 'More bookmarks';
  more.setAttribute('aria-label', more.title);
  more.textContent = '\u00bb';
  more.addEventListener('click', () => {
    const box = more.getBoundingClientRect();
    api.send('bookmarks-overflow', {
      ids: hiddenBookmarkIds(),
      x: Math.round(box.left),
      y: Math.round(box.bottom),
      right: Math.round(box.right)
    });
  });
  bar.append(more);

  el.bookmarks.replaceChildren(bar);
  el.bookmarks.classList.toggle('empty', items.length === 0);
  fitBookmarks();
}

/**
 * The bookmarks that did not fit, by id.
 *
 * Read back off the buttons rather than kept in a second list beside them: the
 * id is on the element that was hidden, so the two cannot disagree about which
 * ones those were. The browser turns the ids back into a menu - the bar holds
 * no addresses of its own.
 */
function hiddenBookmarkIds() {
  return [...el.bookmarks.querySelectorAll('.bookmark[data-id][hidden]')]
    .map((b) => b.dataset.id);
}

/**
 * Show what fits, and hand the rest to the chevron.
 *
 * The bar is one row and it does not wrap, so without this the last bookmark
 * was cut in half by the window edge and everything past it was simply gone -
 * no scroll, no menu, no sign that it existed. Chrome puts the remainder behind
 * a chevron and so does this.
 *
 * Measured against the bar's own width rather than the window's: in the side
 * layout the bar is inside a 240px column, and the window is not the thing
 * doing the clipping.
 */
function fitBookmarks() {
  // The bar itself, not a wrapper inside it: `replaceChildren` is given a
  // fragment, so the buttons end up as children of `#bookmarks` directly. The
  // first version of this read `firstElementChild` and searched inside it,
  // which is the first *bookmark*, found nothing, and silently did nothing.
  const bar = el.bookmarks;
  const more = bar.querySelector('.bookmark-more');
  const buttons = [...bar.querySelectorAll('.bookmark[data-id]')];
  if (!more || !buttons.length) return;

  // Everything visible first, so the measurement is of the real widths rather
  // than of whatever the last pass left hidden.
  for (const button of buttons) button.hidden = false;
  more.hidden = true;

  const room = bar.clientWidth - BOOKMARK_BAR_PADDING;
  let used = 0;
  let cut = -1;
  for (let i = 0; i < buttons.length; i++) {
    used += buttons[i].offsetWidth + BOOKMARK_GAP;
    if (used > room) { cut = i; break; }
  }
  if (cut === -1) return;              // everything fits; no chevron
  // `used` still counts the button that overflowed, which is going anyway.
  used -= buttons[cut].offsetWidth + BOOKMARK_GAP;

  // The chevron needs room too, so one more may have to go to make space for
  // the thing that says the rest are there.
  more.hidden = false;
  const chevron = more.offsetWidth + BOOKMARK_GAP;
  while (cut > 0 && used + chevron > room) {
    cut -= 1;
    used -= buttons[cut].offsetWidth + BOOKMARK_GAP;
  }
  for (let i = cut; i < buttons.length; i++) buttons[i].hidden = true;
}

/** The bar's own padding and the gap between buttons, from chrome.css. */
const BOOKMARK_BAR_PADDING = 12;
const BOOKMARK_GAP = 2;

// The window changes width far more often than the bookmarks change, and a
// resize is the other way the bar overflows.
window.addEventListener('resize', fitBookmarks);

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
  // Gone tabs leave first. Left in place until after the ordering pass, a
  // closed tab sat at its old index and every tab after it was re-inserted
  // around it - and moving a node restarts its CSS animation, so closing one
  // tab replayed the opening animation on every tab to its right.
  const live = new Set(tabs.map((tab) => tab.id));
  for (const [id, node] of tabEls) {
    if (!live.has(id)) {
      node.root.remove();
      tabEls.delete(id);
    }
  }
  // A tab opened while the widths are pinned has to get its share.
  if (tabs.some((tab) => !tabEls.has(tab.id))) releaseTabWidths();

  // A drop on screen that the browser has not caught up with yet: the old
  // order must not be put back in the meantime, and neither may any order
  // while a tab is under the pointer.
  if (heldOrder && (Date.now() > heldOrder.until ||
      tabs.findIndex((tab) => tab.id === heldOrder.id) === heldOrder.index)) heldOrder = null;
  const keepOrder = Boolean(heldOrder || tabDrag?.active);

  tabs.forEach((tab, index) => {
    let node = tabEls.get(tab.id);

    if (!node) {
      node = createTabElement(tab.id);
      tabEls.set(tab.id, node);
    }

    // Keep DOM order in sync with tab order without touching untouched nodes.
    const current = el.tabs.children[index];
    if (current !== node.root && (!keepOrder || !node.root.isConnected)) {
      el.tabs.insertBefore(node.root, current || null);
    }

    updateTabElement(node, tab);
  });
}

/*
 * Closing tabs in a row, the way Chrome does it.
 *
 * With every tab flexing, a close widens the rest and the next tab's x lands
 * somewhere other than under the pointer, so closing five tabs means chasing
 * five buttons. A close from the pointer pins each tab at the width it has
 * now; the strip gives the room back once the pointer leaves it.
 */
let tabWidthsFrozen = false;

function freezeTabWidths() {
  if (document.body.dataset.layout === 'left') return;
  // Every width read before any is written: interleaved, each write forced a
  // fresh layout of the strip for the next read.
  const nodes = [...tabEls.values()];
  const widths = nodes.map((node) => node.root.getBoundingClientRect().width);
  nodes.forEach((node, i) => { node.root.style.flex = `0 0 ${widths[i]}px`; });
  tabWidthsFrozen = true;
}

function releaseTabWidths() {
  if (!tabWidthsFrozen) return;
  tabWidthsFrozen = false;
  for (const node of tabEls.values()) node.root.style.flex = '';
}

el.tabs.addEventListener('mouseleave', releaseTabWidths);

function createTabElement(id) {
  const root = document.createElement('div');
  root.className = 'tab';
  root.dataset.id = String(id);

  const tier = document.createElement('span');
  tier.className = 'tier';
  tier.addEventListener('pointerenter', () => {
    const node = tabEls.get(id);
    if (node?.tab) tier.title = tierLabel(node.tab);
  });

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

  // Which icon addresses are tried, and the letter it falls back to, live in
  // `showIcon` in theme.js - shared with the bookmarks bar, history and the
  // new tab page. `has-icon` on the holder retires the letter once one loads.

  // A button, not a decoration: the thing you want when a tab starts talking is
  // to silence *that* tab, and the mark saying which one it is should be what
  // you press. Chrome does the same.
  const audio = document.createElement('button');
  audio.className = 'audio-dot';
  audio.type = 'button';
  audio.textContent = '\u25b6';
  audio.title = 'Mute this tab';
  audio.setAttribute('aria-label', audio.title);
  audio.hidden = true;

  const title = document.createElement('span');
  title.className = 'tab-title';

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.append(crossIcon());
  close.setAttribute('aria-label', 'Close tab');

  root.append(tier, icon, title, audio, close);

  root.addEventListener('mousedown', (event) => {
    if (event.button === 1) { freezeTabWidths(); api.send('close-tab', { id }); return; }
    if (event.button === 0) api.send('activate-tab', { id });
  });
  root.addEventListener('pointerdown', (event) => armTabDrag(event, id, root));

  // Right-click: close the other twelve, duplicate this one, silence whichever
  // tab is making that noise. The menu is built by the browser - the strip
  // names a tab and nothing else - and drawn in the sheet the page menu uses.
  root.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    api.send('tab-menu', {
      id, x: Math.round(event.clientX), y: Math.round(event.clientY)
    });
  });

  // The speaker mark mutes, without first switching to the tab to find out what
  // is making the sound. `mousedown` stopped for the same reason the close
  // button stops it: the root activates on mousedown, and a discarded tab would
  // be rebuilt purely to be silenced.
  audio.addEventListener('mousedown', (event) => event.stopPropagation());
  audio.addEventListener('click', (event) => {
    event.stopPropagation();
    api.send('mute-tab', { id });
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
    // `detail` is 0 for a keyboard press, which has no pointer to keep in place.
    if (event.detail > 0) freezeTabWidths();
    api.send('close-tab', { id });
  });

  return { root, tier, icon, favicon, chip, title, audio, close, state: {} };
}

/* ------------------------------------------------------------------ */
/* Dragging a tab to a new place                                       */
/* ------------------------------------------------------------------ */

/*
 * Pressing a tab still activates it at once, as it always did; a drag only
 * begins once the pointer has travelled a few pixels, so a click that wobbles
 * is still a click.
 *
 * While dragging nothing in the DOM moves. The tab follows the pointer by a
 * transform, along the strip's own axis, and the tabs it passes slide the
 * other way by one tab's size - transforms only, so a drag across thirty tabs
 * never lays out the strip. On release the DOM is put in the new order, every
 * transform is dropped, and the dragged tab alone is animated from where it
 * was let go into its slot. The browser is told the new index, and until its
 * state says the same, a broadcast still carrying the old order is not
 * allowed to undo the drop on screen.
 */
const DRAG_THRESHOLD = 4;
let tabDrag = null;
/** A drop the browser has not confirmed yet: {id, index, until}. */
let heldOrder = null;

function armTabDrag(event, id, root) {
  if (event.button !== 0 || event.target.closest('button')) return;
  const vertical = document.body.dataset.layout === 'left';
  tabDrag = { id, root, vertical, pointer: event.pointerId,
    start: vertical ? event.clientY : event.clientX, active: false };
}

function beginTabDrag() {
  const d = tabDrag;
  const nodes = [...el.tabs.children];
  d.from = nodes.indexOf(d.root);
  if (d.from === -1 || nodes.length < 2) { tabDrag = null; return false; }
  const edge = (r) => (d.vertical ? [r.top, r.bottom] : [r.left, r.right]);
  d.nodes = nodes;
  d.slots = nodes.map((n) => edge(n.getBoundingClientRect()));
  const [a, b] = d.slots[d.from];
  d.size = b - a;
  // The space between two tabs, so the ones that slide land exactly where
  // their neighbour was.
  const next = d.slots[d.from + 1] || d.slots[d.from - 1];
  const gap = next ? Math.max(0, next[0] > a ? next[0] - b : a - next[1]) : 0;
  d.shift = d.size + gap;
  d.min = d.slots[0][0] - a;
  d.max = d.slots[d.slots.length - 1][1] - b;
  d.to = d.from;
  d.active = true;
  try { d.root.setPointerCapture(d.pointer); } catch { /* the pointer is already gone */ }
  d.root.classList.add('dragging');
  document.body.classList.add('tab-dragging');
  return true;
}

function moveTabDrag(delta) {
  const d = tabDrag;
  const offset = Math.max(d.min, Math.min(d.max, delta));
  const axis = d.vertical ? 'Y' : 'X';
  d.root.style.transform = `translate${axis}(${offset}px)`;
  const [a, b] = d.slots[d.from];
  const centre = (a + b) / 2 + offset;
  let to = d.from;
  for (let i = d.from + 1; i < d.slots.length; i++) {
    if (centre > (d.slots[i][0] + d.slots[i][1]) / 2) to = i;
  }
  for (let i = d.from - 1; i >= 0; i--) {
    if (centre < (d.slots[i][0] + d.slots[i][1]) / 2) to = i;
  }
  if (to === d.to) return;
  d.to = to;
  d.nodes.forEach((node, i) => {
    if (node === d.root) return;
    const moved = d.from < to ? (i > d.from && i <= to ? -d.shift : 0)
      : (i >= to && i < d.from ? d.shift : 0);
    node.style.transform = moved ? `translate${axis}(${moved}px)` : '';
  });
}

function endTabDrag(cancelled) {
  const d = tabDrag;
  tabDrag = null;
  if (!d || !d.active) return;
  const to = cancelled ? d.from : d.to;
  const before = d.root.getBoundingClientRect();
  // Final order in the DOM, every transform gone, with no transition, so the
  // tabs that slid aside are already standing where they now belong.
  document.body.classList.remove('tab-dragging');
  for (const node of d.nodes) node.style.transform = '';
  if (to !== d.from) {
    const rest = d.nodes.filter((n) => n !== d.root);
    el.tabs.insertBefore(d.root, rest[to] || null);
  }
  // Then the dragged one glides from where it was let go.
  const after = d.root.getBoundingClientRect();
  const offset = d.vertical ? before.top - after.top : before.left - after.left;
  d.root.style.transform = `translate${d.vertical ? 'Y' : 'X'}(${offset}px)`;
  d.root.getBoundingClientRect();
  d.root.classList.add('settling');
  d.root.style.transform = '';
  const done = () => d.root.classList.remove('dragging', 'settling');
  d.root.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400);
  if (to !== d.from) {
    heldOrder = { id: d.id, index: to, until: Date.now() + 1500 };
    api.send('move-tab', { id: d.id, index: to });
  }
}

el.tabs.addEventListener('pointermove', (event) => {
  const d = tabDrag;
  if (!d || event.pointerId !== d.pointer) return;
  const delta = (d.vertical ? event.clientY : event.clientX) - d.start;
  if (!d.active && (Math.abs(delta) < DRAG_THRESHOLD || !beginTabDrag())) return;
  moveTabDrag(delta);
});
el.tabs.addEventListener('pointerup', () => endTabDrag(false));
el.tabs.addEventListener('pointercancel', () => endTabDrag(true));
// Esc puts it back where it came from.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && tabDrag?.active) { event.preventDefault(); endTabDrag(true); }
});

/** Write only what changed - the cheapest update is the one we skip. */
function updateTabElement(node, tab) {
  const prev = node.state;

  if (prev.title !== tab.title) {
    node.title.textContent = tab.title || 'New tab';
    prev.title = tab.title;
  }
  // Its own check: the address changes on navigations that keep the title.
  const tip = `${tab.title || ''}\n${tab.url || ''}`;
  if (prev.tip !== tip) {
    node.root.title = tip;
    prev.tip = tip;
  }

  // The icon is re-armed when the reported address changes *or* when the site
  // does, because the fallbacks are derived from the page's own origin: a tab
  // moving from a site with no icon to another with none would otherwise keep
  // trying the first site's addresses.
  const site = siteOf(tab.url);
  if (prev.favicon !== tab.favicon || prev.iconSite !== site) {
    // Back to the letter until one decodes. Without the reset a tab that
    // navigates from a site with an icon to one without keeps showing the old
    // site's chip state, which is the previous page's identity on this page.
    node.icon.classList.remove('has-icon');
    // Through the browser's icon route, never at the site: see `iconSrc`. Every
    // address the icon might be at is tried before the letter wins - the
    // reported one, then the two default paths. See `showIcon`.
    showIcon(node.favicon, tab.url, tab.favicon, {
      onLoad: () => node.icon.classList.add('has-icon'),
      onFail: () => node.icon.classList.remove('has-icon')
    });
    prev.favicon = tab.favicon;
    prev.iconSite = site;
  }

  // The chip only changes when the site does, which is far less often than the
  // URL: a page moving between paths on one host keeps its letter and colour,
  // and rewriting them on every navigation would be work for no visible change.
  if (prev.host !== site) {
    node.chip.textContent = (site.replace(/^[^a-z0-9]+/i, '')[0] || '?');
    node.chip.style.setProperty('--hue', String(siteHue(site)));
    prev.host = site;
  }

  if (prev.tier !== tab.tier) {
    node.tier.dataset.tier = tab.tier;
    prev.tier = tab.tier;
  }
  // The dot's tooltip carries a live figure, so it is written when the pointer
  // arrives rather than rebuilt for every tab on every tick.
  node.tab = tab;

  if (prev.active !== tab.visible) {
    node.root.classList.toggle('active', tab.visible);
    prev.active = tab.visible;
    // Now that the strip scrolls, the tab you switched to can be off the end of
    // it - Ctrl+Tab through thirty tabs and the highlight walks out of the
    // window. `nearest` so a tab already on screen does not move the strip.
    if (tab.visible) node.root.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  if (prev.boosted !== tab.boosted) {
    node.root.classList.toggle('boosted', tab.boosted);
    prev.boosted = tab.boosted;
  }

  // Shown while a tab is making sound *or* while it is muted: a muted tab with
  // no mark is a tab you cannot unmute without guessing which one you silenced.
  const sound = tab.audible || tab.muted;
  if (prev.sound !== sound || prev.muted !== tab.muted) {
    node.audio.hidden = !sound;
    node.audio.classList.toggle('muted', tab.muted === true);
    node.audio.textContent = tab.muted ? '\u2715' : '\u25b6';
    node.audio.title = tab.muted ? 'Unmute this tab' : 'Mute this tab';
    node.audio.setAttribute('aria-label', node.audio.title);
    prev.sound = sound;
    prev.muted = tab.muted;
  }

  // The spinner is Chrome's, and it belongs in the tab rather than only in the
  // line under the toolbar: with twenty tabs open and three of them loading, a
  // single bar at the top says that *something* is loading and not which.
  if (prev.loading !== tab.loading) {
    node.root.dataset.loading = tab.loading ? 'on' : 'off';
    prev.loading = tab.loading;
  }

  // A tab whose page crashed fades, so it can be found without opening each.
  if (prev.crashed !== tab.crashed) {
    node.root.dataset.crashed = tab.crashed ? 'on' : 'off';
    prev.crashed = tab.crashed;
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

  // Compared with what was last *shown*, not with the field: after typing a
  // full address, or picking a suggestion that fills one in, the field
  // already holds the new URL, and comparing against it skipped the padlock.
  if (active && !urlFocused && (active.url !== shownAddress || el.url.value !== active.url)) {
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

/** The address the bar last displayed for a tab, padlock included. */
let shownAddress = null;

function setAddress(url) {
  shownAddress = url;
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

/** Preferences the strip reads for itself, from the preload's first copy and then each broadcast. */
let chromePrefs = {};
function applyChromePrefs(next) {
  if (!next) return;
  chromePrefs = next;
  const closeButton = next.tabCloseButton || 'hover';
  if (document.body.dataset.closeButton !== closeButton) document.body.dataset.closeButton = closeButton;
}
applyChromePrefs(api.prefs);

/*
 * Finish the address as it is being typed.
 *
 * Two letters and Enter is how anyone reaches a site they visit daily, and
 * without this every one of those was an address typed out in full. The rest of
 * the match is inserted and left selected, so carrying on typing replaces it
 * and Enter takes the completed address.
 *
 * Only while adding characters. Completing after a backspace is the classic way
 * to make a field impossible to clear: you delete a letter, the browser puts it
 * straight back, and the caret has not moved.
 *
 * Answers are dropped unless what is in the field is still what was asked
 * about - the reply crosses a process boundary, and typing does not stop while
 * it is in flight.
 */
let completing = false;

/*
 * The list under the bar: open tabs, bookmarks, history and a search, for what
 * has been typed. Drawn by the browser in a view of its own (see
 * src/main/suggest.js and suggest.html); the keyboard stays here, so the
 * highlight is moved here and only reported. `typed` is what the user wrote,
 * kept apart from the field because highlighting a row puts that row's address
 * in the field, and Escape or ArrowUp past the top has to put it back.
 */
let typed = '';
let suggestions = [];
let selected = -1;
let asked = 0;
let listOpen = false;

function anchor() {
  const r = el.omnibox.getBoundingClientRect();
  return { x: r.left, y: r.bottom, width: r.width };
}

function closeList() {
  if (!listOpen && !suggestions.length) return;
  listOpen = false;
  suggestions = [];
  selected = -1;
  asked += 1;               // an answer still in flight is now stale
  api.send('suggest-hide');
}

el.url.addEventListener('beforeinput', (event) => {
  // `insertText` is typing; every other input type is a deletion, a paste or a
  // composition, none of which should complete.
  completing = event.inputType === 'insertText';
});

el.url.addEventListener('input', async () => {
  typed = el.url.value;
  selected = -1;
  if (!typed.trim()) { closeList(); return; }

  const ask = ++asked;
  const res = await api.request('suggest', { text: typed, anchor: anchor() });
  // Dropped unless the field still says what was asked about: the answer
  // crosses a process boundary, and typing does not stop while it is in flight.
  if (ask !== asked || el.url.value !== typed || !res) return;
  suggestions = res.items || [];
  listOpen = suggestions.length > 0;

  if (!completing || chromePrefs.inlineAutocomplete === false || typed.length < 2) return;
  const stem = res.inline;
  if (!stem || !stem.toLowerCase().startsWith(typed.toLowerCase()) || stem.length <= typed.length) return;
  // What the user typed, with their own capitalisation, plus the rest of the
  // match - and the rest selected, so the next keystroke overwrites it.
  el.url.value = typed + stem.slice(typed.length);
  el.url.setSelectionRange(typed.length, el.url.value.length);
});

/** What the bar shows while a row is highlighted: that row's address, or the search. */
const shown = (item) => (item.kind === 'search' || item.kind === 'go' ? item.title : item.url);

el.url.addEventListener('keydown', (event) => {
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && listOpen) {
    event.preventDefault();
    const n = suggestions.length;
    // -1 is the typed text itself: moving up past the first row returns to it.
    selected = event.key === 'ArrowDown'
      ? (selected + 1 >= n ? -1 : selected + 1)
      : (selected - 1 < -1 ? n - 1 : selected - 1);
    el.url.value = selected === -1 ? typed : shown(suggestions[selected]);
    el.url.setSelectionRange(el.url.value.length, el.url.value.length);
    api.send('suggest-select', { index: selected });
  } else if (event.key === 'Enter') {
    if (listOpen && selected >= 0) {
      api.send('suggest-pick', { index: selected, newTab: event.altKey });
    } else {
      api.send('navigate', { url: el.url.value });
    }
    closeList();
    el.url.blur();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    // First Escape: take back the list, and anything a highlight put in the
    // field. Second: leave the bar, as it always did.
    if (listOpen) {
      if (el.url.value !== typed) el.url.value = typed;
      closeList();
    } else {
      el.url.blur();
    }
  }
});

// Hidden on the way out, a moment late: a press on a row blurs this field
// first, and the row has to still be there to be taken.
el.url.addEventListener('blur', () => setTimeout(() => { if (!urlFocused) closeList(); }, 120));

/* ------------------------------------------------------------------ */
/* Find in page                                                        */
/* ------------------------------------------------------------------ */

/*
 * The bar is drawn here; the searching is done by the page's own renderer,
 * which only the browser process can reach. So this sends what was typed and
 * renders what came back, and holds no state about the search itself - the
 * browser has to own that anyway, because F3 works while the page has focus
 * and the page's renderer has never seen what was typed into this bar.
 */
function showFind(open) {
  el.findbar.hidden = !open;
  if (!open) {
    el.findInput.value = '';
    el.findCount.textContent = '';
    return;
  }
  el.findInput.focus();
  el.findInput.select();
}

function renderFindResult({ matches = 0, active = 0 }) {
  const query = el.findInput.value;
  // Nothing at all rather than "0/0" for an empty field: the count is an answer
  // to a question, and no question has been asked yet.
  el.findCount.textContent = !query ? '' : matches ? `${active}/${matches}` : 'No matches';
  el.findbar.classList.toggle('none', Boolean(query) && matches === 0);
}

el.findInput.addEventListener('input', () => {
  api.send('find-query', { query: el.findInput.value });
  if (!el.findInput.value) renderFindResult({});
});

el.findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    api.send(event.shiftKey ? 'find-prev' : 'find-next', { query: el.findInput.value });
    event.preventDefault();
  } else if (event.key === 'Escape') {
    api.send('find-close');
    event.preventDefault();
  }
});

el.findPrev.addEventListener('click', () => api.send('find-prev', { query: el.findInput.value }));
el.findNext.addEventListener('click', () => api.send('find-next', { query: el.findInput.value }));
el.findClose.addEventListener('click', () => api.send('find-close'));

/* ------------------------------------------------------------------ */

/*
 * Messages from the browser that are not state.
 *
 * The keyboard table used to live in this file, which is why the address bar
 * could not be focused from the keyboard: a page holds the keyboard nearly all
 * the time, and a binding in this renderer never saw the keystroke. The table
 * is in the browser process now, so what arrives here is the *effect* - focus
 * this, open that - rather than the key that caused it.
 */
api.onMessage((message) => {
  switch (message.kind) {
    case 'site-ask':
      openSite();
      break;
    case 'suggest-done':
      closeList();
      el.url.blur();
      break;
    case 'focus-address':
      el.url.focus();
      el.url.select();
      break;
    case 'find-focus':
      showFind(true);
      break;
    case 'find-closed':
      showFind(false);
      break;
    case 'find-result':
      renderFindResult(message);
      break;
    // Ctrl+D and the context menu both bookmark through the command channel,
    // which returns nothing - so the browser says what it decided, and the star
    // follows that rather than guessing.
    // Full screen changed the strip's shape. Sent directly rather than waited
    // for on the governor's next tick, which is up to half a second of a
    // full-height strip drawn over a full-screen page.
    case 'sidebar':
      renderSidebar(message.sidebar);
      break;

    case 'bookmarked':
      if (message.url === starUrl) setStar(Boolean(message.bookmarked));
      break;
    default:
      break;
  }
});

/**
 * A private window says so, and says whether its connection is up.
 *
 * The star is dimmed rather than removed: it is where people look to bookmark,
 * and finding it gone would read as a bug. Its tooltip says why it does nothing.
 */
const PRIVATE_LABELS = {
  ready: 'Private',
  bootstrapping: 'Private · connecting',
  starting: 'Private · connecting',
  failed: 'Private · offline',
  stopped: 'Private · offline'
};
function renderPrivate(incognito) {
  document.body.classList.toggle('incognito', Boolean(incognito));
  el.privatePill.hidden = !incognito;
  if (!incognito) { el.onion.hidden = true; el.slowJs.hidden = true; return; }
  const tor = incognito.tor || {};
  el.privatePill.dataset.state = tor.state || 'starting';
  el.privateText.textContent = PRIVATE_LABELS[tor.state] || 'Private';
  el.privatePill.title = tor.state === 'ready'
    ? 'Private window - every page goes through Tor. Click for details.'
    : `Private window - ${tor.summary || 'connecting to Tor'} (${tor.progress || 0}%). Nothing loads until it is connected.`;
  el.star.title = 'Bookmarks cannot be saved from a private window';
  el.onion.hidden = !incognito.onion;
  el.slowJs.hidden = !incognito.slowJs;
  // Tried from several exits and refused by every one: said, not looped.
  if (tor.state === 'ready' && incognito.refused) {
    el.privatePill.dataset.state = 'refused';
    el.privateText.textContent = 'Private · site refuses Tor';
    el.privatePill.title = 'This site refused every Tor exit it was tried from. Ctrl+Shift+L tries another.';
  }
}

el.onion.addEventListener('click', () => api.send('open-onion'));
el.slowJs.addEventListener('click', () => api.send('dismiss-slow-js'));
el.privatePill.addEventListener('click', () => api.send('navigate', { url: 'debrowser://tor' }));

api.onState((state) => {
  applyThemePrefs(state.prefs);
  applyChromePrefs(state.prefs);
  // Pinned widths are a top-strip idea; down the side `flex` is a height.
  if (document.body.dataset.layout === 'left') releaseTabWidths();
  if (state.prefs) el.bookmarks.dataset.opensIn = state.prefs.bookmarkOpensIn || 'new-tab';
  renderTabs(state.tabs);
  // Bookmarks changed somewhere else - Settings, an import - so the star's
  // cached answer for this page is no longer one.
  if (state.bookmarksRevision !== starRevision) {
    starRevision = state.bookmarksRevision;
    starUrl = null;
  }
  renderToolbar(state);
  renderMeter(state);

  // The bar is hidden rather than emptied when it is off or when the strip runs
  // down the side: the window has already given its 34px back to the page, and
  // a bar drawn into space nobody reserved would sit over the top of it.
  renderDownloadsButton(state.downloads);
  renderPrivate(state.incognito);
  renderSidebar(state.sidebar);
  document.body.classList.toggle('with-bookmarks', state.bookmarksBar !== false);
  if (state.bookmarksBar !== false) refreshBookmarks(state.bookmarksRevision);
});
