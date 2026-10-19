'use strict';

/*
 * Sites installed as apps, as Chrome installs them: a site's own window,
 * without tabs or an address bar, opened from a shortcut of its own - in the
 * Start menu and on the desktop on Windows, in the applications menu on
 * Linux, in ~/Applications on macOS. The shortcut starts Debrowser with
 * `--web-app=<id>`; a Debrowser already running hears it as a second launch.
 *
 * What the site's web app manifest says - its name, start page, scope, icon
 * and colour - is used where it has one; a site without one is installed as
 * the page it is on, with its title and favicon.
 *
 * Kept in apps.json beside the profile, each app's icon in apps/. Never in a
 * private window: an installed app is a thing left on the computer.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'apps.json';

/** A PNG inside an .ico, which is all a Windows shortcut's icon needs. */
function pngToIco(png, size = 256) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size >= 256 ? 0 : size, 6);
  header.writeUInt8(size >= 256 ? 0 : size, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

/** A name safe for a file: what the shortcut is called. */
function fileName(name) {
  return String(name || 'App').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'App';
}

/**
 * The app a page describes: its manifest, resolved against where it came
 * from, or the page itself. Null for anything but an http(s) page. The start
 * page and scope must be on the page's own origin, as Chrome requires.
 */
function describe(page) {
  let url;
  try { url = new URL(page.url); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const m = page.manifest && typeof page.manifest === 'object' ? page.manifest : {};
  const base = page.manifestUrl || page.url;
  const resolve = (value, fallback) => {
    try {
      const u = new URL(String(value), base);
      return u.origin === url.origin ? u.href : fallback;
    } catch { return fallback; }
  };
  const startUrl = m.start_url ? resolve(m.start_url, url.href) : url.href;
  const scope = m.scope ? resolve(m.scope, url.origin + '/') : new URL('.', startUrl).href;
  const name = String(m.short_name || m.name || page.title || url.hostname).trim().slice(0, 80) || url.hostname;
  const icons = [];
  for (const i of Array.isArray(m.icons) ? m.icons : []) {
    if (!i || !i.src || /svg/i.test(String(i.type || i.src))) continue;
    const size = Math.max(0, ...String(i.sizes || '').split(/\s+/).map((s) => Number(s.split('x')[0]) || 0));
    try { icons.push({ src: new URL(String(i.src), base).href, size }); } catch { /* skipped */ }
  }
  for (const i of page.icons || []) {
    if (!i || !i.src || /\.svg(\?|$)/i.test(i.src)) continue;
    icons.push({ src: i.src, size: Number(String(i.sizes || '').split('x')[0]) || (/apple-touch/.test(i.rel || '') ? 180 : 16) });
  }
  // The smallest one at least 192 pixels across, or else the largest.
  icons.sort((a, b) => a.size - b.size);
  const icon = icons.find((i) => i.size >= 192) || icons[icons.length - 1] || null;
  const color = typeof m.theme_color === 'string' ? m.theme_color : page.theme || null;
  return { name, startUrl, scope, iconUrl: icon && icon.src, themeColor: color && /^#[0-9a-f]{3,8}$|^[a-z]+$|^rgb/i.test(color) ? color : null };
}

class WebApps {
  /**
   * @param {object} o
   * @param {string|null} o.dir the profile folder; null keeps them in memory (tests)
   * @param {(msg: string) => void} [o.log]
   * @param {object} [o.shortcuts] where shortcuts go; the system's places by default
   */
  constructor({ dir, log = () => {}, shortcuts = null } = {}) {
    this.dir = dir;
    this.log = log;
    this.places = shortcuts;
    this.apps = [];
    this.windows = new Map();
    if (dir) {
      try { this.apps = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')).filter((a) => a && a.id && a.startUrl); } catch { /* none yet */ }
    }
  }

  save() {
    if (!this.dir) return;
    fs.writeFileSync(path.join(this.dir, FILE), JSON.stringify(this.apps, null, 2));
  }

  list() { return this.apps.map((a) => ({ ...a })); }

  byId(id) { return this.apps.find((a) => a.id === id) || null; }

  /** Whether an address is inside an app's scope: it stays in the app's window. */
  inScope(app, url) {
    return String(url).startsWith(app.scope);
  }

  /**
   * Install one: kept, its icon saved, its shortcuts written. Installing the
   * same start page again updates it in place.
   * @param {ReturnType<typeof describe>} info
   * @param {Buffer|null} png its icon, already fetched
   */
  install(info, png = null) {
    const id = crypto.createHash('sha256').update(info.startUrl).digest('hex').slice(0, 16);
    const app = { id, name: info.name, startUrl: info.startUrl, scope: info.scope, themeColor: info.themeColor || null,
      installedAt: (this.byId(id) || {}).installedAt || Date.now(), icon: null, shortcuts: [] };
    if (png && this.dir) {
      const folder = path.join(this.dir, 'apps');
      fs.mkdirSync(folder, { recursive: true });
      app.icon = path.join(folder, `${id}.png`);
      fs.writeFileSync(app.icon, png);
      if (process.platform === 'win32') fs.writeFileSync(path.join(folder, `${id}.ico`), pngToIco(png));
    }
    const old = this.byId(id);
    if (old) this.removeShortcuts(old);
    try { app.shortcuts = this.writeShortcuts(app); } catch (err) { this.log(`apps: shortcut for ${app.name} not written: ${err.message}`); }
    this.apps = [...this.apps.filter((a) => a.id !== id), app];
    this.save();
    this.log(`apps: installed ${app.name} (${app.startUrl})`);
    return { ...app };
  }

  remove(id) {
    const app = this.byId(id);
    if (!app) return false;
    this.removeShortcuts(app);
    for (const f of [app.icon, app.icon && app.icon.replace(/\.png$/, '.ico')]) {
      if (f) try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
    }
    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) win.close();
    this.apps = this.apps.filter((a) => a.id !== id);
    this.save();
    return true;
  }

  /** The command a shortcut runs: this Debrowser, opening the app. */
  launcher(app) {
    const { app: electronApp } = require('electron');
    const exec = process.env.APPIMAGE || process.execPath;
    // Run from source (`electron .`) the app's folder comes first.
    const args = electronApp && !electronApp.isPackaged ? [electronApp.getAppPath(), `--web-app=${app.id}`] : [`--web-app=${app.id}`];
    return { exec, args };
  }

  /** Where the shortcuts go on this system. */
  where() {
    if (this.places) return this.places;
    const os = require('os');
    const home = os.homedir();
    if (process.platform === 'win32') {
      const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      return { menu: path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), desktop: path.join(home, 'Desktop') };
    }
    if (process.platform === 'darwin') return { menu: path.join(home, 'Applications'), desktop: null };
    return { menu: path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'applications'), desktop: null };
  }

  writeShortcuts(app) {
    const { exec, args } = this.launcher(app);
    const { menu, desktop } = this.where();
    const name = fileName(app.name);
    const written = [];
    if (process.platform === 'win32' && !this.places) {
      const { shell } = require('electron');
      const ico = app.icon ? app.icon.replace(/\.png$/, '.ico') : exec;
      for (const folder of [menu, desktop].filter(Boolean)) {
        const file = path.join(folder, `${name}.lnk`);
        fs.mkdirSync(folder, { recursive: true });
        if (shell.writeShortcutLink(file, 'create', { target: exec, args: args.map((a) => `"${a}"`).join(' '),
          description: `${app.name}, a Debrowser app`, icon: ico, iconIndex: 0, appUserModelId: `Debrowser.App.${app.id}` })) written.push(file);
      }
      return written;
    }
    if (process.platform === 'darwin' && !this.places) {
      // A small bundle whose only part is a script that starts Debrowser with
      // the app's id: Debrowser, already running, hears it as a second launch.
      const bundle = path.join(menu, `${name}.app`);
      const macos = path.join(bundle, 'Contents', 'MacOS');
      fs.mkdirSync(macos, { recursive: true });
      const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      fs.writeFileSync(path.join(macos, 'launch'), `#!/bin/sh\nexec ${[exec, ...args].map(quote).join(' ')} >/dev/null 2>&1 &\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${name.replace(/[<&]/g, '')}</string>
<key>CFBundleIdentifier</key><string>app.debrowser.webapp.${app.id}</string>
<key>CFBundleExecutable</key><string>launch</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
      return [bundle];
    }
    // Linux, and anywhere a test names the folder: a .desktop entry.
    const quote = (s) => (/[\s"'\\$`]/.test(s) ? `"${String(s).replace(/(["\\$`])/g, '\\$1')}"` : s);
    const entry = ['[Desktop Entry]', 'Type=Application', `Name=${app.name.replace(/[\r\n]/g, ' ')}`,
      `Comment=${app.startUrl}`, `Exec=${[exec, ...args].map(quote).join(' ')}`,
      ...(app.icon ? [`Icon=${app.icon}`] : []), `StartupWMClass=debrowser-app-${app.id}`, 'Categories=Network;', ''].join('\n');
    for (const folder of [menu, desktop].filter(Boolean)) {
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `debrowser-app-${app.id}.desktop`);
      fs.writeFileSync(file, entry, { mode: 0o755 });
      written.push(file);
    }
    return written;
  }

  removeShortcuts(app) {
    for (const f of app.shortcuts || []) {
      try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* gone */ }
    }
  }

  /**
   * Its window, as Edge draws an installed site: no tabs and no address
   * bar, only a slim title bar of the app's own colour - its icon, the page's
   * title, a ⋯ menu and the system's window buttons - over the site. A link
   * out of its scope opens as a tab in Debrowser instead, as Chrome does. One
   * window per app; opening it again brings that one forward.
   * @param {object} hooks
   * @param {Electron.Session} hooks.session
   * @param {(url: string) => void} hooks.openInBrowser
   * @param {(id: string) => void} [hooks.uninstall] asked from its menu
   */
  open(id, { session: ses, openInBrowser, uninstall = null }) {
    const app = this.byId(id);
    if (!app) return null;
    const open = this.windows.get(id);
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore();
      open.focus();
      return open;
    }
    const { BaseWindow, WebContentsView, Menu, clipboard, nativeImage } = require('electron');
    const mac = process.platform === 'darwin';
    let colors = barColors(app.themeColor);
    const win = new BaseWindow({
      width: 1100, height: 760, minWidth: 360, minHeight: 300, title: app.name, show: false,
      backgroundColor: colors.bg, titleBarStyle: 'hidden',
      ...(mac ? { trafficLightPosition: { x: 12, y: 11 } } : { titleBarOverlay: { color: colors.bg, symbolColor: colors.fg, height: BAR } }),
      ...(app.icon ? { icon: nativeImage.createFromPath(app.icon) } : {})
    });
    // Its own taskbar button, with the site's icon, apart from Debrowser's;
    // pinned, it starts the app rather than the browser.
    if (process.platform === 'win32') {
      const { exec, args } = this.launcher(app);
      win.setAppDetails({ appId: `Debrowser.App.${app.id}`, appIconPath: app.icon ? app.icon.replace(/\.png$/, '.ico') : '',
        relaunchCommand: [exec, ...args].map((a) => `"${a}"`).join(' '), relaunchDisplayName: app.name });
    }
    let iconData = '';
    try { if (app.icon) iconData = `data:image/png;base64,${fs.readFileSync(app.icon).toString('base64')}`; } catch { /* none */ }
    const bar = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true } });
    const page = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    page.setBackgroundColor(colors.bg);
    win.contentView.addChildView(page);
    win.contentView.addChildView(bar);
    win.page = page;
    win.bar = bar;
    const wc = page.webContents;
    const place = () => {
      if (win.isDestroyed()) return;
      const { width, height } = win.getContentBounds();
      bar.setBounds({ x: 0, y: 0, width, height: BAR });
      page.setBounds({ x: 0, y: BAR, width, height: Math.max(0, height - BAR) });
    };
    win.on('resize', place);
    place();

    // The bar: a page of its own, nothing in it but the icon, the title and
    // the ⋯ button, which asks for the menu by following a link this side
    // catches - it has no other way to reach the browser.
    const paint = () => {
      if (bar.webContents.isDestroyed()) return;
      bar.webContents.executeJavaScript(`document.documentElement.style.setProperty('--bg', ${JSON.stringify(colors.bg)});
        document.documentElement.style.setProperty('--fg', ${JSON.stringify(colors.fg)});`).catch(() => {});
      if (!mac) try { win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.fg, height: BAR }); } catch { /* not here */ }
      win.setBackgroundColor(colors.bg);
    };
    const titled = () => {
      const t = wc.getTitle();
      const text = t && t !== app.name && !/^https?:/.test(t) ? t : app.name;
      win.setTitle(text);
      if (!bar.webContents.isDestroyed()) bar.webContents.executeJavaScript(`document.getElementById('t').textContent = ${JSON.stringify(text)};`).catch(() => {});
    };
    bar.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(barPage(app, iconData, colors, mac))}`).then(() => { paint(); titled(); }).catch(() => {});
    bar.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url.startsWith('debrowser-app:menu')) menu();
    });

    const menu = () => {
      const zoom = (d) => wc.setZoomFactor(d === 0 ? 1 : Math.min(3, Math.max(0.3, wc.getZoomFactor() + d)));
      const history = wc.navigationHistory;
      Menu.buildFromTemplate([
        { label: 'Back', accelerator: 'Alt+Left', enabled: Boolean(history?.canGoBack()), click: () => history.goBack() },
        { label: 'Forward', accelerator: 'Alt+Right', enabled: Boolean(history?.canGoForward()), click: () => history.goForward() },
        { label: 'Reload', accelerator: 'F5', click: () => wc.reload() },
        { type: 'separator' },
        { label: `Zoom in (${Math.round(wc.getZoomFactor() * 100)}%)`, click: () => zoom(0.1) },
        { label: 'Zoom out', click: () => zoom(-0.1) },
        { label: 'Actual size', click: () => zoom(0) },
        { type: 'separator' },
        { label: 'Copy link', click: () => clipboard.writeText(wc.getURL()) },
        { label: 'Open in Debrowser', click: () => openInBrowser(wc.getURL()) },
        { label: 'Print…', click: () => wc.print() },
        { type: 'separator' },
        { label: `${app.name} · ${new URL(app.startUrl).host}`, enabled: false },
        ...(uninstall ? [{ label: `Uninstall ${app.name}…`, click: () => uninstall(app.id) }] : [])
      ]).popup({ window: win, x: Math.max(0, win.getContentBounds().width - (mac ? 44 : 180)), y: BAR });
    };

    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) openInBrowser(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      if (/^https?:/i.test(url)) {
        if (!this.inScope(app, url)) { event.preventDefault(); openInBrowser(url); }
        return;
      }
      // Nowhere else: the browser's own pages took the site's words as a
      // tab did (tab.js), and an app is a website and nothing more.
      if (!/^(about|blob):/i.test(url)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => { if (!/^https?:/i.test(url)) event.preventDefault(); });
    // The bar takes the colour the site asks for, as Edge's does.
    wc.on('did-change-theme-color', (_e, color) => { if (color) { colors = barColors(color); paint(); } });
    // Back, forward and reload from the keyboard, as in a tab.
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const mod = mac ? input.meta : input.control;
      if ((input.alt && input.key === 'ArrowLeft') || (mod && input.key === '[')) { wc.navigationHistory?.goBack(); event.preventDefault(); }
      else if ((input.alt && input.key === 'ArrowRight') || (mod && input.key === ']')) { wc.navigationHistory?.goForward(); event.preventDefault(); }
      else if (input.key === 'F5' || (mod && input.key.toLowerCase() === 'r')) { wc.reload(); event.preventDefault(); }
    });
    wc.on('page-title-updated', titled);
    wc.once('did-finish-load', () => { if (!win.isDestroyed()) win.show(); });
    setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 3000);
    win.on('closed', () => {
      if (this.windows.get(id) === win) this.windows.delete(id);
      for (const v of [page, bar]) try { v.webContents.close(); } catch { /* gone */ }
    });
    this.windows.set(id, win);
    wc.loadURL(app.startUrl).catch(() => {});
    return win;
  }
}

/** How tall an app's title bar is, as Edge's. */
const BAR = 34;

/** The bar's background and text for a site's theme colour: dark text on a light one. */
function barColors(color) {
  const fallback = { bg: '#1f1f1f', fg: '#e8e8e8' };
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return fallback;
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { bg: `#${hex}`, fg: lum > 0.55 ? '#1d1d1d' : '#f2f2f2' };
}

/** The title bar's own page. */
function barPage(app, icon, colors, mac) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
:root{--bg:${colors.bg};--fg:${colors.fg}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px system-ui,"Segoe UI",sans-serif;overflow:hidden;user-select:none}
.bar{display:flex;align-items:center;gap:10px;height:100%;padding:0 ${mac ? '12px 0 80px' : '170px 0 10px'};-webkit-app-region:drag}
img{width:16px;height:16px;border-radius:3px}
#t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}
a{-webkit-app-region:no-drag;color:inherit;text-decoration:none;width:36px;height:26px;display:grid;place-items:center;border-radius:6px;opacity:.8;font-size:16px;letter-spacing:1px}
a:hover{background:color-mix(in srgb,var(--fg) 14%,transparent);opacity:1}
</style></head><body><div class="bar">${icon ? `<img src="${icon}" alt="">` : ''}<span id="t">${esc(app.name)}</span><a href="debrowser-app:menu" title="Settings and more" aria-label="Settings and more">⋯</a></div></body></html>`;
}

/** The `--web-app=<id>` on a command line, or null. */
function appArg(argv) {
  for (const a of argv || []) {
    const m = /^--web-app=([0-9a-f]{16})$/.exec(String(a));
    if (m) return m[1];
  }
  return null;
}

module.exports = { WebApps, describe, pngToIco, appArg, fileName };
