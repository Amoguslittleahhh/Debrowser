'use strict';

/**
 * Uninstalling, in the browser's own window.
 *
 * Windows' Apps list runs whatever the install recorded as `UninstallString`,
 * and electron-builder records its NSIS uninstaller there - which opens with a
 * system message box ("Are you sure you want to uninstall?") and then works
 * with no window at all. The installer (packaging/installer.nsh) records
 * `Debrowser.exe --uninstall` instead, and this is what that opens: the
 * question, in the browser's design, with the one choice that matters - keep
 * the browsing data or delete it.
 *
 * Confirming starts the real uninstaller silently, told to wait for this
 * process to be gone (`--wait-pid`), and quits: files a running program holds
 * open cannot be deleted. It draws its own progress (tools/setup-ui.c).
 * `QuietUninstallString` still names the uninstaller with /S, so management
 * tools that uninstall silently never see a window.
 *
 * Two ways in, one window:
 *   - nothing is running: `--uninstall` starts a process that shows only this
 *     and touches nothing in the profile (main.js branches before it would);
 *   - the browser is open: the launch arrives at it as a second instance, and
 *     it shows the window itself, so that confirming closes the browser the
 *     ordinary way - session saved - instead of being killed by the uninstaller.
 */

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const FLAG = '--uninstall';
const PAGE = path.join(__dirname, '..', 'renderer', 'uninstall.html');
const PRELOAD = path.join(__dirname, 'uninstall-preload.js');
/** electron-builder's name for it: `Uninstall ${productName}.exe`, beside the app. */
const UNINSTALLER = 'Uninstall Debrowser.exe';

const requested = (argv) => (argv || []).includes(FLAG);

let open = null;

/**
 * Show the window, or bring back the one already open.
 *
 * @param {object} opts
 * @param {object} opts.prefs - the preferences' values, for the design, theme and accent
 * @param {boolean} opts.browserOpen - whether confirming will close a running browser
 * @param {() => void} opts.onConfirmed - quit, once the uninstaller is on its way
 * @param {() => void} [opts.onCancelled]
 * @param {(...args: any[]) => void} [opts.log]
 */
function show({ prefs, browserOpen, onConfirmed, onCancelled = () => {}, log = () => {} }) {
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    open.focus();
    return open;
  }
  const dark = prefs.theme === 'dark' || (prefs.theme !== 'light' && nativeTheme.shouldUseDarkColors);
  const win = new BrowserWindow({
    width: 440,
    height: 300,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    title: 'Uninstall Debrowser',
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
  // `answered` stops a second click; `started`, whether closing means quitting.
  let answered = false;
  let started = false;
  const fromHere = (event) => event.sender === win.webContents;

  const onInfo = (event) => (fromHere(event) ? { prefs, browserOpen, platform: process.platform } : null);
  const onSize = (event, height) => {
    if (!fromHere(event) || !Number.isFinite(height)) return;
    win.setContentSize(440, Math.max(200, Math.min(520, Math.ceil(height))));
    if (!win.isVisible()) { win.center(); win.show(); }
  };
  const onCancel = (event) => {
    if (!fromHere(event) || answered) return;
    answered = true;
    win.close();
  };
  const onConfirm = (event, { removeData } = {}) => {
    if (!fromHere(event) || answered) return;
    answered = true;
    try {
      start({ removeData: removeData === true });
    } catch (err) {
      // Nothing to quit for: the uninstaller did not start, so the browser stays.
      log('uninstall', `could not start the uninstaller: ${err.message}`);
      answered = false;
      if (!win.isDestroyed()) win.webContents.send('uninstall-failed', err.message);
      return;
    }
    started = true;
    log('uninstall', `uninstaller started${removeData ? ', deleting browsing data' : ''}`);
    onConfirmed();
  };
  ipcMain.handle('uninstall-info', onInfo);
  ipcMain.on('uninstall-size', onSize);
  ipcMain.on('uninstall-cancel', onCancel);
  ipcMain.on('uninstall-confirm', onConfirm);
  win.on('closed', () => {
    ipcMain.removeHandler('uninstall-info');
    ipcMain.removeListener('uninstall-size', onSize);
    ipcMain.removeListener('uninstall-cancel', onCancel);
    ipcMain.removeListener('uninstall-confirm', onConfirm);
    open = null;
    if (!started) onCancelled();
  });

  // Its own page and nothing else: no links leave it, no window opens from it.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Shown once the page has measured itself (`uninstall-size`), so the window
  // opens at its final height; this is the fallback if that never comes.
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) { win.center(); win.show(); } }, 1500).unref?.();
  win.loadFile(PAGE);
  return win;
}

/**
 * Start the uninstaller, detached, waiting for this process to exit.
 *
 * Only on Windows, and only from an installed copy: anywhere else there is no
 * uninstaller beside the executable, and this throws, which the window reports.
 */
function start({ removeData }) {
  if (process.platform !== 'win32') throw new Error('Uninstall Debrowser from your system\'s own tools.');
  const exe = path.join(path.dirname(process.execPath), UNINSTALLER);
  if (!require('fs').existsSync(exe)) throw new Error('This copy of Debrowser was not installed, so there is nothing to uninstall.');
  const args = ['/currentuser', '/S', `--wait-pid=${process.pid}`];
  if (removeData) args.push('--delete-app-data');
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

/**
 * The standalone case: nothing running, so show the window and quit when it
 * closes. Returns true when it has taken over this launch.
 */
function run({ prefs, log }) {
  if (!requested(process.argv)) return false;
  // Held while the window is up, so a browser started meanwhile is not left
  // holding files the uninstaller is about to remove - it focuses this instead.
  // Losing it means the browser is open: it has been handed this launch
  // (`second-instance`) and shows the window itself.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return true;
  }
  app.on('second-instance', () => { if (open && !open.isDestroyed()) open.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => show({
    prefs,
    browserOpen: false,
    onConfirmed: () => app.quit(),
    onCancelled: () => app.quit(),
    log
  }));
  return true;
}

module.exports = { run, show, requested, FLAG };
