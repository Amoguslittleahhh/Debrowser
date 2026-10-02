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

// SHOOT_SCALE=2 for retina pictures. Only on a virtual screen big enough for
// the doubled window (Xvfb -screen 0 3840x2400x24): on a 1920px screen the
// window is clamped, the viewport comes out half-width, and the check below
// refuses every shot - which is what happened when this was always on.
if (process.env.SHOOT_SCALE) app.commandLine.appendSwitch('force-device-scale-factor', process.env.SHOOT_SCALE);
const path = require('path');
const fs = require('fs');

// Relative to this file, so it runs from any checkout; screenshots go where
// SHOOT_OUT says, or a directory under the system's temp folder.
const R = path.join(__dirname, '..', 'src', 'renderer');
const OUT = process.env.SHOOT_OUT || path.join(require('os').tmpdir(), 'debrowser-shots');
fs.mkdirSync(OUT, { recursive: true });

const TABS = [
  { id: 1, title: 'Release v1.4.0 · Amoguslittleahhh/Debrowser', url: 'https://github.com/x', visible: true,  tier: 'active', rssMB: 96, loading: false, favicon: null, audible: false, boosted: false },
  { id: 2, title: 'Gmail: Secure, AI-powered email',            url: 'https://mail.google.com', visible: false, tier: 'warm',  rssMB: 61, loading: false, favicon: null, audible: true,  boosted: false },
  { id: 3, title: 'Perspective-Taking: Emerging research',       url: 'https://www.nature.com/a', visible: false, tier: 'cold',  rssMB: 28, loading: true,  favicon: null, audible: false, boosted: false },
  { id: 4, title: 'YouTube',                                     url: 'https://youtube.com', visible: false, tier: 'frozen', rssMB: 12, loading: false, favicon: null, audible: false, boosted: false },
  { id: 5, title: 'New tab',                                     url: 'debrowser://newtab', visible: false, tier: 'discarded', rssMB: 0, loading: false, favicon: null, audible: false, boosted: false }
];

const STATE = {
  receipt: { freedMB: 1290, slept: 14, blocked: 312, cleaned: 6, stopped: 0 },
  tabs: TABS, activeId: 1, totalMB: 1205, budgetMB: 6144, rssTotalMB: 512,
  privateTotalMB: 300, pressure: 'none', liveTabs: 6, maxLiveTabs: 12,
  rendererCount: 3, bookmarksBar: true, bookmarksRevision: 1,
  downloads: { count: 3, active: 1, progress: 0.42 },
  // The task manager's footer line: what the governor has done this session.
  processCount: 9,
  stats: { freezes: 3, discards: 1, reclaimedMB: 842, heapCollections: 0, heapReclaimedMB: 0, hibernations: 0 },
  latency: { restore: { p50: 180 }, switch: { p50: 12 } },
  sidebar: null,
  searchEngines: [{ id: 'google', name: 'Google' }, { id: 'ddg', name: 'DuckDuckGo' }],
  updates: { available: true, reason: null, state: 'ready', version: '1.5.0', progress: 100, error: null },
  prefs: {
    // Every preference at its real default first, then the photograph's own
    // choices: a fixture listing only some of them showed empty dropdowns for
    // the rest, which would have hidden a real empty-dropdown bug among them.
    ...Object.fromEntries(Object.entries(require('../src/main/prefs').SCHEMA).map(([key, spec]) => [key, spec.def])),
    incognitoBridges: 'custom', incognitoJsLevel: 'balanced', incognitoKeepTorState: true,
    incognitoPreferOnion: false, incognitoCamouflage: false, incognitoIdleWipeMinutes: 0,
    incognitoBridgeLines: 'obfs4 203.0.113.5:443 9A1B2C3D4E5F60718293A4B5C6D7E8F901234567 cert=kR3x4mHq9Wn2bV7cZ8yT1uP0sL5fG6hJ iat-mode=1',
    // Ledger, the design a new install has; SHOOT_DESIGN photographs another.
    design: process.env.SHOOT_DESIGN || 'ledger',
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
  // The browser's own question box, as the close-window prompt asks it.
  'ask-spec': { title: 'Close window?', message: 'Close the window and its 14 tabs?',
    detail: 'Ctrl+Shift+T brings them back the next time you start the browser.',
    buttons: ['Close tabs', 'Cancel'], defaultId: 0, cancelId: 1, focusId: 0,
    checkboxLabel: 'Don\u2019t ask again', danger: false },
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
  'check-for-updates': STATE.updates,
  'reader-article': { title: 'Why your browser uses so much memory', byline: 'By Sam Rivera', siteName: 'The Long Read',
    url: 'https://example.com/story', length: 5200, lang: 'en',
    content: '<p>Open a dozen tabs and look at what your computer says the browser is using. The number is usually startling, and it is not a bug.</p><h2>Every tab is a program</h2><p>A modern page is an application: it runs scripts, holds images decoded in memory, and keeps a copy of everything it might need again. Multiply that by every tab you leave open.</p><blockquote>The tab you are not looking at is still running.</blockquote><p>The fix is not fewer tabs. It is a browser that puts the ones you are not using to sleep, and gives the memory back.</p>' },
  'whats-new-notes': { version: '2.0.0', sections: [
    { title: 'New', items: [
      { head: 'Spaces.', text: 'Keep sets of tabs apart - Work, Home, a trip - and switch between them from the tab strip or Ctrl+Alt+PageDown.' },
      { head: 'Split view.', text: 'Two tabs side by side: right-click a tab and choose `Show beside this tab`.' }] },
    { title: 'Security', items: [
      { head: 'Sites are tried over HTTPS first.', text: 'A plain-HTTP link loads the secure version where the site has one.' }] }] },
  'receipt-week': { week: [
    { date: '2026-09-23', freedMB: 1840, slept: 22, blocked: 610, cleaned: 12, stopped: 0 },
    { date: '2026-09-24', freedMB: 2410, slept: 31, blocked: 902, cleaned: 18, stopped: 1 },
    { date: '2026-09-25', freedMB: 960, slept: 9, blocked: 240, cleaned: 4, stopped: 0 },
    { date: '2026-09-26', freedMB: 0, slept: 0, blocked: 0, cleaned: 0, stopped: 0 },
    { date: '2026-09-27', freedMB: 3120, slept: 44, blocked: 1180, cleaned: 25, stopped: 0 },
    { date: '2026-09-28', freedMB: 2200, slept: 27, blocked: 780, cleaned: 9, stopped: 0 },
    { date: '2026-09-29', freedMB: 1290, slept: 14, blocked: 312, cleaned: 6, stopped: 0 }
  ] },
  'safety-status': { version: '2.0.0', chromium: '152.0.7977.65', autoUpdate: true,
    protections: [
      { key: 'httpsMode', label: 'Secure connections', on: true, detail: 'HTTPS where a site has it' },
      { key: 'secureDns', label: 'Secure DNS', on: true, detail: 'Automatic' },
      { key: 'warnDangerousSites', label: 'Dangerous-site warnings', on: true, detail: 'Lists updated 29/09/2026' },
      { key: 'blockAds', label: 'Ads and trackers blocked', on: true, detail: 'Lists updated 27/09/2026' },
      { key: 'blockThirdPartyCookies', label: 'Other sites’ cookies blocked', on: false },
      { key: 'cleanLinks', label: 'Tracking taken out of links', on: true }
    ],
    permissions: [{ origin: 'https://meet.google.com', camera: 'allow', microphone: 'allow', usedAt: Date.now() - 3 * 86400000 }],
    revoked: [{ origin: 'https://maps.example.com', kinds: ['location'] }],
    passwords: { configured: true } },
  'site-info': { host: 'www.theguardian.com', secure: true, website: true, incognito: false, ask: null,
    permissions: { notifications: 'block' }, blocking: { on: true, blocked: 23 }, sleep: 'never', thirdPartyCookies: { blocked: true }, forget: false, zoom: 100, zoomDefault: 100 }
};

const SHOTS = [
  { name: 'chrome',   file: 'chrome.html',   w: 1280, h: 118 },
  // The same chrome in a window too narrow for its bookmarks, which is the only
  // way to see the overflow chevron and what the bar does with what is left.
  { name: 'chrome-narrow', file: 'chrome.html', w: 620, h: 118 },
  { name: 'chrome-saver', file: 'chrome.html', w: 1280, h: 118, saver: true },
  { name: 'chrome-spaces', file: 'chrome.html', w: 1280, h: 118, spaces: true },
  { name: 'chrome-groups', file: 'chrome.html', w: 1280, h: 118, groups: true },
  { name: 'sidebar-groups', file: 'chrome.html', w: 240, h: 500, side: true, groups: true },
  { name: 'sidebar-spaces', file: 'chrome.html', w: 240, h: 500, side: true, spaces: true },
  { name: 'settings-spaces', file: 'settings.html', w: 1280, h: 860, hash: 'spaces', spaces: true },
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
  // Tucked away in a window: the band across the top, and with the tabs out,
  // the band still there and the panel under it over the page.
  { name: 'band', file: 'chrome.html', w: 1280, h: 40, side: true, band: true },
  { name: 'band-open', file: 'chrome.html', w: 1280, h: 720, side: true, band: true, open: true },
  // The tab list's own view, which is what is under the band while it is out.
  { name: 'band-strip', file: 'chrome.html', w: 252, h: 680, side: true, band: true, open: true, role: 'strip' },
  { name: 'settings', file: 'settings.html', w: 1280, h: 860 },
  // The welcome tour, a step at a time.
  ...['hello', 'import', 'look', 'browsing', 'default', 'tour', 'done'].map((step) =>
    ({ name: `welcome-${step}`, file: 'welcome.html', w: 1280, h: 800, hash: step })),
  // The same page, scrolled to a section that would otherwise be eight screens
  // down. Worth its own shot because the rows there are built by hand rather
  // than from the settings descriptors, so nothing else photographs them.
  { name: 'settings-bookmarks', file: 'settings.html', w: 1280, h: 860, hash: 'bookmarks' },
  { name: 'settings-private', file: 'settings.html', w: 1280, h: 860, hash: 'private' },
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
  { name: 'site',     file: 'site.html',     w: 420,  h: 340 },
  { name: 'safety', file: 'safety.html', w: 1100, h: 1000 },
  { name: 'peek', file: 'peek.html', w: 1100, h: 200,
    message: { kind: 'peek', url: 'https://www.bbc.co.uk/news/articles/x', title: 'The story behind the headline', loading: false } },
  { name: 'receipt', file: 'receipt.html', w: 1100, h: 720 },
  { name: 'whats-new', file: 'whats-new.html', w: 1100, h: 720 },
  { name: 'quick', file: 'quick.html', w: 900, h: 44,
    message: { kind: 'quick', url: 'https://www.bbc.co.uk/news/articles/x', title: 'The story behind the headline', loading: false } },
  { name: 'settings-labs', file: 'settings.html', w: 1280, h: 860, hash: 'labs' },
  { name: 'reader', file: 'reader.html', w: 1100, h: 760, query: { t: 'x' } },
  { name: 'danger', file: 'danger.html', w: 1100, h: 640, query: { url: 'https://paypa1.com/login', kind: 'lookalike', like: 'paypal.com' } },
  { name: 'danger-phish', file: 'danger.html', w: 1100, h: 640, query: { url: 'https://secure-login.bank-verify.example/', kind: 'phishing' } },
  { name: 'toast', file: 'toast.html', w: 460, h: 84,
    message: { kind: 'toast', id: 't', text: 'Closed 4 tabs', action: 'Undo', ms: 60000 } },
  { name: 'toast-restore', file: 'toast.html', w: 460, h: 84,
    message: { kind: 'toast', id: 't', text: 'Debrowser didn’t close properly', action: 'Restore 12 tabs', ms: 60000 } },
  // The same sheet holding the tab strip's menu, which is the other thing it
  // draws and has its own set of icons to get wrong.
  { name: 'tab-menu', file: 'context.html', w: 900, h: 560, answers: 'tab-menu-model' },
  { name: 'ask', file: 'ask.html', w: 900, h: 560 },
  // Incognito's first page, part-way through connecting - and after it has
  // given up, which is the state that has to explain itself.
  { name: 'tor', file: 'tor.html', w: 1280, h: 820,
    incognito: { tor: { state: 'bootstrapping', progress: 45, summary: 'Loading relay descriptors', transport: 'obfs4' },
                 killSwitch: { available: true, mechanism: 'Network namespace (loopback only)' },
                 tripwire: { available: true }, contentProtection: false,
                 fingerprint: { checked: 26, problems: [] } } },
  // A private window whose site refused every exit it was tried from, and
  // offers an onion address: the two things the toolbar says about a site.
  { name: 'chrome-private', file: 'chrome.html', w: 1280, h: 120,
    incognito: { tor: { state: 'ready', progress: 100, summary: 'Done', transport: 'webtunnel' },
                 killSwitch: { available: true }, tripwire: { available: true },
                 onion: 'http://abcdefghijklmnop.onion/', refused: true } },
  // The fingerprint self-check, run here without the overrides - so it shows
  // what it looks like when it finds something, which is the state that has
  // to be readable.
  { name: 'fingerprint', file: 'fingerprint.html', w: 1280, h: 900,
    hash: encodeURIComponent(JSON.stringify({"userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36", "major": "152", "timezone": "UTC", "locale": "en-US", "languages": "en-US,en", "sharedWorkerLanguages": "en-US", "cores": 4})) },
  { name: 'tor-failed', file: 'tor.html', w: 1280, h: 820,
    incognito: { tor: { state: 'failed', progress: 10, summary: 'Connected to a relay',
                        warning: 'No progress for 45 seconds at 10% - the network may be blocking Tor' },
                 killSwitch: { available: false, reason: 'macOS offers no per-app network control without root' },
                 tripwire: { available: true } } }
];


// `--theme=light` photographs the other palette, which nothing else checks.
const THEME = process.argv.find((a) => a.startsWith('--theme='));
// `--audit` measures each page against tools/audit-probe.js instead of only
// photographing it, and exits non-zero when anything fails.
const AUDIT = process.argv.includes('--audit');
const AXE_SOURCE = AUDIT ? fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8') : '';
// `--forced-colors` emulates a Windows High Contrast theme.
const FORCED = process.argv.includes('--forced-colors');
const auditFindings = [];
if (THEME) STATE.prefs.theme = THEME.slice(8);
// `--strip=#rrggbb` paints the tab strip, which is where a colour chosen for
// one palette meets the other.
const STRIP = process.argv.find((a) => a.startsWith('--strip='));
if (STRIP) STATE.prefs.tabBarColor = STRIP.slice(8);

const ONLY = process.argv.find((a) => a.startsWith('--only='));
const WANTED = ONLY ? SHOTS.filter((s) => s.name === ONLY.slice(7)) : SHOTS;

process.on('unhandledRejection', (e) => console.log('unhandled:', e && e.message));
process.on('uncaughtException', (e) => console.log('uncaught:', e && e.message));

// One window at a time: without this the first one closing ends the run.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  for (const shot of WANTED) {
    // A shot may serve a different model through the channel the page asks on.
    // Before the window, because the answers are serialised into its preload
    // arguments - set after it, and the page has already been given the old set.
    if (shot.answers) ANSWERS['context-model'] = ANSWERS[shot.answers];

    STATE.incognito = shot.incognito || null;
    STATE.saver = shot.saver === true;
    STATE.spaces = shot.spaces ? { activeId: 'home', list: [
      { id: 'home', name: 'Home', color: '#2f857b', container: false },
      { id: 'swork', name: 'Work', color: '#7b6a9c', container: true },
      { id: 'strip', name: 'Lisbon trip', color: '#a8694a', container: false }] } : undefined;

    // Two tab groups: one open (tabs 2 and 3), one folded (tabs 4 and 5).
    STATE.groups = shot.groups ? {
      gread: { id: 'gread', name: 'Reading', color: '#7b6a9c', collapsed: false },
      gwatch: { id: 'gwatch', name: 'Later', color: '#a8694a', collapsed: true }
    } : undefined;
    // SHOOT_ACTIVE=5 puts another tab in front - the new tab, for a picture
    // of the whole window where the address bar and the page agree.
    if (process.env.SHOOT_ACTIVE) {
      const front = Number(process.env.SHOOT_ACTIVE);
      STATE.activeId = front;
      for (const tab of STATE.tabs) {
        tab.visible = tab.id === front;
        if (tab.id === front) tab.tier = 'active';
        else if (tab.tier === 'active') tab.tier = 'warm';
      }
    }
    for (const tab of STATE.tabs) {
      tab.groupId = shot.groups ? ({ 2: 'gread', 3: 'gread', 4: 'gwatch', 5: 'gwatch' })[tab.id] || null : null;
    }

    if (shot.side) {
      STATE.prefs.tabBarPosition = 'left';
      STATE.sidebar = shot.band
        ? { pinned: false, open: shot.open === true, floating: false, detached: true, band: true }
        : shot.collapsed
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
      backgroundColor: STATE.prefs.theme === 'light' ? '#f3f1ec' : '#161614',
      webPreferences: {
        preload: path.join(__dirname, 'stub-preload.js'),
        contextIsolation: true, sandbox: false,
        additionalArguments: [`--state=${JSON.stringify(STATE)}`, `--answers=${JSON.stringify(ANSWERS)}`,
          ...(shot.message ? [`--message=${JSON.stringify(shot.message)}`] : [])]
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
      : shot.hash ? { hash: shot.hash } : shot.role ? { query: { role: shot.role } }
        : shot.query ? { query: shot.query } : {};
    // The promise rejects spuriously on some of these while the page loads
    // perfectly well, so the paint is what is waited on, not the promise.
    win.loadFile(path.join(R, shot.file), opts).catch(() => {});
    if (FORCED) {
      try {
        win.webContents.debugger.attach('1.3');
        await Promise.race([
          win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'forced-colors', value: 'active' }, { name: 'prefers-color-scheme', value: 'dark' }]
          }),
          new Promise((r) => setTimeout(r, 2000))
        ]);
      } catch (err) { console.log('forced colours not emulated:', err.message); }
    }
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
    if (AUDIT) {
      const found = await win.webContents.executeJavaScript(require('./audit-probe')).catch((e) => [{ kind: 'error', el: '', detail: e.message }]);
      for (const f of found) auditFindings.push({ shot: shot.name, ...f });
      // axe-core: names, roles, labels and structure, as a screen reader meets
      // them (WCAG 2.2 A and AA). Contrast is left to audit-probe.js, which
      // measures it with this design's own composited colours.
      const axe = await win.webContents.executeJavaScript(`${AXE_SOURCE};
        axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
          rules: { 'color-contrast': { enabled: false } }
        }).then((r) => r.violations.flatMap((v) => v.nodes.slice(0, 3).map((n) => ({
          kind: 'a11y', el: String(n.target[0]).slice(0, 60), detail: v.id + ': ' + v.help
        }))))`).catch((e) => [{ kind: 'error', el: 'axe', detail: e.message }]);
      for (const f of axe) auditFindings.push({ shot: shot.name, ...f });
    }
    try {
      const img = await Promise.race([
        win.webContents.capturePage(),
        new Promise((_r, reject) => setTimeout(() => reject(new Error('capture timed out')), 8000))
      ]);
      const suffix = (THEME ? `-${STATE.prefs.theme}` : '') + (FORCED ? '-hc' : '');
      fs.writeFileSync(path.join(OUT, `${shot.name}${suffix}.png`), img.toPNG());
      console.log('shot', shot.name, img.getSize().width + 'x' + img.getSize().height);
    } catch (err) {
      console.log('MISSED', shot.name, err.message);
    }
    win.destroy();
  }
  if (AUDIT) {
    const byKind = {};
    for (const f of auditFindings) (byKind[f.kind] ||= []).push(f);
    for (const [kind, list] of Object.entries(byKind)) {
      console.log(`\n${kind}: ${list.length}`);
      for (const f of list) console.log(`  ${f.shot.padEnd(18)} ${f.el.padEnd(60)} ${f.detail}`);
    }
    console.log(`\nAUDIT ${auditFindings.length} finding(s)${THEME ? ` (${STATE.prefs.theme})` : ''}`);
  }
  app.exit(AUDIT && auditFindings.length ? 1 : 0);
});
