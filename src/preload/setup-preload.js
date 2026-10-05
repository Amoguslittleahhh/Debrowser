'use strict';

/**
 * The setup window's preload (setup-window.js): its few messages and nothing
 * else. Not the browser pages' preload, whose commands this window has no use
 * for - and which a process that never started the browser could not answer.
 */

const { contextBridge, ipcRenderer } = require('electron');

// theme.js reads the platform from here, as on every other page.
contextBridge.exposeInMainWorld('debrowser', { platform: process.platform });

contextBridge.exposeInMainWorld('setup', {
  info: () => ipcRenderer.invoke('setup-info'),
  size: (height) => ipcRenderer.send('setup-size', height),
  confirm: (checked) => ipcRenderer.send('setup-confirm', { checked: checked === true }),
  cancel: () => ipcRenderer.send('setup-cancel'),
  onFailed: (fn) => ipcRenderer.on('setup-failed', (_event, message) => fn(String(message)))
});
