// Stands in for chrome-preload.js so the browser's own pages can be rendered
// and photographed outside a running browser. Same surface, canned answers.
const { contextBridge, ipcRenderer } = require('electron');

const STATE = JSON.parse(process.argv.find((a) => a.startsWith('--state=')).slice(8));
const ANSWERS = JSON.parse(process.argv.find((a) => a.startsWith('--answers=')).slice(10));

contextBridge.exposeInMainWorld('debrowser', {
  platform: 'win32',
  // The real preload hands the view its palette before a line of script runs,
  // so theme.js can apply it at parse time; without it here every photograph
  // comes back in whatever `prefers-color-scheme` the harness's X server says.
  prefs: STATE.prefs,
  send() {},
  request(command) { return Promise.resolve(ANSWERS[command] ?? null); },
  onState(handler) {
    if (typeof handler === 'function') setTimeout(() => handler(STATE), 0);
    return () => {};
  },
  // The chrome subscribes to this at parse time. Without it the call throws,
  // the rest of chrome.js never runs, and the photograph is of a toolbar with
  // no tabs in it - which is exactly what it was for one round.
  onMessage() { return () => {}; }
});
ipcRenderer.on('noop', () => {});
