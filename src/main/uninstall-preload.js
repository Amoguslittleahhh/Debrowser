'use strict';

/**
 * The uninstall window's preload (uninstall.js): its four messages and nothing
 * else. Not the browser pages' preload, whose commands this window has no use
 * for - and which a process that never started the browser could not answer.
 */

const { contextBridge, ipcRenderer } = require('electron');

// theme.js reads the platform from here, as on every other page.
contextBridge.exposeInMainWorld('debrowser', { platform: process.platform });

contextBridge.exposeInMainWorld('uninstaller', {
  info: () => ipcRenderer.invoke('uninstall-info'),
  size: (height) => ipcRenderer.send('uninstall-size', height),
  confirm: (removeData) => ipcRenderer.send('uninstall-confirm', { removeData: removeData === true }),
  cancel: () => ipcRenderer.send('uninstall-cancel'),
  onFailed: (fn) => ipcRenderer.on('uninstall-failed', (_event, message) => fn(String(message)))
});
