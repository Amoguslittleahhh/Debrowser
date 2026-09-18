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
  'set-pref',
  'list-history',
  'delete-history',
  'clear-history',
  'list-credentials',
  'delete-credential',
  'reveal-credential',
  'save-payment',
  'fill-payment',
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
  'clear-download'
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
  }
});
