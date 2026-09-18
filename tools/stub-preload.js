// Stands in for chrome-preload.js so the browser's own pages can be rendered
// and photographed outside a running browser. Same surface, canned answers.
const { contextBridge, ipcRenderer } = require('electron');

const STATE = JSON.parse(process.argv.find((a) => a.startsWith('--state=')).slice(8));
const ANSWERS = JSON.parse(process.argv.find((a) => a.startsWith('--answers=')).slice(10));

contextBridge.exposeInMainWorld('debrowser', {
  platform: 'win32',
  send() {},
  request(command) { return Promise.resolve(ANSWERS[command] ?? null); },
  onState(handler) {
    if (typeof handler === 'function') setTimeout(() => handler(STATE), 0);
    return () => {};
  }
});
ipcRenderer.on('noop', () => {});
