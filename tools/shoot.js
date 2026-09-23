// Photograph the browser's own pages, so they can be looked at rather than
// imagined. Each page is loaded into a window the size the real view gets,
// with a stub bridge supplying the state its scripts ask for.
//
// Two things this harness gets wrong, both found the hard way, both worth
// knowing before believing a picture:
//
//  - Run one page per process. Every shot after the first comes back missed
//    when they share one, which is why the caller loops over `--only=`.
//  - A **text field whose value overflows it** photographs as a light tan
//    block. The DOM is innocent - computed background is the right dark, the
//    element at that point is the field, forcing a background changes nothing,
//    and shortening the value makes it go away - so it is uninitialised memory
//    in the field's own scrolling layer under software raster, and it differs
//    between runs. It does not happen on a real machine with a GPU. The
//    address bar in the 240px sidebar hits this every time.
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
    theme: 'dark', accent: '#2f857b', tabWidth: 'roomy', tabBarColor: 'default',
    windowOpacity: 1, tabBarPosition: 'top', backgroundMaterial: 'none',
    reduceMotion: false, showMemoryMeter: true, showTierDots: true,
    searchEngine: 'google', homepage: '', saveHistory: true, memoryBudgetMB: null,
    maxLiveTabs: null, showMemoryDetail: false, hardwareAcceleration: true,
    fillPasswords: true, downloadConnections: 4, autoUpdate: true,
    devToolsDock: 'right', showBookmarksBar: true, sidebarPinned: false,
    requirePresence: false, restoreSession: true, bookmarkOpensIn: 'new-tab',
    inlineAutocomplete: true, defaultZoom: 1, clearHistoryOnExit: false,
    newTabPosition: 'end', linkTabsInBackground: true, lastTabCloses: 'quit',
    confirmCloseTabs: false, tabCloseButton: 'hover', hoverPrefetch: true,
    rememberWindowBounds: true, downloadDir: '', askWhereToSave: false
  }
};

const ANSWERS = {
  'list-bookmarks': { items: [
    { id: 'a', url: 'https://github.com', title: 'GitHub', folder: '' },
    { id: 'b', url: 'https://news.ycombinator.com', title: 'Hacker News', folder: '' },
    { id: 'c', url: 'https://developer.mozilla.org', title: 'MDN Web Docs', folder: '' },
    { id: 'd', url: 'https://youtube.com', title: 'YouTube', folder: '' },
    // Enough to overflow a 1280px bar, because the chevron and what it hides
    // are the part of this bar that cannot be checked any other way.
    { id: 'e', url: 'https://en.wikipedia.org', title: 'Wikipedia, the free encyclopedia', folder: '' },
    { id: 'f', url: 'https://stackoverflow.com', title: 'Stack Overflow - Where Developers Learn', folder: '' },
    { id: 'g', url: 'https://www.apple.com/sg/', title: 'Apple (Singapore)', folder: '' },
    { id: 'h', url: 'https://mail.google.com', title: 'Inbox - Gmail', folder: '' },
    { id: 'i', url: 'https://nature.com', title: 'Nature - International journal of science', folder: '' },
    { id: 'j', url: 'https://claude.ai', title: 'Claude', folder: '' }
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
  'top-sites': { items: [
    { url: 'https://github.com/', title: 'GitHub', icon: null, visits: 140 },
    { url: 'https://mail.google.com/', title: 'Gmail', icon: null, visits: 96 },
    { url: 'https://news.ycombinator.com/', title: 'Hacker News', icon: null, visits: 61 },
    { url: 'https://developer.mozilla.org/', title: 'MDN', icon: null, visits: 44 },
    { url: 'https://www.youtube.com/', title: 'YouTube', icon: null, visits: 38 },
    { url: 'https://en.wikipedia.org/', title: 'Wikipedia', icon: null, visits: 27 },
    { url: 'https://www.nature.com/', title: 'Nature', icon: null, visits: 12 },
    { url: 'https://stackoverflow.com/', title: 'Stack Overflow', icon: null, visits: 9 }
  ] },
  'presence-capability': { available: false, reason: 'no system presence check on linux' },
  'menu-model': { prefs: null, items: [
    { id: 'new-tab', label: 'New tab', accel: 'Ctrl+T', icon: 'plus' },
    { kind: 'separator' },
    { id: 'open-history', label: 'History', accel: 'Ctrl+H', icon: 'clock' },
    { id: 'open-downloads', label: 'Downloads', accel: 'Ctrl+J', icon: 'download' },
    { kind: 'separator' },
    { kind: 'zoom', label: 'Zoom', value: 110, enabled: true },
    { id: 'toggle-fullscreen', label: 'Full screen', accel: 'F11', icon: 'expand', kind: 'checkbox', checked: false },
    { id: 'print', label: 'Print\u2026', accel: 'Ctrl+P', icon: 'print', enabled: true },
    { kind: 'separator' },
    { id: 'toggle-panel', label: 'Task manager', accel: 'Ctrl+M', icon: 'gauge', kind: 'checkbox', checked: false },
    { id: 'toggle-devtools', label: 'Developer tools', accel: 'F12', icon: 'code', kind: 'checkbox', checked: false },
    { id: 'open-settings', label: 'Settings', accel: 'Ctrl+,', icon: 'gear' },
    { kind: 'separator' },
    { kind: 'note', label: 'Debrowser 1.5.0' }
  ] },
  'context-model': { prefs: null, items: [
    { id: 'open-link-tab', label: 'Open link in new tab', icon: 'plus' },
    { id: 'copy-link', label: 'Copy link address', icon: 'copy' },
    { id: 'save-link', label: 'Save link as\u2026', icon: 'download' },
    { kind: 'separator' },
    { id: 'back', label: 'Back', icon: 'back', accel: 'Alt+\u2190', enabled: true },
    { id: 'forward', label: 'Forward', icon: 'forward', accel: 'Alt+\u2192', enabled: false },
    { id: 'reload', label: 'Reload', icon: 'reload', accel: 'Ctrl+R' },
    { kind: 'separator' },
    { id: 'bookmark-page', label: 'Bookmark this page', icon: 'star', accel: 'Ctrl+D' },
    { id: 'print', label: 'Print\u2026', icon: 'print', accel: 'Ctrl+P' },
    { id: 'view-source', label: 'View page source', icon: 'code', accel: 'Ctrl+U' },
    { id: 'inspect', label: 'Inspect', icon: 'inspect', accel: 'F12' }
  ] },
  // The tab strip's own menu. The sheet always asks for `context-model`, so
  // this is swapped in by the shot that wants it rather than served under a
  // name nothing requests.
  'tab-menu-model': { prefs: null, items: [
    { id: 'duplicate-tab', label: 'Duplicate', icon: 'copy' },
    { id: 'pin-tab', label: 'Pin', icon: 'star' },
    { id: 'mute-tab', label: 'Mute', icon: 'mute' },
    { kind: 'separator' },
    { id: 'close-tab', label: 'Close', icon: 'close' },
    { id: 'close-other-tabs', label: 'Close other tabs', icon: 'close' },
    { id: 'close-tabs-right', label: 'Close tabs to the right', icon: 'close' },
    { kind: 'separator' },
    { id: 'reopen-closed-tab', label: 'Reopen closed tab', icon: 'clock' }
  ] },
  'check-for-updates': STATE.updates
};

const SHOTS = [
  { name: 'chrome',   file: 'chrome.html',   w: 1280, h: 118 },
  // The same chrome in a window too narrow for its bookmarks, which is the only
  // way to see the overflow chevron and what the bar does with what is left.
  { name: 'chrome-narrow', file: 'chrome.html', w: 620, h: 118 },
  { name: 'sidebar',  file: 'chrome.html',   w: 240,  h: 820, side: true },
  // The collapsed strip, at the width the browser actually gives it. Ten
  // pixels is a degenerate picture and that is the point: everything in the
  // strip has to have stopped painting by then, or its fragments show as the
  // flicker that was reported.
  { name: 'strip',    file: 'chrome.html',   w: 10,   h: 820, side: true, collapsed: true },
  // Full screen, down the side: the strip is a panel over the page, and the
  // window sizes the view to what the chrome measures itself at. Photographed
  // at a plausible answer for eight tabs, which is the only way to see whether
  // a panel that stops partway down actually looks like one.
  { name: 'sidebar-float', file: 'chrome.html', w: 240, h: 480, side: true, floating: true },
  { name: 'settings', file: 'settings.html', w: 1280, h: 860 },
  // The same page, scrolled to a section that would otherwise be eight screens
  // down. Worth its own shot because the rows there are built by hand rather
  // than from the settings descriptors, so nothing else photographs them.
  { name: 'settings-bookmarks', file: 'settings.html', w: 1280, h: 860, hash: 'bookmarks' },
  // Startup, then the tab and window behaviours - the rows people come to
  // Settings to change most, and several of them selects of unequal width.
  { name: 'settings-browsing', file: 'settings.html', w: 1280, h: 860, hash: 'browsing' },
  { name: 'history',  file: 'history.html',  w: 1280, h: 700 },
  { name: 'downloads', file: 'downloads.html', w: 1280, h: 700 },
  { name: 'newtab',   file: 'newtab.html',   w: 1280, h: 700 },
  { name: 'panel',    file: 'panel.html',    w: 360,  h: 700 },
  { name: 'flyout',   file: 'flyout.html',   w: 700,  h: 520 },
  { name: 'update',   file: 'update.html',   w: 900,  h: 560 },
  { name: 'menu',     file: 'menu.html',     w: 900,  h: 560 },
  { name: 'context',  file: 'context.html',  w: 900,  h: 560 },
  // The same sheet holding the tab strip's menu, which is the other thing it
  // draws and has its own set of icons to get wrong.
  { name: 'tab-menu', file: 'context.html', w: 900, h: 560, answers: 'tab-menu-model' }
];


const ONLY = process.argv.find((a) => a.startsWith('--only='));
const WANTED = ONLY ? SHOTS.filter((s) => s.name === ONLY.slice(7)) : SHOTS;

process.on('unhandledRejection', (e) => console.log('unhandled:', e && e.message));
process.on('uncaughtException', (e) => console.log('uncaught:', e && e.message));

app.whenReady().then(async () => {
  for (const shot of WANTED) {
    // A shot may serve a different model through the channel the page asks on.
    // Before the window, because the answers are serialised into its preload
    // arguments - set after it, and the page has already been given the old set.
    if (shot.answers) ANSWERS['context-model'] = ANSWERS[shot.answers];

    if (shot.side) {
      STATE.prefs.tabBarPosition = 'left';
      STATE.sidebar = shot.collapsed
        ? { pinned: false, open: false }
        : { pinned: true, open: true, floating: shot.floating === true };
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
      backgroundColor: '#161614',
      webPreferences: {
        preload: path.join(OUT, 'stub-preload.js'),
        contextIsolation: true, sandbox: false,
        additionalArguments: [`--state=${JSON.stringify(STATE)}`, `--answers=${JSON.stringify(ANSWERS)}`]
      }
    });
    // The sheets take their anchor - and their palette - from the query string,
    // exactly as the browser passes them. Without the theme they render in
    // whatever `prefers-color-scheme` says, which is how this harness produced a
    // photograph of a white menu over a dark browser.
    const anchored = ['flyout', 'update', 'menu', 'context', 'tab-menu'].includes(shot.name);
    const opts = anchored
      ? { query: { x: '520', y: '40', right: '560',
                   theme: STATE.prefs.theme, accent: STATE.prefs.accent } }
      // A section far down a long page is reached the way the browser reaches
      // it - the fragment the menu's own links carry - rather than by scripting
      // a scroll from out here, which the page's scroll-spy undoes.
      : shot.hash ? { hash: shot.hash } : {};
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
