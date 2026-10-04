'use strict';

/**
 * The window installing and uninstalling ask their questions in, on every
 * platform: one question, at most one checkbox, Cancel and an answer, drawn in
 * the browser's design (src/renderer/setup.html) - not a system dialog.
 *
 * What it asks is a spec from the caller (install.js, uninstall.js):
 *   { title, lead, check: { label, detail, danger } | null,
 *     cancel, confirm, busy, danger }
 * and the answer goes to `onConfirm(checked)`, which does the work. While it
 * runs the button reads `busy`; if it throws, the message is shown under the
 * question and the window stays, so the user can try again or cancel.
 *
 * One window at a time: asking again brings back the one already open.
 */

const { BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'renderer', 'setup.html');
const PRELOAD = path.join(__dirname, 'setup-preload.js');
const WIDTH = 440;

let open = null;

/**
 * @param {object} opts
 * @param {object} opts.spec - what to ask; see above
 * @param {object} opts.prefs - the preferences' values, for the design, theme and accent
 * @param {(checked: boolean) => any} opts.onConfirm - does the work; may return a promise
 * @param {(confirmed: boolean) => void} [opts.onClosed] - after the window has gone
 * @returns {BrowserWindow}
 */
function showSetupWindow({ spec, prefs, onConfirm, onClosed = () => {} }) {
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    open.focus();
    return open;
  }
  const dark = prefs.theme === 'dark' || (prefs.theme !== 'light' && nativeTheme.shouldUseDarkColors);
  const win = new BrowserWindow({
    width: WIDTH,
    height: 300,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    title: spec.title,
    // The palette's own background, so no white frame shows before the page.
    backgroundColor: dark ? '#131514' : '#f7f8f5',
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  open = win;
  // `working` stops a second click while the answer runs; `confirmed`, whether
  // it finished - which is what closing the window means to the caller.
  let working = false;
  let confirmed = false;
  const fromHere = (event) => event.sender === win.webContents;

  const onInfo = (event) => (fromHere(event) ? { prefs, spec, platform: process.platform } : null);
  const onSize = (event, height) => {
    if (!fromHere(event) || !Number.isFinite(height)) return;
    win.setContentSize(WIDTH, Math.max(160, Math.min(560, Math.ceil(height))));
    if (!win.isVisible()) { win.center(); win.show(); }
  };
  const onCancel = (event) => {
    if (!fromHere(event) || working) return;
    win.close();
  };
  const onAnswer = async (event, { checked } = {}) => {
    if (!fromHere(event) || working) return;
    working = true;
    try {
      await onConfirm(checked === true);
      confirmed = true;
    } catch (err) {
      working = false;
      if (!win.isDestroyed()) win.webContents.send('setup-failed', String(err && err.message || err));
    }
  };
  ipcMain.handle('setup-info', onInfo);
  ipcMain.on('setup-size', onSize);
  ipcMain.on('setup-cancel', onCancel);
  ipcMain.on('setup-confirm', onAnswer);
  win.on('closed', () => {
    ipcMain.removeHandler('setup-info');
    ipcMain.removeListener('setup-size', onSize);
    ipcMain.removeListener('setup-cancel', onCancel);
    ipcMain.removeListener('setup-confirm', onAnswer);
    open = null;
    onClosed(confirmed);
  });

  // Its own page and nothing else: no links leave it, no window opens from it.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Shown once the page has measured itself (`setup-size`), so the window
  // opens at its final height; this is the fallback if that never comes.
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) { win.center(); win.show(); } }, 1500).unref?.();
  win.loadFile(PAGE);
  return win;
}

module.exports = { showSetupWindow };
