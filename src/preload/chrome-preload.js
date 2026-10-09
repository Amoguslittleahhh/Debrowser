'use strict';

/**
 * Bridge for the browser's own UI (tab strip, toolbar, task manager).
 *
 * The chrome is a sandboxed renderer with no Node access, exactly like a web
 * page. It reaches the browser process only through the narrow, explicitly
 * enumerated surface below - there is no generic "invoke anything" escape
 * hatch, so a bug in the UI cannot turn into control over the browser.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Ctrl and the wheel zoom the page, here as well as in a website.
 *
 * The browser's own pages carry this preload rather than the page probe, so
 * without this the gesture worked everywhere except on Settings and History -
 * which are the pages most likely to be read at a size that does not suit
 * somebody. Sent as the ordinary `zoom` command, which this bridge already
 * allows.
 */
let lastZoomAt = 0;

window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey || event.deltaY === 0) return;
  event.preventDefault();
  const at = Date.now();
  if (at - lastZoomAt < 60) return;
  lastZoomAt = at;
  ipcRenderer.send('debrowser:command', 'zoom',
    { direction: event.deltaY < 0 ? 'in' : 'out' });
}, { passive: false, capture: true });

/** Commands the UI is allowed to issue. */
const COMMANDS = new Set([
  'new-tab',
  'new-incognito-window',
  'tor-retry',
  'allow-http',
  'allow-danger',
  'open-safety',
  'open-receipt',
  'reader-view',
  'switch-space',
  'split-with-tab',
  'peek-promote',
  'hide-element',
  'show-hidden',
  'open-site-style',
  'site-style-set',
  'site-style-get',
  'peek-close',
  'passkey-pick',
  'passkey-other',
  'passkey-close',
  'passkey-size',
  'passkey-passcode',
  'peek-link',
  'split-new',
  'unsplit',
  'split-swap',
  'split-drag',
  'split-even',
  'devtools-drag',
  'devtools-drag-end',
  'devtools-even',
  'cycle-space',
  'new-space',
  'edit-space',
  'delete-space',
  'move-tab-to-space',
  'space-menu',
  'picture-in-picture',
  'screenshot-page',
  'copy-version-info',
  'report-problem',
  // The quick window (a Lab), from its bar.
  'quick-promote',
  'quick-close',
  // Tab groups (a Lab: tab-groups.js).
  'group-tab',
  'add-to-group',
  'ungroup-tab',
  'ungroup-all',
  'toggle-group',
  'rename-group',
  'recolour-group',
  'close-group',
  'group-menu',
  'reader-article',
  'receipt-week',
  'open-whats-new',
  'whats-new-notes',
  'safety-status',
  'safety-revoke',
  'new-circuit',
  'open-onion',
  'open-drm-elsewhere',
  'dismiss-slow-js',
  'panic',
  'fingerprint-expected',
  'new-identity',
  'close-tab',
  'activate-tab',
  'navigate',
  'back',
  'forward',
  'reload',
  'stop',
  'toggle-panel',
  'set-budget',
  'discard-tab',
  'move-tab',
  'bookmark-menu',
  'copy-image',
  'forget-bookmark',
  // The site panel under the padlock, and the permission questions it asks.
  'open-site',
  'site-info',
  'permission-answer',
  'site-permission',
  'site-clear-data',
  'site-blocking',
  'site-sleep',
  'site-third-party',
  'site-forget',
  // The toast at the foot of the window: its button, and its going.
  'toast-action',
  'toast-dismiss',
  'show-shortcuts',
  'shortcut-list',
  'pin-tab',
  'mute-tab',
  'duplicate-tab',
  'close-duplicate-tabs',
  'sleep-tab',
  'close-other-tabs',
  'close-tabs-right',
  'tab-menu',
  'prefetch-tab',
  'prefetch-new-tab',
  'open-menu',
  'close-menu',
  'menu-model',
  'open-settings',
  'open-history',
  'open-passwords',
  'open-bookmarks',
  'open-downloads',
  'toggle-fullscreen',
  'zoom',
  'print',
  'save-page',
  'toggle-devtools',
  'page-dirty',
  'set-pref',
  'list-history',
  'delete-history',
  'clear-history',
  'list-credentials',
  // The passwords page's lock, and Settings' passcode controls (vault.js).
  'vault-status',
  'import-logins-file',
  'check-passwords',
  'vault-unlock',
  'vault-lock',
  'vault-set',
  'vault-remove',
  'delete-credential',
  'reveal-credential',
  'save-payment',
  'fill-payment',
  'sidebar-hover',
  'sidebar-slid',
  'sidebar-typing',
  'chrome-size',
  'bookmarks-overflow',
  'toggle-sidebar-pin',
  'toggle-bookmarks-bar',
  'list-bookmarks',
  // The address bar's list of suggestions.
  'suggest',
  'suggest-select',
  'suggest-hover',
  'suggest-hide',
  'suggest-size',
  'suggest-pick',
  'toggle-bookmark',
  'remove-bookmark',
  'save-bookmark',
  'bookmark-profiles',
  // The welcome tour (welcome.html).
  'welcome-done',
  'make-default',
  'default-browser-status',
  // Settings → Advanced: install where the system has no installer, and uninstall.
  'install-browser',
  'uninstall-browser',
  'setup-status',
  'open-welcome',
  'import-from-profile',
  'import-bookmark-file',
  'presence-capability',
  'check-for-updates',
  'list-downloads',
  'cancel-download',
  'clear-download',
  'reveal-download',
  'open-download',
  'retry-download',
  'safe-copy',
  'open-downloads-page',
  'update-restart',
  // The browser's own message box: the question, and the answer to it.
  'ask-spec',
  'ask-answer',

  // The single shortcut table lives in the browser process, so the keys the
  // chrome used to bind itself are commands now like any other.
  'focus-address',
  'bookmark-page',
  'reopen-closed-tab',
  'select-tab',
  'cycle-tab',
  'reload-hard',
  'view-source',

  // Find in page. The bar is drawn by the chrome; the searching is done by the
  // page's own renderer, which only the browser process can reach.
  'find-open',
  'find-close',
  'find-query',
  'find-next',
  'find-prev',

  // The page's context menu, drawn in the sheet like the app menu.
  'context-model',
  'open-link-tab',
  'copy-link',
  'copy-text',
  'save-link',
  'search-selection',
  'edit-cut',
  'edit-copy',
  'edit-paste',
  'edit-select-all',
  'inspect',

  // The new tab page's tiles.
  'top-sites',
  'forget-site',
  'recent-pages',
  'hide-continue-card'
]);

/**
 * The preferences as they were when this view was created.
 *
 * Every view here themes itself from `applyThemePrefs`, and every view used to
 * get its first prefs *after* it had painted - on a reply, or on the governor's
 * next broadcast. So a sheet came up in whatever `prefers-color-scheme` said
 * and turned into the browser's palette a frame later, which on a machine set
 * to Light with Dark chosen is a white menu flashing over a dark browser.
 *
 * The browser knows the answer when it builds the view, so it passes it here
 * and theme.js applies it at parse time. A snapshot, deliberately: this is the
 * starting state, and the broadcast is what keeps it current.
 */
function initialPrefs() {
  const arg = process.argv.find((a) => a.startsWith('--prefs='));
  if (!arg) return null;
  try {
    return Object.freeze(JSON.parse(arg.slice('--prefs='.length)));
  } catch {
    return null;
  }
}

/**
 * Battery mode, marked on the document (`data-saver`) for theme.css: it keeps
 * the text cursor steady instead of blinking. Each blink is a frame drawn
 * twice a second, and the compositor keeps waking for several frames after
 * each - measured, a focused search field on the new tab page took the GPU
 * process from 7 wakeups a second to 33, and that page's renderer from 6 to
 * 31. Watched once, from the first page that listens for state.
 */
let saverWatched = false;
function watchSaver() {
  if (saverWatched) return;
  saverWatched = true;
  ipcRenderer.on('debrowser:state', (_event, state) => {
    if (!state || typeof state.saver !== 'boolean' || !document.documentElement) return;
    if (document.documentElement.hasAttribute('data-saver') !== state.saver) {
      document.documentElement.toggleAttribute('data-saver', state.saver);
    }
  });
}

contextBridge.exposeInMainWorld('debrowser', {
  /** What the palette was when this view was created. See `initialPrefs`. */
  prefs: initialPrefs(),

  /**
   * Which OS this is, so the chrome can reserve the right gutter for the
   * system's window buttons.
   *
   * Reading it here rather than inferring it from the user agent, and exposing
   * the string only - nothing about `process` itself crosses the bridge.
   */
  platform: process.platform,

  /** Fire a UI command. Unknown commands are dropped here, not in main. */
  send(command, payload) {
    if (!COMMANDS.has(command)) {
      console.warn(`debrowser: refusing unknown command "${command}"`);
      return;
    }
    ipcRenderer.send('debrowser:command', command, payload ?? null);
  },

  /**
   * Ask the browser something and get one answer back.
   *
   * Separate from `send` because the credential list must not ride the state
   * broadcast: that goes to three views on every governor tick, and a list of
   * the user's accounts has no business being pushed into a renderer twice a
   * second on the chance someone has Settings open.
   */
  request(command, payload) {
    if (!COMMANDS.has(command)) {
      console.warn(`debrowser: refusing unknown request "${command}"`);
      return Promise.resolve(null);
    }
    return ipcRenderer.invoke('debrowser:request', command, payload ?? null);
  },

  /**
   * Subscribe to browser state. Returns an unsubscribe function.
   * State arrives on the governor's tick and on every tab event.
   */
  onState(handler) {
    if (typeof handler !== 'function') return () => {};
    watchSaver();
    const listener = (_event, state) => handler(state);
    ipcRenderer.on('debrowser:state', listener);
    return () => ipcRenderer.removeListener('debrowser:state', listener);
  },

  /**
   * One-off messages from the browser, for the things that are not state.
   *
   * Focus the address bar, open or close the find bar, report a match count,
   * report that the page in front was bookmarked. None of these belong on the
   * state broadcast: they are events with a moment attached, and a snapshot
   * that carried "focus the address bar" would re-focus it on every tick.
   */
  onMessage(handler) {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, message) => handler(message || {});
    ipcRenderer.on('debrowser:ui', listener);
    return () => ipcRenderer.removeListener('debrowser:ui', listener);
  }
});
