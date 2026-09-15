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
  'open-settings',
  'close-settings',
  'set-pref'
]);

contextBridge.exposeInMainWorld('debrowser', {
  /** Fire a UI command. Unknown commands are dropped here, not in main. */
  send(command, payload) {
    if (!COMMANDS.has(command)) {
      console.warn(`debrowser: refusing unknown command "${command}"`);
      return;
    }
    ipcRenderer.send('debrowser:command', command, payload ?? null);
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
