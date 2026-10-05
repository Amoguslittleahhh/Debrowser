'use strict';

/**
 * Uninstalling, in the browser's own window, on every platform.
 *
 * One question (setup-window.js) - keep the browsing data or delete it - and
 * then each system's own way of removing a program, done for the user:
 *
 *   Windows  Windows' Apps list runs `UninstallString`, which the installer
 *            (build/installer.nsh) points here, `Debrowser.exe --uninstall`,
 *            instead of at NSIS's uninstaller and its system message box.
 *            Confirming starts that uninstaller silently, told to wait for this
 *            process to be gone (`--wait-pid`), and quits; it draws its own
 *            progress (native/helpers/setup-ui.c). `QuietUninstallString` still names it
 *            with /S, so management tools never see a window.
 *   macOS    The app goes to the Trash, as dragging it there would do.
 *   Linux    The .deb is removed by dpkg, behind the system's own password
 *            prompt (pkexec); an AppImage or an unpacked folder goes to the
 *            Trash, with the apps-menu entry install.js made for it.
 *
 * Deleting the data waits until this process has exited (Windows: the
 * uninstaller's --delete-app-data; elsewhere a detached shell that waits for
 * our pid), since the browser holds its profile open until then.
 *
 * Ways in: Settings → Advanced on every platform; `--uninstall` from Windows'
 * Apps list or the Linux menu entry's Uninstall action. With the browser
 * closed, that launch shows only this window and touches nothing in the
 * profile (main.js branches before it would). With it open, the launch arrives
 * as a second instance and the browser shows the window itself, so confirming
 * closes it the ordinary way, session saved.
 */

const { app, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { showSetupWindow } = require('./setup-window');
const install = require('./install');

const FLAG = '--uninstall';
/** electron-builder's name for it: `Uninstall ${productName}.exe`, beside the app. */
const UNINSTALLER = 'Uninstall Debrowser.exe';
const NOT_INSTALLED = 'This copy of Debrowser was not installed, so there is nothing to uninstall.';

const requested = (argv) => (argv || []).includes(FLAG);

/* ---- Removing ------------------------------------------------------------ */

/** The .app bundle this runs from: …/Debrowser.app/Contents/MacOS/Debrowser. */
const macBundle = () => path.resolve(path.dirname(process.execPath), '..', '..');

/** Into the Trash where the system has one; deleted outright where it has not. */
async function trash(target) {
  try {
    await shell.trashItem(target);
  } catch {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Where this platform keeps the browsing data. Each name contains
 * "debrowser" - `removeAfterExit` refuses anything that does not - so a
 * changed path can never point the deletion at a parent folder.
 */
function dataPaths() {
  const home = os.homedir();
  // Both spellings: the profile is under the package name, and Electron makes
  // an (empty) folder under the product name before it is told otherwise.
  const appData = app.getPath('appData');
  const list = [...new Set([app.getPath('userData'), path.join(appData, 'Debrowser'), path.join(appData, 'debrowser')])];
  if (process.platform === 'darwin') {
    const lib = path.join(home, 'Library');
    list.push(path.join(lib, 'Caches', 'Debrowser'), path.join(lib, 'Caches', 'debrowser-updater'),
      path.join(lib, 'Logs', 'Debrowser'), path.join(lib, 'Saved Application State', 'dev.debrowser.app.savedState'),
      path.join(lib, 'Preferences', 'dev.debrowser.app.plist'));
  } else {
    const cache = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
    list.push(path.join(cache, 'Debrowser'), path.join(cache, 'debrowser'), path.join(cache, 'debrowser-updater'));
  }
  return list;
}

/** Delete `paths` once this process has exited - only ones inside the home folder and named for Debrowser. */
function removeAfterExit(paths) {
  const home = os.homedir();
  const safe = paths.filter((p) => path.isAbsolute(p) && p.startsWith(home + path.sep) &&
    /debrowser/i.test(path.basename(p)));
  if (!safe.length) return;
  // $0 is our pid; the paths are arguments, never part of the script.
  spawn('/bin/sh', ['-c', 'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done; rm -rf -- "$@"',
    String(process.pid), ...safe], { detached: true, stdio: 'ignore' }).unref();
}

/** Exit code (-1 when it could not start) and what it printed. */
function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || '')
    }));
  });
}

/**
 * Other processes running this very executable, as [pid, args] - this copy,
 * not another copy of Debrowser. Electron's helpers (`--type=`) are left out:
 * they go with the process that started them.
 */
async function processesOfThisCopy() {
  const found = [];
  const keep = (pid, args) => {
    if (pid !== process.pid && !args.some((a) => a.startsWith('--type='))) found.push([pid, args]);
  };
  if (process.platform === 'linux') {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (fs.readlinkSync(`/proc/${name}/exe`) !== process.execPath) continue;
        // Split on spaces too: Chromium rewrites its helpers' command lines
        // into one space-joined string. Only flags are compared, so a space
        // in a path splitting it does no harm.
        keep(Number(name), fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split(/[\0 ]/));
      } catch { /* gone, or not ours to read */ }
    }
  } else if (process.platform === 'darwin') {
    const out = await new Promise((resolve) => execFile('/bin/ps', ['-axo', 'pid=,args='],
      (err, stdout) => resolve(err ? '' : String(stdout))));
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && m[2].startsWith(`${process.execPath} `)) keep(Number(m[1]), m[2].slice(process.execPath.length).split(' '));
    }
  } else if (process.platform === 'win32') {
    // WQL quotes with ', and wants each \ in the path doubled.
    const exe = process.execPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ExecutablePath='${exe}'" | ForEach-Object { "$($_.ProcessId)\t$($_.CommandLine)" }`]);
    for (const line of stdout.split(/\r?\n/)) {
      const [pid, cmd = ''] = line.split('\t');
      if (/^\d+$/.test(pid)) keep(Number(pid), cmd.split(' '));
    }
  }
  return found;
}

/**
 * Close this copy's private windows, and wait for them to go.
 *
 * Each is a process of its own (`--incognito`, incognito/launch.js) with its
 * own single-instance lock, so quitting this browser does not end it - and it
 * would go on running from the files about to be removed. Windows has the
 * uninstaller do the same for Debrowser-Incognito.exe (build/installer.nsh),
 * a name of its own this search would not find.
 */
async function closePrivateWindows() {
  const pids = (await processesOfThisCopy()).filter(([, args]) => args.includes('--incognito')).map(([pid]) => pid);
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  // A private window wipes its profile on the way out; give it the time.
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let waited = 0; waited < 5000 && pids.some(alive); waited += 100) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/**
 * How this copy is removed, or null when it was not installed (a checkout,
 * or a disk image). `does` finishes "Debrowser will …", `note` adds anything
 * the user will be asked; `remove` does it, up to the point where only
 * quitting is left.
 */
function plan() {
  if (!app.isPackaged) return null;
  if (process.platform === 'win32') {
    const exe = path.join(path.dirname(process.execPath), UNINSTALLER);
    if (!fs.existsSync(exe)) return null;
    return {
      does: 'be removed from this computer',
      remove({ removeData }) {
        const args = ['/currentuser', '/S', `--wait-pid=${process.pid}`];
        if (removeData) args.push('--delete-app-data');
        spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
      }
    };
  }
  if (process.platform === 'darwin') {
    const bundle = macBundle();
    if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/')) return null;
    return {
      does: 'be moved to the Trash',
      async remove({ removeData }) {
        await closePrivateWindows();
        await trash(bundle);
        if (removeData) removeAfterExit(dataPaths());
      }
    };
  }
  const kind = install.linuxKind();
  if (kind === 'deb') {
    return {
      does: 'be removed from this computer',
      note: 'Your system will ask for your password.',
      async remove({ removeData }) {
        await closePrivateWindows();
        // dpkg rather than apt: nothing depends on this package, so there is
        // nothing to resolve, and no apt lock to wait on. Purged, so its
        // AppArmor profile in /etc goes too: nothing of it is left behind.
        const { code, stderr } = await run('pkexec', ['/usr/bin/dpkg', '--purge', 'debrowser']);
        const instead = 'Remove Debrowser with your software manager, or with: sudo apt remove debrowser';
        // pkexec: 126 is a dismissed prompt. 127 is either a refusal - a wrong
        // password, or an account that may not - or no prompt to show at all,
        // and only its message tells them apart. Anything else is dpkg's.
        if (code === 126) throw new Error('The password was not given, so nothing was removed.');
        if (code === 127 && /not authori[sz]ed/i.test(stderr)) {
          throw new Error('The password was not accepted, or this account may not remove programs, so nothing was removed.');
        }
        if (code === 127 || code < 0) throw new Error(`Your system could not ask for a password. ${instead}`);
        if (code !== 0) throw new Error(`Removing the package failed (dpkg ${code}). ${instead}`);
        if (removeData) removeAfterExit(dataPaths());
      }
    };
  }
  if (kind === 'appimage' || kind === 'folder') {
    const target = kind === 'appimage' ? install.appImage() : path.dirname(process.execPath);
    // A folder is only removed when it is unmistakably ours: named for us,
    // with the app archive in it.
    if (kind === 'folder' && !(/debrowser/i.test(path.basename(target)) &&
        fs.existsSync(path.join(target, 'resources', 'app.asar')))) return null;
    return {
      does: kind === 'appimage'
        ? 'be moved to the Trash and taken out of your apps menu'
        : `be moved to the Trash with its folder, ${install.tilde(target)}, and taken out of your apps menu`,
      async remove({ removeData }) {
        await closePrivateWindows();
        install.removeEntry();
        await trash(target);
        if (removeData) removeAfterExit(dataPaths());
      }
    };
  }
  return null;
}

/* ---- The window ----------------------------------------------------------- */

/**
 * Show the window, or bring back the one already open.
 *
 * @param {object} opts
 * @param {object} opts.prefs - the preferences' values, for the design, theme and accent
 * @param {boolean} opts.browserOpen - whether confirming will close a running browser
 * @param {() => void} opts.onConfirmed - quit, once the removal is done or on its way
 * @param {() => void} [opts.onCancelled]
 * @param {(...args: any[]) => void} [opts.log]
 * @param {Electron.BaseWindow} [opts.owner] - the browser window; the question closes with it
 */
function show({ prefs, browserOpen, onConfirmed, onCancelled = () => {}, log = () => {}, owner = null }) {
  const how = plan();
  const lead = !how ? NOT_INSTALLED
    : [`Debrowser will ${browserOpen ? 'close, then ' : ''}${how.does}.`, how.note].filter(Boolean).join(' ');
  return showSetupWindow({
    prefs,
    owner,
    spec: {
      title: 'Uninstall Debrowser?',
      lead,
      check: {
        label: 'Also delete your browsing data',
        detail: 'History, bookmarks, saved passwords, cookies and settings. Leave this off to keep them for a reinstall.',
        danger: true
      },
      cancel: 'Cancel',
      confirm: 'Uninstall',
      busy: 'Uninstalling…',
      danger: true
    },
    async onConfirm(removeData) {
      // Nothing to quit for when nothing was removed: the browser stays.
      if (!how) throw new Error(NOT_INSTALLED);
      await how.remove({ removeData });
      log('uninstall', `removed${removeData ? ', deleting browsing data' : ''}`);
      onConfirmed();
    },
    onClosed: (confirmed) => { if (!confirmed) onCancelled(); }
  });
}

/** Sent with `--uninstall` to a running browser, so it acts only for its own copy. */
const lockData = () => ({ uninstallFor: process.execPath });

/**
 * Whether a second launch's `--uninstall` is for the browser that received it.
 * The single-instance lock is the profile's, which every copy of Debrowser
 * shares - so a request from another copy reaches this one too, and must not
 * uninstall it.
 */
function forThisCopy(argv, data) {
  if (!requested(argv) || !data || typeof data.uninstallFor !== 'string') return false;
  try {
    return fs.realpathSync(data.uninstallFor) === fs.realpathSync(process.execPath);
  } catch {
    return false;
  }
}

/**
 * The standalone case: `--uninstall` started a process of its own. If this
 * copy's browser is open, the request is handed to it (`second-instance`) so
 * it closes the ordinary way; otherwise this shows the window, and quits when
 * it closes. Returns true when it has taken over this launch.
 */
function runStandalone({ prefs, log }) {
  if (!requested(process.argv)) return false;
  let win = null;
  app.on('second-instance', () => { if (win && !win.isDestroyed()) win.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    const browser = (await processesOfThisCopy())
      .some(([, args]) => !args.includes('--incognito') && !args.includes(FLAG));
    // Asked of the lock either way. Open here, it is handed the request; free,
    // holding it stops this copy's browser starting while its files go. Held
    // by another copy, which ignores a request that is not its own, it changes
    // nothing: this copy is not running, so the window is shown here.
    const got = app.requestSingleInstanceLock(lockData());
    if (browser && !got) { app.quit(); return; }
    win = show({ prefs, browserOpen: false, onConfirmed: () => app.quit(), onCancelled: () => app.quit(), log });
  });
  return true;
}

module.exports = { run: runStandalone, show, requested, forThisCopy, plan, FLAG };
