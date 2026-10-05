'use strict';

/**
 * Installing, where the system has no installer for us to draw: macOS and
 * Linux. Windows has its own (build/installer.nsh, native/helpers/setup-ui.c).
 *
 *   macOS   A downloaded app runs from wherever it was opened - the disk image,
 *           or Downloads - and from a disk image it cannot update itself and
 *           is gone when the image is ejected. Offered: Move to Applications,
 *           which moves it and starts it again from there.
 *   Linux   The AppImage and the .tar.gz are programs in a file or a folder,
 *           not in the apps menu. Offered: Add to your apps - the AppImage
 *           moved to ~/Applications, and for both a menu entry with the icon,
 *           which also carries an Uninstall action. Nothing restarts. The .deb is installed by
 *           the package manager and is left to it.
 *
 * Asked in the setup window (setup-window.js), a few seconds after the browser
 * opens, once per version: Not now is remembered until the next update. It is
 * also in Settings → Advanced for whenever the user wants it.
 */

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { showSetupWindow } = require('./setup-window');

/* ---- Linux: the menu entry ---------------------------------------------- */

const dataHome = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
/** Named as package.json's `desktopName`, so the window and the entry are matched up. */
const desktopFile = () => path.join(dataHome(), 'applications', 'debrowser.desktop');
const iconFile = () => path.join(dataHome(), 'icons', 'hicolor', '512x512', 'apps', 'debrowser.png');
const APPIMAGE_HOME = () => path.join(os.homedir(), 'Applications', 'Debrowser.AppImage');
/**
 * Marks the entry as written by this, and for which program, as it was given:
 * uninstalling a copy removes its own entry and never another copy's.
 */
const OURS = 'X-Debrowser-Exec=';

/**
 * The AppImage file this runs from, or null. APPIMAGE alone is not enough: it
 * is inherited, so a Debrowser opened from another AppImage's link would take
 * that program's file for its own. Ours is the one whose mount (APPDIR) holds
 * the executable that is running.
 */
function appImage() {
  const { APPIMAGE, APPDIR } = process.env;
  return APPIMAGE && APPDIR && process.execPath.startsWith(path.resolve(APPDIR) + path.sep) ? APPIMAGE : null;
}

/** How this copy is installed: 'appimage', 'deb', 'folder', or null when unpackaged or not Linux. */
function linuxKind() {
  if (process.platform !== 'linux' || !app.isPackaged) return null;
  if (appImage()) return 'appimage';
  if (process.execPath.startsWith('/opt/') && fs.existsSync('/var/lib/dpkg/info/debrowser.list')) return 'deb';
  return 'folder';
}

/** A path as a person reads it: the home folder as ~. */
const tilde = (p) => (p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);

/** The program a menu entry should start: the AppImage file, or the executable. */
const launcher = () => appImage() || process.execPath;

/** The program our menu entry starts, or null when there is no entry of ours. */
function entryProgram() {
  try {
    const line = fs.readFileSync(desktopFile(), 'utf8').split('\n').find((l) => l.startsWith(OURS));
    return line ? line.slice(OURS.length) : null;
  } catch {
    return null;
  }
}

/** Whether the apps menu already starts this copy, through an entry of ours - by any spelling of its path. */
function integrated() {
  const program = entryProgram();
  return program !== null && (program === launcher() || sameFile(program, launcher()));
}

/**
 * A path as one argument of an Exec line. The Desktop Entry spec quotes it,
 * backslash-escapes " ` $ and \ inside the quotes, then escapes every
 * backslash again as a string value - and a literal % is %%.
 */
function execArg(p) {
  if (/[\n\r]/.test(p)) throw new Error('Debrowser is in a folder whose name a menu entry cannot hold.');
  const quoted = `"${p.replace(/["`$\\]/g, (c) => `\\${c}`)}"`;
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

function writeEntry(exe) {
  // The icon ships beside the app (electron-builder.yml, linux extraResources);
  // an AppImage also carries one at the root of its image.
  const icons = [path.join(process.resourcesPath, 'icon.png'),
    process.env.APPDIR && path.join(process.env.APPDIR, 'debrowser.png'),
    process.env.APPDIR && path.join(process.env.APPDIR, '.DirIcon')].filter(Boolean);
  const icon = icons.find((p) => fs.existsSync(p));
  if (icon) {
    fs.mkdirSync(path.dirname(iconFile()), { recursive: true });
    fs.copyFileSync(icon, iconFile());
  }
  // The private window's own, for its action (private-icon.js).
  let privateIcon = null;
  const privateSource = require('../private-icon').privateIconPath('png');
  if (privateSource) {
    privateIcon = path.join(path.dirname(iconFile()), 'debrowser-private.png');
    try {
      fs.mkdirSync(path.dirname(privateIcon), { recursive: true });
      fs.copyFileSync(privateSource, privateIcon);
    } catch { privateIcon = null; }
  }
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Debrowser',
    'Comment=A web browser that keeps out of the way of your computer.',
    `Exec=${execArg(exe)} %U`,
    `Icon=${icon ? iconFile() : 'debrowser'}`,
    'Terminal=false',
    'Categories=Network;WebBrowser;',
    'MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;',
    'StartupWMClass=Debrowser',
    'Actions=new-private-window;uninstall;',
    `${OURS}${exe}`,
    '',
    '[Desktop Action new-private-window]',
    'Name=New private window',
    `Exec=${execArg(exe)} --new-private-window`,
    ...(privateIcon ? [`Icon=${privateIcon}`] : []),
    '',
    '[Desktop Action uninstall]',
    'Name=Uninstall Debrowser',
    `Exec=${execArg(exe)} --uninstall`,
    ''
  ].join('\n');
  fs.mkdirSync(path.dirname(desktopFile()), { recursive: true });
  fs.writeFileSync(desktopFile(), entry);
  // Most menus watch the folder; this is for the ones that read a cache.
  require('child_process').execFile('update-desktop-database', [path.dirname(desktopFile())], () => {});
}

/** This copy's menu entry and icon, if it has one; another copy's is left. Used by uninstall.js. */
function removeEntry() {
  if (!integrated()) return;
  fs.rmSync(desktopFile(), { force: true });
  fs.rmSync(iconFile(), { force: true });
  fs.rmSync(path.join(path.dirname(iconFile()), 'debrowser-private.png'), { force: true });
}

/** Whether two paths name one file - through a symlink, a hard link or a second spelling. */
function sameFile(a, b) {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/* ---- What can be offered here ------------------------------------------- */

/**
 * The question for this copy, or null when there is nothing to install: on
 * Windows, from the .deb, unpackaged, or already where it belongs.
 */
function offerFor() {
  if (process.platform === 'darwin') {
    if (!app.isPackaged || app.isInApplicationsFolder()) return null;
    const fromImage = process.execPath.startsWith('/Volumes/');
    return {
      title: 'Move Debrowser to Applications?',
      lead: fromImage
        ? 'Debrowser is running from its disk image. In Applications it stays when the image is ejected, and keeps itself up to date.'
        : 'Debrowser is running from outside Applications. Moved there, it is where you expect to find it, and keeps itself up to date.',
      check: null,
      cancel: 'Not now',
      confirm: 'Move to Applications',
      busy: 'Moving…'
    };
  }
  const kind = linuxKind();
  if (kind === 'appimage' && !integrated()) {
    return {
      title: 'Add Debrowser to your apps?',
      lead: 'Debrowser moves to the Applications folder in your home folder and appears in your apps menu, so you can start it like any other app. It keeps updating itself.',
      check: null,
      cancel: 'Not now',
      confirm: 'Add to apps',
      busy: 'Adding…'
    };
  }
  if (kind === 'folder' && !integrated()) {
    return {
      title: 'Add Debrowser to your apps?',
      lead: `Debrowser appears in your apps menu, started from where it is now, ${tilde(path.dirname(process.execPath))}. Keep the folder there.`,
      check: null,
      cancel: 'Not now',
      confirm: 'Add to apps',
      busy: 'Adding…'
    };
  }
  return null;
}

/** Do it. Resolves when done; on macOS the app then starts again from Applications. */
async function install({ log }) {
  if (process.platform === 'darwin') {
    // A copy already in Applications and not running is replaced; one that is
    // running cannot be, and the move fails rather than closing it.
    const moved = app.moveToApplicationsFolder({ conflictHandler: (type) => type === 'exists' });
    if (!moved) throw new Error('A copy of Debrowser in Applications is open. Quit it, then try again.');
    log('install', 'moved to Applications');
    return;
  }
  const kind = linuxKind();
  if (kind === 'appimage') {
    const from = appImage();
    const to = APPIMAGE_HOME();
    // Compared as files, not strings: copying a file onto itself and then
    // deleting "the original" would delete the only copy.
    if (!sameFile(from, to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // Copied, then the original removed: a rename fails across file systems,
      // and Downloads is often on another one. The running copy reads from its
      // mount, which outlives its file.
      fs.copyFileSync(from, to);
      fs.chmodSync(to, 0o755);
      try { fs.rmSync(from, { force: true }); } catch { /* left where it was */ }
    }
    writeEntry(to);
    // No restart: this copy runs on from its mount, and the menu starts the
    // moved one next time. Updates are written to the file named here.
    process.env.APPIMAGE = to;
    log('install', `AppImage added to the apps menu from ${to}`);
    return;
  }
  if (kind === 'folder') {
    writeEntry(process.execPath);
    log('install', 'added to the apps menu');
    return;
  }
  throw new Error('There is nothing to install for this copy of Debrowser.');
}

/**
 * Ask, if there is anything to ask and it was not declined for this version.
 * `force` (from Settings) asks regardless.
 */
function offer({ prefs, log, force = false, owner = null }) {
  const spec = offerFor();
  if (!spec) return null;
  if (!force && prefs.get('installAskedVersion') === app.getVersion()) return null;
  let win = null;
  win = showSetupWindow({
    spec,
    prefs: prefs.all(),
    owner,
    onConfirm: async () => {
      await install({ log });
      // Linux needs no restart: done, and the window has said all it needs
      // to. macOS has quit by now, to start again from Applications.
      if (!win.isDestroyed()) win.close();
    },
    onClosed: (confirmed) => {
      if (!confirmed) prefs.set('installAskedVersion', app.getVersion());
    }
  });
  return win;
}

module.exports = { offer, offerFor, linuxKind, removeEntry, appImage, tilde };
