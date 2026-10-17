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
 * One window at a time. Asking the same question again brings it back; a
 * different question replaces it, unless it is in the middle of its answer,
 * which is never cut off. A window asked for by the browser (`owner`) closes
 * with it, so a question left open cannot keep the app running windowless.
 */

const { BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');

const PAGE = path.join(__dirname, '..', '..', 'renderer', 'setup.html');
const PRELOAD = path.join(__dirname, '..', '..', 'preload', 'setup-preload.js');
const WIDTH = 440;

/** The window up now: { win, spec, prefs, onConfirm, working }. */
let current = null;

/** The session a message came from, if it is the window up now. */
const from = (event) => (current && !current.win.isDestroyed() && event.sender === current.win.webContents ? current : null);

// Registered once, for whichever window is up: per-window handlers on shared
// channel names would be removed by the old window's `closed` after the new
// one had registered its own.
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  ipcMain.handle('setup-info', (event) => {
    const it = from(event);
    return it ? { prefs: it.prefs, spec: it.spec, platform: process.platform } : null;
  });
  ipcMain.on('setup-size', (event, height) => {
    const it = from(event);
    if (!it || !Number.isFinite(height)) return;
    it.win.setContentSize(WIDTH, Math.max(160, Math.min(560, Math.ceil(height))));
    if (!it.win.isVisible()) { it.win.center(); it.win.show(); }
  });
  ipcMain.on('setup-cancel', (event) => {
    const it = from(event);
    if (it && !it.working) it.win.close();
  });
  ipcMain.on('setup-confirm', async (event, { checked } = {}) => {
    const it = from(event);
    if (!it || it.working) return;
    it.working = true;
    try {
      await it.onConfirm(checked === true);
      it.confirmed = true;
    } catch (err) {
      it.working = false;
      if (!it.win.isDestroyed()) it.win.webContents.send('setup-failed', String(err && err.message || err));
    }
  });
}

/**
 * @param {object} opts
 * @param {object} opts.spec - what to ask; see above
 * @param {object} opts.prefs - the preferences' values, for the design, theme and accent
 * @param {(checked: boolean) => any} opts.onConfirm - does the work; may return a promise
 * @param {(confirmed: boolean) => void} [opts.onClosed] - after the window has gone
 * @param {Electron.BaseWindow} [opts.owner] - the browser window that asked; this closes with it
 * @returns {BrowserWindow}
 */
function showSetupWindow({ spec, prefs, onConfirm, onClosed = () => {}, owner = null }) {
  if (current && !current.win.isDestroyed()) {
    if (current.spec.title === spec.title || current.working) {
      if (current.win.isMinimized()) current.win.restore();
      current.win.focus();
      return current.win;
    }
    // Another question, not yet answered: this one takes its place, and the
    // old one is closed as if cancelled.
    current.win.destroy();
  }
  wire();
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
  const it = { win, spec, prefs, onConfirm, working: false, confirmed: false };
  current = it;

  const closeWithOwner = () => { if (!win.isDestroyed()) win.destroy(); };
  if (owner && !owner.isDestroyed()) owner.once('closed', closeWithOwner);
  win.on('closed', () => {
    if (owner && !owner.isDestroyed()) owner.removeListener('closed', closeWithOwner);
    if (current === it) current = null;
    onClosed(it.confirmed);
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
