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

/** Commands the UI is allowed to issue. */
const COMMANDS = new Set([
  'new-tab',
  'close-tab',
  'activate-tab',
  'navigate',
  'back',
  'forward',
  'reload',
  'stop',
  'toggle-panel',
  'set-profile',
  'set-budget',
  'discard-tab',
  'pin-tab',
  'prefetch-tab',
  'prefetch-new-tab',
  'open-menu',
  'close-menu',
  'menu-model',
  'open-settings',
  'open-history',
  'open-bookmarks',
  'open-downloads',
  'toggle-fullscreen',
  'zoom',
  'print',
  'toggle-devtools',
  'page-dirty',
  'set-pref',
  'list-history',
  'delete-history',
  'clear-history',
  'list-credentials',
  'delete-credential',
  'reveal-credential',
  'save-payment',
  'fill-payment',
  'sidebar-hover',
  'toggle-sidebar-pin',
  'toggle-bookmarks-bar',
  'list-bookmarks',
  'toggle-bookmark',
  'remove-bookmark',
  'bookmark-profiles',
  'import-from-profile',
  'import-bookmark-file',
  'presence-capability',
  'check-for-updates',
  'list-downloads',
  'cancel-download',
  'clear-download',
  'reveal-download',
  'open-download',
  'open-downloads-page',
  'update-restart',

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
  'forget-site'
]);

contextBridge.exposeInMainWorld('debrowser', {
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
