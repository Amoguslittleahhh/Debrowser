// Photograph the browser's own pages, so they can be looked at rather than
// imagined. Each page is loaded into a window the size the real view gets,
// with a stub bridge supplying the state its scripts ask for.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const R = '/home/user/Debrowser/src/renderer';
const OUT = '/tmp/claude-0/ui';

const TABS = [
  { id: 1, title: 'Release v1.4.0 · Amoguslittleahhh/Debrowser', url: 'https://github.com/x', visible: true,  tier: 'active', rssMB: 96, loading: false, favicon: null, audible: false, boosted: false },
  { id: 2, title: 'Gmail: Secure, AI-powered email',            url: 'https://mail.google.com', visible: false, tier: 'warm',  rssMB: 61, loading: false, favicon: null, audible: true,  boosted: false },
  { id: 3, title: 'Perspective-Taking: Emerging research',       url: 'https://www.nature.com/a', visible: false, tier: 'cold',  rssMB: 28, loading: true,  favicon: null, audible: false, boosted: false },
  { id: 4, title: 'YouTube',                                     url: 'https://youtube.com', visible: false, tier: 'frozen', rssMB: 12, loading: false, favicon: null, audible: false, boosted: false },
  { id: 5, title: 'New tab',                                     url: 'debrowser://newtab', visible: false, tier: 'discarded', rssMB: 0, loading: false, favicon: null, audible: false, boosted: false }
];

const STATE = {
  tabs: TABS, activeId: 1, totalMB: 1205, budgetMB: 6144, rssTotalMB: 512,
  privateTotalMB: 300, pressure: 'none', liveTabs: 6, maxLiveTabs: 12,
  rendererCount: 3, bookmarksBar: true, bookmarksRevision: 1,
  downloads: { count: 3, active: 1, progress: 0.42 },
  sidebar: null,
  searchEngines: [{ id: 'google', name: 'Google' }, { id: 'ddg', name: 'DuckDuckGo' }],
  updates: { available: true, reason: null, state: 'ready', version: '1.5.0', progress: 100, error: null },
  prefs: {
    theme: 'dark', accent: '#5b8cff', tabWidth: 'roomy', tabBarColor: 'default',
    windowOpacity: 1, tabBarPosition: 'top', backgroundMaterial: 'none',
    reduceMotion: false, showMemoryMeter: true, showTierDots: true,
    searchEngine: 'google', homepage: '', saveHistory: true, memoryBudgetMB: null,
    maxLiveTabs: null, showMemoryDetail: false, hardwareAcceleration: true,
    fillPasswords: true, downloadConnections: 4, autoUpdate: true,
    devToolsDock: 'right', showBookmarksBar: true, sidebarPinned: false,
    requirePresence: false
  }
};

const ANSWERS = {
  'list-bookmarks': { items: [
    { id: 'a', url: 'https://github.com', title: 'GitHub', folder: '' },
    { id: 'b', url: 'https://news.ycombinator.com', title: 'Hacker News', folder: '' },
    { id: 'c', url: 'https://developer.mozilla.org', title: 'MDN Web Docs', folder: '' },
    { id: 'd', url: 'https://youtube.com', title: 'YouTube', folder: '' }
  ] },
  'list-downloads': { items: [
    { id: 'd1', url: 'https://github.com/rel/Debrowser-1.4.0-win-x64.exe', filename: 'Debrowser-1.4.0-win-x64.exe', state: 'running', total: 111810824, received: 47000000, segments: 4, error: null, bytesPerSecond: 5400000 },
    { id: 'd2', url: 'https://example.com/report.pdf', filename: 'Q3-report.pdf', state: 'done', total: 2400000, received: 2400000, segments: 4, error: null, bytesPerSecond: 0 },
    { id: 'd3', url: 'https://example.com/big.zip', filename: 'archive-of-everything.zip', state: 'failed', total: 0, received: 12000, segments: 1, error: 'server refused a range with 503', bytesPerSecond: 0 }
  ] },
  'list-history': { total: 482, recording: true, items: [
    { id: 'h1', url: 'https://github.com/Amoguslittleahhh/Debrowser', title: 'Amoguslittleahhh/Debrowser', visitedAt: Date.now() - 6e5, visits: 14, icon: null },
    { id: 'h2', url: 'https://mail.google.com/mail/u/0', title: 'Inbox (8) - Gmail', visitedAt: Date.now() - 36e5, visits: 3, icon: null },
    { id: 'h3', url: 'https://www.apple.com/iphone/', title: 'iPhone - Compare Models', visitedAt: Date.now() - 9e7, visits: 1, icon: null }
  ] },
  'list-credentials': { available: true, reason: null, logins: [
    { id: 'c1', site: 'https://github.com', username: 'amogus36311@gmail.com' }
  ], payments: [] },
  'presence-capability': { available: false, reason: 'no system presence check on linux' },
  'menu-model': null,
  'check-for-updates': STATE.updates
};

const SHOTS = [
  { name: 'chrome',   file: 'chrome.html',   w: 1280, h: 118 },
  { name: 'sidebar',  file: 'chrome.html',   w: 240,  h: 820, side: true },
  { name: 'settings', file: 'settings.html', w: 1280, h: 860 },
  { name: 'history',  file: 'history.html',  w: 1280, h: 700 },
  { name: 'downloads', file: 'downloads.html', w: 1280, h: 700 },
  { name: 'newtab',   file: 'newtab.html',   w: 1280, h: 700 },
  { name: 'panel',    file: 'panel.html',    w: 360,  h: 700 },
  { name: 'flyout',   file: 'flyout.html',   w: 700,  h: 520 },
  { name: 'update',   file: 'update.html',   w: 900,  h: 560 }
];


const ONLY = process.argv.find((a) => a.startsWith('--only='));
const WANTED = ONLY ? SHOTS.filter((s) => s.name === ONLY.slice(7)) : SHOTS;

process.on('unhandledRejection', (e) => console.log('unhandled:', e && e.message));
process.on('uncaughtException', (e) => console.log('uncaught:', e && e.message));

app.whenReady().then(async () => {
  for (const shot of WANTED) {
    if (shot.side) {
      STATE.prefs.tabBarPosition = 'left';
      STATE.sidebar = { pinned: true, open: true };
      STATE.bookmarksBar = false;
    } else {
      STATE.prefs.tabBarPosition = 'top';
      STATE.sidebar = null;
      STATE.bookmarksBar = true;
    }

    const win = new BrowserWindow({
      // Doubled, because `force-device-scale-factor 2` makes the window's
      // dimensions *device* pixels: at 1280 the page would lay out in a 640px
      // CSS viewport and every judgement from the picture would be about a
      // window half the size of the real one. Nearly cost a fix to a tab strip
      // that was not broken.
      show: false, width: shot.w, height: shot.h, frame: false,
      backgroundColor: '#16181d',
      webPreferences: {
        preload: path.join(OUT, 'stub-preload.js'),
        contextIsolation: true, sandbox: false,
        additionalArguments: [`--state=${JSON.stringify(STATE)}`, `--answers=${JSON.stringify(ANSWERS)}`]
      }
    });
    const anchored = ['flyout', 'update', 'menu'].includes(shot.name);
    const opts = anchored ? { query: { x: '520', y: '40', right: '560' } } : {};
    // The promise rejects spuriously on some of these while the page loads
    // perfectly well, so the paint is what is waited on, not the promise.
    win.loadFile(path.join(R, shot.file), opts).catch(() => {});
    await new Promise((r) => setTimeout(r, 1400));

    // The viewport is asserted, not assumed. `force-device-scale-factor` was in
    // this harness to get crisp text and it made the CSS viewport half the
    // window - so every picture was of a 640px-wide browser, and the tab strip
    // looked broken because at that width it genuinely is cramped. Twice I was
    // one step from "fixing" a strip that measured perfectly correct.
    const seen = await win.webContents.executeJavaScript('window.innerWidth').catch(() => 0);
    if (seen !== shot.w) {
      console.log('WRONG VIEWPORT', shot.name, 'wanted', shot.w, 'got', seen);
      win.destroy();
      continue;
    }
    try {
      const img = await Promise.race([
        win.webContents.capturePage(),
        new Promise((_r, reject) => setTimeout(() => reject(new Error('capture timed out')), 8000))
      ]);
      fs.writeFileSync(path.join(OUT, `${shot.name}.png`), img.toPNG());
      console.log('shot', shot.name, img.getSize().width + 'x' + img.getSize().height);
    } catch (err) {
      console.log('MISSED', shot.name, err.message);
    }
    win.destroy();
  }
  app.exit(0);
});
