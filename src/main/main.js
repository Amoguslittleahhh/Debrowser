'use strict';

/**
 * Debrowser entry point.
 *
 * Wires the four subsystems together and gets out of the way:
 *
 *   TabManager  owns tabs and the shared browsing session
 *   BrowserShell owns the window and view layout
 *   Governor     decides what every tab should be holding
 *   IpcHub       carries signals from pages and commands from the UI
 */

const { app, ipcMain, session, Menu, dialog, clipboard,
        shell: electronShell } = require('electron');
const { loadConfig } = require('./config');
const platform = require('./platform');
const { TabManager, BROWSING_PARTITION } = require('./tabs/tab-manager');
const { sweepThumbnails, sweepThumbnailsSync } = require('./tabs/tab');
const { BrowserShell } = require('./window');
const { Prefs, applyPrefs } = require('./prefs');
const { Updater } = require('./updater');
const { Credentials, originOf } = require('./credentials');
const { Bookmarks, findProfiles, readProfile, parseExport } = require('./bookmarks');
const { History } = require('./history');
const icons = require('./icons');
const presence = require('./presence');
const { DownloadManager } = require('./downloads');
const { Governor } = require('./governor');
const { Prewarm } = require('./prewarm');
const { IpcHub } = require('./ipc');
const { pageMergingStatus } = require('./memory');
const pages = require('./pages');
const shortcuts = require('./shortcuts');
const contextMenu = require('./context-menu');

const path = require('path');

const SMOKE_TEST = process.argv.includes('--smoke-test');
const OFFLINE_MODE = SMOKE_TEST || process.argv.includes('--bench-test');

// Tests and benchmarks must not depend on the network: they assert on memory
// behaviour, and a slow or blocked fetch would make them vary for reasons that
// have nothing to do with the governor.
const HOME_URL = OFFLINE_MODE
  ? `file://${path.join(__dirname, '..', '..', 'test', 'pages', 'idle.html')}`
  : pages.NEW_TAB_URL;

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(1);
const argValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const VERBOSE = argv.includes('--verbose') || SMOKE_TEST;

const overrides = {};
const budgetArg = Number(argValue('budget'));
if (Number.isFinite(budgetArg) && budgetArg > 0) overrides.memoryBudgetMB = budgetArg;

const cfg = loadConfig(argValue('profile') || 'balanced', overrides);

// What these two settings mean when nobody has chosen a value: sized to this
// machine rather than to a number chosen on someone else's hardware. Kept on
// cfg rather than applied and forgotten, because clearing the field in Settings
// has to come back here - see applyPrefs.
cfg.autoBudgetMB = cfg.profile === 'balanced' ? platform.recommendedBudgetMB() : cfg.memoryBudgetMB;
cfg.autoLiveTabs = cfg.profile === 'balanced' ? platform.recommendedLiveTabs() : cfg.maxLiveTabs;

// A value pinned on the command line is for this run and outranks anything
// saved. Recorded rather than just applied, so a later preference change cannot
// quietly overwrite it and make the flag look broken.
cfg.pinned = {
  memoryBudgetMB: overrides.memoryBudgetMB != null,
  maxLiveTabs: false
};

cfg.memoryBudgetMB = cfg.pinned.memoryBudgetMB ? cfg.memoryBudgetMB : cfg.autoBudgetMB;
cfg.maxLiveTabs = cfg.autoLiveTabs;

// Benchmark switch: lets the per-tab memory flag be measured rather than
// assumed. Not something a user needs to touch.
if (argv.includes('--no-optimize-for-size')) cfg.optimizeForSize = false;
if (argv.includes('--heap-limit')) cfg.heapLimit.enabled = true;

// Note the presence check. `Number(null)` is 0, and 0 is a *meaningful* value
// here (it disables the cap), so testing the parsed number alone would silently
// turn the cap off whenever the flag was absent - which is exactly what it did.
const liveTabsRaw = argValue('max-live-tabs');
if (liveTabsRaw !== null) {
  const parsed = Number(liveTabsRaw);
  if (Number.isFinite(parsed) && parsed >= 0) {
    cfg.maxLiveTabs = Math.round(parsed);
    cfg.pinned.maxLiveTabs = true;
  }
}

// Say it loudly and unconditionally, not behind the verbose flag: running
// without site isolation is a security posture the user should be reminded of
// every time, not a quiet configuration detail.
if (cfg.siteIsolation === false) {
  console.warn(
    '[debrowser] WARNING: site isolation is DISABLED (profile: %s).\n' +
    '           Different sites may share a renderer process, so the browser\n' +
    '           cannot prevent a malicious page or embedded third-party frame\n' +
    '           from reading another site\'s data. Use this only for browsing\n' +
    '           you trust. Run without --profile=minimal to restore isolation.',
    cfg.profile);
}

// Page merging is a security-relevant choice, so its state is reported at every
// launch rather than left to be discovered in a panel.
{
  const merging = pageMergingStatus();
  if (merging.active) {
    console.warn(
      '[debrowser] WARNING: kernel same-page merging is ACTIVE for this process tree.\n' +
      '           Identical memory pages are shared between renderers, and between\n' +
      '           this browser and other programs. That saves memory (~12% measured)\n' +
      '           but deduplication is a known timing side channel: a write to a\n' +
      '           merged page is measurably slower, which lets code running in one\n' +
      '           page test whether specific content exists elsewhere in memory.\n' +
      '           A browser runs untrusted code by design. Use this only on a\n' +
      '           machine and workload where you accept that.');
  } else if (merging.processMergeable && !merging.ksmRunning) {
    console.warn('[debrowser] page merging requested, but KSM is not running system-wide ' +
                 '(root: echo 1 > /sys/kernel/mm/ksm/run). Running unmerged.');
  }
}

function log(...args) {
  if (VERBOSE) console.log('[debrowser]', ...args);
}

/* ------------------------------------------------------------------ */
/* Chromium switches - must be applied before `app` is ready           */
/* ------------------------------------------------------------------ */

// Tests and benchmarks give each tab its own site so the process model behaves
// as it would for real browsing, rather than collapsing a pile of same-site
// file:// URLs into one renderer. That needs `*.test` to resolve locally.
if (SMOKE_TEST || (argv.includes('--bench-test') && argv.includes('--distinct-origins'))) {
  const { HOST_RESOLVER_RULES } = require('./fixture-server');
  app.commandLine.appendSwitch('host-resolver-rules', HOST_RESOLVER_RULES);
}

for (const [name, value] of platform.chromiumSwitches(cfg)) {
  if (value === undefined) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, value);
}

// Hardware acceleration has to be decided before the app starts - Chromium
// reads it once, at launch - so the preferences file is read here rather than
// in whenReady. `app.getPath('userData')` is available this early; nothing else
// about the app has to be.
const earlyPrefs = new Prefs(log);
if (earlyPrefs.get('hardwareAcceleration') === false) {
  app.disableHardwareAcceleration();
  log('config', 'hardware acceleration disabled by preference');
}

// The browser's own pages live behind a real scheme, so they have origins,
// URLs and history like any other page. Registration has to happen before the
// app is ready; the handler is installed after it.
pages.registerScheme();

// One instance owns the profile directory; a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

/* ------------------------------------------------------------------ */

function main() {
  /** @type {BrowserShell|null} */
  let shell = null;
  /** @type {Governor|null} */
  let governor = null;
  /** @type {TabManager|null} */
  let tabs = null;
  /** @type {Prefs|null} */
  let prefs = null;
  /** @type {Updater|null} */
  let updater = null;
  /** @type {Credentials|null} */
  let credentials = null;
  let bookmarks = null;
  /** @type {Prewarm|null} */
  let prewarm = null;
  let downloads = null;
  /** @type {History|null} */
  let history = null;

  /** The command dispatcher, once `wireCommands` has built it. */
  let runCommand = () => {};

  let publishQueued = false;
  const publish = () => {
    // Tab events can arrive in bursts (a load fires several in a row).
    // Coalesce them into one paint of the UI per frame.
    if (publishQueued || !shell || !governor) return;
    publishQueued = true;
    setImmediate(() => {
      publishQueued = false;
      if (shell && governor) shell.publish(governor.snapshot());
    });
  };

  /**
   * Give a view the browser's keyboard shortcuts.
   *
   * `before-input-event` is the only hook that sees a keystroke before the page
   * does, and it is per-webContents - so every view that can hold focus is
   * bound here, the chrome included. Only keys in `shortcuts.TABLE` are taken;
   * everything else, including every shortcut a web application defines for
   * itself, is left alone.
   *
   * The chrome used to be the exception, because it ran a second table in its
   * own DOM. That is what made which shortcuts existed depend on where focus
   * happened to be, so the DOM table is gone and this is the only one.
   */
  const bindShortcuts = (wc) => {
    if (!wc || wc.isDestroyed()) return;
    wc.on('before-input-event', (event, input) => {
      const hit = shortcuts.match(input);
      if (!hit) return;
      event.preventDefault();
      runCommand(hit.command, hit.payload);
    });
  };

  const bindPageShortcuts = (tab) => {
    if (tab.isLive) bindShortcuts(tab.wc);
  };

  /**
   * The model for the menu that is open, so the sheet can ask for it.
   *
   * Handed over on request rather than pushed into the view's URL: a menu
   * carries a link address and a slice of the selection, and a query string is
   * both length-limited and written into a renderer's own location.
   */
  const context = { model: null };

  /**
   * The last few tabs that were closed, newest last, for Ctrl+Shift+T.
   *
   * Addresses and titles only - a closed tab's renderer is gone and its session
   * state with it, so reopening one is a fresh load of the page it was on. That
   * is what the shortcut means in every browser; keeping more would mean
   * holding a discarded tab's suspended state alive indefinitely, which is the
   * one thing this browser is built not to do.
   */
  const closedTabs = [];
  const CLOSED_TABS_KEPT = 10;

  /**
   * What the find bar is looking for.
   *
   * Held here rather than in the chrome because F3 has to work while a page has
   * focus, and the page's renderer has no idea what was typed into a bar in
   * another process.
   */
  const find = { query: '' };

  const rememberClosed = (tab) => {
    // A new tab page that was never navigated is not worth reopening: it holds
    // nothing, and it would sit at the top of the stack in front of the page
    // the user actually wants back.
    if (!tab || !tab.url || tab.url === pages.NEW_TAB_URL || tab.url === 'about:blank') return;
    closedTabs.push({ url: tab.url, title: tab.title || '' });
    if (closedTabs.length > CLOSED_TABS_KEPT) closedTabs.shift();
  };

  /**
   * Draw our own menu when a page is right-clicked.
   *
   * Bound per realisation, like the shortcut table above and for the same
   * reason: a discarded tab comes back with a new renderer, and the listener
   * died with the old one.
   */
  const bindContextMenu = (tab) => {
    if (!tab.isLive) return;
    tab.wc.on('context-menu', (_event, params) => {
      if (!shell || shell.window.isDestroyed()) return;
      // Only for the tab in front. A background tab firing this - which a page
      // can cause by scripting a contextmenu event - must not put a menu over
      // the page the user is actually looking at.
      if (!tab.visible) return;

      context.model = {
        items: contextMenu.buildModel(params, {
          canGoBack: tab.wc.navigationHistory.canGoBack(),
          canGoForward: tab.wc.navigationHistory.canGoForward(),
          bookmarked: Boolean(bookmarks && tab.url && bookmarks.has(tab.url)),
          internal: tab.internal,
          engineName: prefs ? prefs.engineName() : null
        }),
        // Kept beside the model rather than in it: an item's payload is what
        // the renderer may send back, and the page's own coordinates are not
        // something it should be able to restate.
        params: { x: Math.round(params.x || 0), y: Math.round(params.y || 0) },
        tabId: tab.id
      };

      // The hit test is in page coordinates and the sheet is window-sized, so
      // the menu is placed where the content area starts. `right` is the same
      // point: a context menu hangs from the pointer rather than from a button,
      // so its two edges are one.
      const area = shell.contentBounds();
      const x = area.x + context.model.params.x;
      const y = area.y + context.model.params.y;
      shell.openSheet('context', { x, y, right: x });
    });
  };

  /**
   * Report match counts to the find bar.
   *
   * `found-in-page` fires once per search and again for each step through the
   * results, and it is the only source of the count - `findInPage` itself
   * returns a request id and nothing else.
   */
  const bindFind = (tab) => {
    if (!tab.isLive) return;
    tab.wc.on('found-in-page', (_event, result) => {
      if (!shell || shell.window.isDestroyed() || !tab.visible) return;
      shell.toChrome('find-result', {
        matches: result.matches || 0,
        active: result.activeMatchOrdinal || 0
      });
    });
  };

  const onTabEvent = (tab, event, payload) => {
    switch (event) {
      case 'realised':
        if (shell) shell.attachTab(tab);
        // Per realisation, not per tab: a discarded tab comes back with a new
        // renderer, and the listener died with the old one.
        bindPageShortcuts(tab);
        bindContextMenu(tab);
        bindFind(tab);
        break;
      case 'loaded':
        // Fill on load, for passwords only. Payment details are never filled
        // without a click; see the note on fillSavedLogin.
        fillSavedLogin(tab, credentials, prefs, log);
        break;
      case 'activated':
        if (shell) shell.attachTab(tab);
        // A search belongs to the page it was run on. Carrying the bar over to
        // another tab would show a match count for a page nobody is looking at.
        if (shell && shell.findOpen) { find.query = ''; shell.setFindOpen(false); }
        break;
      case 'open-tab':
        if (tabs && payload?.url) tabs.create({ url: payload.url, activate: false, realise: false });
        break;
      case 'visited':
        if (history && payload?.url) history.record({ url: payload.url, title: tab.title });
        break;
      case 'described':
        if (history && payload?.url) history.describe(payload.url, payload);
        // Remembered so the icon route will fetch it. An address Chromium
        // reported for a page the user loaded is the only kind that route will
        // touch beyond the well-known default path.
        if (payload?.favicon) icons.remember(payload.favicon);
        break;
      case 'closed':
        if (shell) shell.detachTab(tab);
        rememberClosed(tab);
        break;
      default:
        break;
    }
    publish();
  };

  app.whenReady().then(() => {
    // No application menu.
    //
    // Electron installs a default File/Edit/View/Window menu on every app that
    // does not say otherwise. None of its items do anything this browser
    // defines - there is no File to open, and Window manages windows we do not
    // have - so it was a row of screen spent on a menu that leads nowhere. Every
    // shortcut worth having is bound in the chrome renderer.
    Menu.setApplicationMenu(null);
    // Both the default session (chrome, panel) and the browsing partition that
    // tabs run in, which has a protocol registry of its own.
    pages.serve(log, [BROWSING_PARTITION]);

    prefs = earlyPrefs;
    applyPrefs(cfg, prefs, log);

    // Page images must never outlive the session that took them, and a crash
    // cannot be relied upon to have run the per-tab cleanup.
    sweepThumbnails();
    log('system', JSON.stringify(platform.systemInfo()));
    log('config', `profile=${cfg.profile} budget=${cfg.memoryBudgetMB}MB`);

    tabs = new TabManager({
      cfg,
      onEvent: onTabEvent,
      log,
      // Awaited before a tab is shown, so it is never presented while frozen.
      onPresent: async (tab) => {
        if (shell) shell.attachTab(tab);
        if (governor) await governor.onTabActivated(tab);
      },
      onCover: (tab) => (shell ? shell.showPlaceholder(tab) : false),
      onUncover: () => { if (shell) shell.hidePlaceholder(); },
      // A speculative page load must never be the reason a frame is dropped,
      // and must never add to memory the governor is already trying to reclaim.
      canSpeculate: () => Boolean(governor) && governor.allowsSpeculation()
    });
    const ipcHub = new IpcHub(() => tabs.all(), log);

    credentials = new Credentials(log);

    // A submitted sign-in becomes a question, never a save. The origin comes
    // from the tab, not from the page that sent the message.
    ipcHub.wireCredentialOffer((tab, offer) => {
      offerToSaveCredential({ tab, offer, credentials, shell, log }).catch(
        (err) => log(`credential offer failed: ${err.message}`));
    });

    shell = new BrowserShell({
      tabManager: tabs,
      prefs,
      log,
      onCommand: (name) => { if (name === 'chrome-ready' || name === 'view-ready') publish(); },
      // Every view the shell owns answers the same table the tabs do - the
      // chrome included, since its own DOM handler is gone.
      bindShortcuts
    });

    // `--no-governor` runs the browser with every tab left fully resident, as
    // a baseline to measure the governor against. It is a benchmarking switch,
    // not a supported way to use the browser.
    if (!argv.includes('--no-governor')) {
      governor = new Governor({
        app,
        cfg,
        tabManager: tabs,
        ipcHub,
        log,
        onUpdate: (state) => shell && shell.publish(state)
      });
      governor.start();
    }

    // Started while the pointer is still on its way to the + or the menu, so
    // the first new tab page of a session does not pay to start a renderer
    // after the click. Off under a test or a benchmark: both assert on measured
    // memory, and a spare renderer appearing on a timer would make the numbers
    // depend on where a pointer had been.
    prewarm = new Prewarm({
      partition: BROWSING_PARTITION,
      preload: path.join(__dirname, '..', 'preload', 'chrome-preload.js'),
      hasLiveInternal: () => tabs.all().some((t) => t.internal && t.isLive),
      busy: () => Boolean(governor && governor.boost.quiesceRequested),
      enabled: !OFFLINE_MODE,
      log
    });

    bookmarks = new Bookmarks(log);
    // So the state broadcast can carry the revision the bookmarks bar watches.
    shell.bookmarks = bookmarks;
    // Read live rather than captured, so switching recording off in the history
    // page stops the very next navigation from being written down.
    //
    // Never under a test or a benchmark. Those run against the real profile
    // directory and visit two dozen fixture pages per run, and writing them
    // into the user's own history would be this browser filling their records
    // with its own test suite.
    history = new History(log, { enabled: () => !OFFLINE_MODE && prefs.get('saveHistory') });
    // The stored icon addresses came from this same signal in earlier sessions,
    // so they are exactly as trusted as the ones this session will report - and
    // without seeding them, every row from before today would fall back to its
    // letter until the site was visited again.
    icons.rememberAll(history.all().map((entry) => entry.icon));

    runCommand = wireCommands({
      tabs, shell, governor, prefs, publish, log, prewarm,
      bookmarks, closedTabs, context, find
    });

    // Downloads are taken over from Chromium rather than added beside it.
    //
    // Electron's own download path is one connection, start to finish, and
    // there is no way to ask it for more - so `will-download` is cancelled and
    // the URL is handed to our manager. Cancelled rather than left running: two
    // downloads of the same file would race for the same name on disk.
    downloads = new DownloadManager({
      dir: app.getPath('downloads'),
      connections: () => prefs.get('downloadConnections'),
      // Same session the cancelled download came from, so a file behind a
      // sign-in still fetches as the signed-in user.
      session: session.fromPartition(BROWSING_PARTITION),
      log,
      onChange: () => publish()
    });
    // So the state broadcast can carry the count and progress the toolbar
    // button draws, without carrying the list itself.
    shell.downloads = downloads;
    session.fromPartition(BROWSING_PARTITION).on('will-download', (event, item) => {
      const url = item.getURL();
      // Only what a download can mean. A blob: or data: URL has no server to
      // ask for ranges and nothing for our manager to fetch, so Chromium keeps
      // those - taking them over would break them to no purpose.
      if (!/^https?:/i.test(url)) return;
      event.preventDefault();
      downloads.start(url);
    });
    wireRequests({ tabs, shell, credentials, bookmarks, history, downloads, prefs, log, context });

    tabs.create({ url: newTabUrl(prefs) });
    shell.layout();

    // Updates last, and never under a test or a benchmark: both assert on
    // measured memory and CPU, and a background download competing with them
    // would make the numbers depend on whether a release happened to be out.
    if (!OFFLINE_MODE) {
      updater = new Updater({
        // Read live rather than captured, so turning it off in Settings takes
        // effect at the next check instead of at the next launch.
        enabled: () => prefs.get('autoUpdate'),
        log,
        // The browser draws its own prompt rather than asking the system for
        // one: a Win32 message box in the middle of a window that draws
        // everything else itself is the thing this browser keeps replacing.
        onReady: () => { if (shell) shell.openSheet('update'); }
      });
      updater.start();
      shell.updater = updater;
    }

    if (SMOKE_TEST) {
      runSmokeTest({ tabs, governor, shell, prefs, bookmarks, runCommand, history, context });
    } else if (argv.includes('--bench-test')) {
      const { runBench } = require('./bench');
      const tabCount = Number(argValue('tabs')) || 8;
      const settleMs = Number(argValue('settle')) || 8000;
      const coldMs = Number(argValue('cold')) || undefined;
      const freezeMs = Number(argValue('freeze')) || undefined;
      const distinctOrigins = argv.includes('--distinct-origins');
      const mix = argValue('mix') || 'default';
      runBench({ tabs, governor, app, cfg, tabCount, settleMs, coldMs, freezeMs, distinctOrigins, mix })
        .then((result) => {
          // Single machine-readable line for bench/bench.js to parse.
          process.stdout.write(`\n__BENCH__${JSON.stringify(result)}\n`);
          app.exit(0);
        })
        .catch((err) => {
          console.error('[bench] failed:', err.stack || err.message);
          app.exit(1);
        });
    }
  });

  app.on('second-instance', () => {
    if (shell && !shell.window.isDestroyed()) {
      if (shell.window.isMinimized()) shell.window.restore();
      shell.window.focus();
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    if (updater) updater.stop();
    if (prewarm) prewarm.drop();
    if (governor) governor.stop();
    // Writes are debounced by a few seconds, and quit does not wait for a
    // timer, so the last few pages visited would be lost on every close.
    if (history) history.flush();
    if (tabs) tabs.closeAll();
    // The trim helper is a long-lived child process of ours. Nothing else ends
    // it, and it holds an open stdin on a pipe that outlives us.
    platform.stopTrimHelper();
    platform.stopMeasureHelper();
    // Synchronous on purpose: quit does not wait for promises, and leaving
    // page screenshots on disk is the one cleanup that must not be best effort.
    sweepThumbnailsSync();
  });

  // Pages must never be able to open a renderer with elevated privileges.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

/* ------------------------------------------------------------------ */
/* Commands from the browser chrome                                    */
/* ------------------------------------------------------------------ */

/**
 * Wire the command channel, and hand back the dispatcher behind it.
 *
 * Returned rather than kept private because two things issue commands now: the
 * browser's own renderers, over IPC, and the keyboard, which a *page* owns
 * while it has focus. Both must mean the same thing by 'new-tab', so there is
 * one switch and two ways in rather than a second copy for shortcuts.
 */
function wireCommands({ tabs, shell, governor, prefs, publish, log, prewarm = null,
                       bookmarks = null, closedTabs = [], context = { model: null },
                       find = null }) {
  /** Activate a tab, repaint, and say so if it failed. Used by four commands. */
  const goTo = (id) => tabs.activate(id)
    .then(publish)
    .catch((err) => log(`activate failed: ${err.message}`));

  const runCommand = (command, payload, sender = null) => {
    const active = tabs.activeTab();

    switch (command) {
      case 'new-tab':
        tabs.create({ url: payload?.url || newTabUrl(prefs) });
        break;

      case 'close-tab':
        tabs.close(payload?.id ?? tabs.activeId);
        // Closing the last tab closes the browser, the way every other browser
        // behaves. An empty window with a tab strip holding nothing is a state
        // with no way forward except opening a tab or closing the window, so
        // offering it is offering a dead end.
        //
        // The window is closed rather than the app quit directly: the
        // `window-all-closed` handler already owns quitting, and `before-quit`
        // does real work - session state is written there - which a quit from
        // here would be racing.
        if (tabs.all().length === 0) shell.close();
        break;

      case 'activate-tab':
        goTo(payload?.id);
        break;

      case 'prefetch-tab':
        // Pointer resting on a tab. Deliberately not followed by publish(): a
        // speculation is not a state change the user asked for, and repainting
        // the chrome for every tab the pointer pauses on would cost more than
        // the head start is worth.
        tabs.speculate(payload?.id);
        break;

      case 'navigate': {
        const target = normaliseUrl(payload?.url, prefs.searchTemplate());
        if (!target) break;

        // One of our own pages always goes through the page opener, never into
        // whatever tab happens to be in front.
        //
        // The preload is fixed when a renderer is built, so a tab realised on a
        // website has the page probe and not the command bridge. Loading
        // Settings into it produced a page with no `window.debrowser` at all:
        // settings.js throws on its first call and the page renders dead. The
        // opener focuses the existing Settings tab or makes a new one, which is
        // both correct and what the user meant.
        if (pages.isInternal(target)) {
          openInternalPage(tabs, target);
          break;
        }

        const tab = payload?.id ? tabs.byId(payload.id) : active;
        if (!tab) break;
        if (!tab.isLive) tab.realise();
        tab.url = target;
        tab.wc.loadURL(target).catch((err) => log(`navigate failed: ${err.message}`));
        break;
      }

      case 'back':
        if (active?.isLive && active.wc.navigationHistory.canGoBack()) active.wc.navigationHistory.goBack();
        break;

      case 'forward':
        if (active?.isLive && active.wc.navigationHistory.canGoForward()) active.wc.navigationHistory.goForward();
        break;

      case 'reload':
        if (active?.isLive) active.wc.reload();
        break;

      case 'stop':
        if (active?.isLive) active.wc.stop();
        break;

      // A reload that ignores the cache, which is the reason anyone presses
      // Ctrl+Shift+R rather than Ctrl+R.
      case 'reload-hard':
        if (active?.isLive) active.wc.reloadIgnoringCache();
        break;

      case 'focus-address':
        // Focus has to move to the *view* as well as to the field inside it:
        // the keystroke usually arrives while a page holds the keyboard, and
        // focusing an input in a renderer that does not have focus does
        // nothing visible at all.
        shell.focusChrome();
        shell.toChrome('focus-address');
        break;

      // Ctrl+Shift+T. Addresses only; see `rememberClosed`.
      case 'reopen-closed-tab': {
        const last = closedTabs.pop();
        if (last) tabs.create({ url: last.url });
        break;
      }

      // Ctrl+1 to Ctrl+8, and Ctrl+9 for the last one.
      case 'select-tab': {
        const list = tabs.all();
        const index = Number(payload?.index);
        const tab = index === -1 ? list[list.length - 1] : list[index];
        if (tab) goTo(tab.id);
        break;
      }

      // Ctrl+Tab and Ctrl+PageDown. Wraps, as it does everywhere else.
      case 'cycle-tab': {
        const list = tabs.all();
        if (list.length < 2) break;
        const at = list.findIndex((tab) => tab.id === tabs.activeId);
        const delta = Number(payload?.delta) || 1;
        const next = list[(((at === -1 ? 0 : at) + delta) % list.length + list.length) % list.length];
        if (next) goTo(next.id);
        break;
      }

      // Ctrl+D, and the context menu's own item. The star in the toolbar goes
      // through the request channel because it needs the answer back; this
      // needs the same answer sent to the chrome instead, or the star would go
      // on lying until the next navigation.
      case 'bookmark-page': {
        if (!bookmarks || !active || !active.url) break;
        const on = bookmarks.has(active.url)
          ? (bookmarks.remove(active.url), false)
          : Boolean(bookmarks.add({ url: active.url, title: active.title }));
        shell.toChrome('bookmarked', { url: active.url, bookmarked: on });
        break;
      }

      // Chromium's own view-source, in a tab of its own so the page being read
      // is still there when the reading is done.
      case 'view-source':
        if (active?.url && /^https?:/.test(active.url)) {
          tabs.create({ url: `view-source:${active.url}` });
        }
        break;

      /* -- Find in page ---------------------------------------------- */

      case 'find-open':
        // Focus has to move to the *view* as well, exactly as `focus-address`
        // does above. Ctrl+F is pressed while the page holds the keyboard, so
        // without this the bar appeared and every letter typed into it went to
        // the page instead - which on a page with its own `/` or `f` shortcut
        // is worse than the bar not opening at all.
        shell.setFindOpen(true);
        shell.focusChrome();
        break;

      case 'find-close':
        if (active?.isLive) active.wc.stopFindInPage('clearSelection');
        if (find) find.query = '';
        shell.setFindOpen(false);
        // Back to the page, so the next keystroke types into it rather than
        // into a bar that is no longer there.
        if (active?.isLive) active.wc.focus();
        break;

      // Every keystroke in the bar. `findNext: false` is what makes it search
      // as you type rather than stepping through matches on each letter.
      case 'find-query': {
        const query = String(payload?.query ?? '');
        if (find) find.query = query;
        if (!active?.isLive) break;
        if (!query) {
          active.wc.stopFindInPage('clearSelection');
          shell.toChrome('find-result', { matches: 0, active: 0 });
          break;
        }
        // No options at all, and this is not a style choice.
        //
        // Measured: `findInPage(text, { findNext: false })` - which is what the
        // documentation describes as "begin a new finding session", and what
        // this was written as - fires **no** `found-in-page` event whatsoever,
        // while the same call with the options omitted fires it normally. Since
        // that event is the only source of a match count, searching as you type
        // would have shown no count at all. Bisected against the real thing:
        // `{ forward: true }`, `{ findNext: true }` and `{ matchCase: false }`
        // all report; `{ findNext: false }` alone is silent.
        active.wc.findInPage(query);
        break;
      }

      case 'find-next':
      case 'find-prev': {
        const query = String(payload?.query ?? find?.query ?? '');
        // Either way the bar ends up open, so it is opened once rather than in
        // each branch. Pressing F3 with nothing to step through is what the key
        // is for before a search exists: it opens the bar and puts the keyboard
        // in it, exactly as Ctrl+F does.
        shell.setFindOpen(true);
        if (!query || !active?.isLive) { shell.focusChrome(); break; }
        active.wc.findInPage(query, { findNext: true, forward: command === 'find-next' });
        break;
      }

      /* -- From the page's own context menu --------------------------- */

      case 'open-link-tab': {
        const url = String(payload?.url || '');
        if (openableUrl(url)) tabs.create({ url, activate: false, realise: false });
        break;
      }

      case 'copy-link':
      case 'copy-text': {
        const text = String(payload?.text ?? '');
        if (text) clipboard.writeText(text);
        break;
      }

      // Straight to the download manager, which names the file and asks where
      // to put it - the same path a click on a download link takes.
      case 'save-link': {
        const url = String(payload?.url || '');
        if (active?.isLive && /^https?:/.test(url)) active.wc.downloadURL(url);
        break;
      }

      case 'search-selection': {
        const text = String(payload?.text ?? '').trim();
        if (!text) break;
        const target = normaliseUrl(text, prefs.searchTemplate(), { search: true });
        if (target) tabs.create({ url: target });
        break;
      }

      // The clipboard set, for an editable field. These go through the
      // webContents rather than through `clipboard` so that the page sees the
      // same events it would from Chromium's own menu.
      case 'edit-cut': if (active?.isLive) active.wc.cut(); break;
      case 'edit-copy': if (active?.isLive) active.wc.copy(); break;
      case 'edit-paste': if (active?.isLive) active.wc.paste(); break;
      case 'edit-select-all': if (active?.isLive) active.wc.selectAll(); break;

      // Opens the inspector on the element that was right-clicked. The dock is
      // ours, so the inspector has to exist before it can be pointed at a node.
      case 'inspect': {
        if (!active?.isLive) break;
        const { x, y } = context.model?.params || payload || {};
        if (!active.devToolsOpen) toggleDevTools(active, shell, log);
        active.wc.inspectElement(Math.round(Number(x) || 0), Math.round(Number(y) || 0));
        break;
      }

      case 'toggle-panel':
        shell.togglePanel();
        publish();
        break;

      // The menu and the downloads flyout are ours, drawn in a view of our
      // own. See BrowserShell#openSheet for why a panel is a separate view
      // rather than part of the chrome, and why neither is a system popup.
      case 'open-menu':
        shell.openSheet('menu', payload);
        break;

      // Edge's shape, and the one asked for: the button in the toolbar opens a
      // panel of recent files with live progress, and the full page is a click
      // away inside it. `Ctrl+J` and the menu item come here too, so there is
      // one downloads gesture rather than two that disagree.
      case 'open-downloads': {
        // The menu item and a page-level Ctrl+J arrive with no anchor, because
        // only the chrome knows where its button ended up after the toolbar
        // laid out. Falling back to the top right, under the toolbar, puts the
        // panel where that button is rather than in the corner of the window.
        const right = Number(payload?.right);
        const anchored = Number.isFinite(right) && right > 0
          ? payload
          : { x: 0, y: shell.toolbarAnchor() - 8,
              right: shell.window.getContentBounds().width - 12 };
        shell.openSheet('downloads', anchored);
        break;
      }

      // The page behind the flyout, for searching a long history of them.
      case 'open-downloads-page':
        shell.closeSheet();
        openInternalPage(tabs, pages.DOWNLOADS_URL);
        publish();
        break;

      case 'close-menu':
        shell.closeSheet();
        break;

      // From the browser's own update prompt. Restarting into the installer is
      // the updater's to do - this only carries the answer.
      case 'update-restart':
        shell.closeSheet();
        if (prewarm) prewarm.drop();
        if (shell.updater) shell.updater.install();
        break;

      case 'open-settings':
        openInternalPage(tabs, pages.SETTINGS_URL);
        publish();
        break;

      case 'open-history':
        openInternalPage(tabs, pages.HISTORY_URL);
        publish();
        break;

      // Bookmarks are still a section of Settings. Deep-linked rather than
      // merely opened: landing at the top of a settings page having asked for
      // bookmarks is the kind of near-miss that makes a menu item feel broken.
      case 'open-bookmarks':
        openInternalPage(tabs, `${pages.SETTINGS_URL}#bookmarks`);
        publish();
        break;

      case 'toggle-fullscreen':
        if (!shell.window.isDestroyed()) shell.window.setFullScreen(!shell.window.isFullScreen());
        break;

      case 'zoom':
        if (payload?.direction === 'reset') {
          if (active?.isLive) active.wc.setZoomFactor(1);
        } else {
          stepZoom(active, payload?.direction === 'out' ? -1 : +1);
        }
        break;

      case 'print':
        // Chromium's own print dialog. It fails on a page that cannot be
        // printed rather than throwing into this handler, which would take the
        // rest of the command switch with it.
        if (active?.isLive) active.wc.print({}, () => {});
        break;

      case 'toggle-devtools':
        toggleDevTools(active, shell, log);
        break;

      case 'set-pref': {
        if (!prefs.set(payload?.key, payload?.value)) break;
        applyPrefs(cfg, prefs, log);
        shell.applyWindowPrefs();
        // The governor reads cfg on its next tick, so a budget or cap change
        // takes effect there. Everything else is the UI's to apply, and it gets
        // it from the state snapshot publish() is about to send.
        break;
      }

      case 'discard-tab': {
        // Manual discard from the task manager. Goes through the same tier
        // machinery as an automatic one, protections included.
        const tab = tabs.byId(payload?.id);
        if (governor && tab && !tab.visible) {
          governor.enforceManualDiscard(tab).catch((e) => log(`manual discard failed: ${e.message}`));
        }
        break;
      }

      // Ctrl+Shift+B. Through the preference rather than a flag in the chrome,
      // because showing the bar takes 34px from the page - the window has to
      // lay out again, and the choice has to survive a restart.
      // A dwell on the + or the menu. Both open one of the browser's own pages,
      // and all of them share a renderer - so one warm process serves the new
      // tab page, Settings and History alike.
      case 'prefetch-new-tab':
        if (prewarm) prewarm.warm();
        break;

      // How tall the chrome's own contents come to. Only it can measure that,
      // and full screen down the side is where the answer matters: the strip is
      // a floating panel there, and a panel is as tall as what is in it.
      case 'chrome-size':
        shell.setChromeHeight(payload?.height);
        break;

      // The pointer reached the window's left edge, or left the strip. Only
      // the chrome can tell us: it is the view the pointer enters and leaves.
      case 'sidebar-hover':
        shell.setSidebarOpen(Boolean(payload?.over));
        break;

      // The pin at the bottom of the strip.
      case 'toggle-sidebar-pin':
        prefs.set('sidebarPinned', !shell.sidebarPinned());
        shell.applyWindowPrefs();
        break;

      case 'toggle-bookmarks-bar': {
        // The preference, not `bookmarksBarVisible()` - that is hard-false
        // with the strip down the side, so inverting it there could only ever
        // write `true` and the shortcut stopped toggling.
        prefs.set('showBookmarksBar', prefs.get('showBookmarksBar') === false);
        shell.layout();
        break;
      }

      // One of our own pages reporting that it is holding something. See
      // newtab.js: the browser's pages carry the command bridge rather than the
      // probe preload, so the governor has no other way to learn this.
      case 'page-dirty': {
        if (!sender) break;
        const tab = tabs.all().find((t) => t.isLive && t.wc.id === sender.id);
        if (tab && tab.internal) tab.hasDirtyInput = Boolean(payload?.dirty);
        break;
      }

      case 'pin-tab': {
        const tab = tabs.byId(payload?.id);
        if (tab) tab.pinned = !tab.pinned;
        break;
      }

      case 'set-budget': {
        const mb = Number(payload?.mb);
        if (governor && Number.isFinite(mb) && mb >= 256) {
          governor.cfg.memoryBudgetMB = Math.round(mb);
          log(`budget set to ${governor.cfg.memoryBudgetMB}MB`);
        }
        break;
      }

      default:
        break;
    }

    publish();
  };

  ipcMain.on('debrowser:command', (event, command, payload) => {
    if (!senderMayCommand(tabs, shell, event.sender)) return;
    runCommand(command, payload ?? null, event.sender);
  });

  return runCommand;
}

/**
 * Which of the browser's own surfaces a message came from, by its *live* URL.
 *
 * This is the security boundary, and it is deliberately not a flag on the tab
 * or the preload the renderer happens to carry. Both of those are decided when
 * a renderer is built and cannot be revoked afterwards: the new tab page is
 * realised with a privileged preload and then navigates itself to whatever the
 * user typed, so the site that loads inherits the bridge. Asking what the
 * sender *is right now* is the only check that survives that.
 *
 * Returns 'chrome' for the browser UI views, the page name for one of our own
 * pages, or null for anything else - which includes a website sitting in a
 * renderer that used to be one of our pages.
 */
function senderPage(tabs, shell, sender) {
  // The chrome views are named, never inferred.
  //
  // "No tab matches, so it must be the chrome" is not safe: TabManager.close()
  // splices the tab out of the list *before* the renderer is torn down, and in
  // that window a website - which carries the command bridge, since every tab
  // is realised on the new tab page - resolves to 'chrome' and can issue
  // commands. `set-pref` on the homepage persists, which is a durable hijack of
  // the browser by a page that was being closed.
  if (shell && shell.isChromeSender(sender)) return 'chrome';

  // Anything else is only trusted while it is actually showing one of our
  // pages. `sender.getURL()` rather than `tab.url`, because the tab's copy is
  // updated from events and this must not wait on one arriving.
  const live = sender.getURL();
  return pages.isInternal(live) ? pages.pageName(live) : null;
}

/** Commands are open to the chrome and to our own pages; nothing else. */
function senderMayCommand(tabs, shell, sender) {
  return senderPage(tabs, shell, sender) !== null;
}

/**
 * Questions the chrome asks and gets one answer to.
 *
 * Separate from the command channel because these return something. The
 * credential list in particular must not ride the state broadcast, which goes
 * to three views on every governor tick.
 *
 * Secrets never cross this boundary except on an explicit reveal or fill. A
 * settings page needs a site and a username to draw a row; handing it a
 * password as well would leave one in a renderer's heap for as long as the page
 * is open, for nothing.
 */
/**
 * Requests the chrome may make as well as Settings.
 *
 * Everything else on this channel is credentials, which stay Settings-only:
 * the new tab page has no business reading a password list and neither has the
 * tab strip. Bookmarks are not secrets - they are a list the user curates and
 * can read on disk - and the star in the toolbar has to be able to ask whether
 * the page in front of it is already saved.
 */
const CHROME_REQUESTS = new Set([
  'list-bookmarks', 'toggle-bookmark', 'remove-bookmark',
  // The downloads flyout is drawn in the sheet, which is one of the chrome's
  // own views. Downloads are not secrets - they are files the user asked for,
  // sitting in their own downloads directory - so this is a list the chrome may
  // read, unlike the credential store next door. No path crosses the boundary:
  // `reveal-download` and `open-download` take an id and resolve it here.
  'list-downloads', 'cancel-download', 'clear-download',
  'reveal-download', 'open-download',
  // The menu draws itself from this. It is a request rather than part of the
  // state broadcast because the menu is open for a second or two and the
  // broadcast reaches three views twice a second - sending a menu's worth of
  // labels to the tab strip forever, so that a dropdown can be current for the
  // moment it exists, is the wrong way round.
  'menu-model',
  // And the context menu from this, for the same reason - it exists for even
  // less time, and what is in it depends on what was under the pointer.
  'context-model'
]);

/**
 * What the new tab page may ask for.
 *
 * It shows the sites you go to most, so it needs to read the history list -
 * and that is the whole of its business. It is the one internal page a user can
 * have fifteen of, and it is one navigation away from being a website, so its
 * surface is the smallest of any page here.
 */
const NEWTAB_REQUESTS = new Set(['top-sites', 'forget-site']);

/**
 * What the history page may ask for - its own list, and nothing else.
 *
 * It is one of our own pages, so without this it would inherit the Settings
 * surface, credentials included. A page that lists URLs has no business being
 * able to read a password store, and the list is short enough to enumerate.
 */
const HISTORY_REQUESTS = new Set(['list-history', 'delete-history', 'clear-history', 'set-pref']);

/**
 * What the downloads page may ask for - its own list, and nothing else.
 *
 * Same reasoning as the history gate above: it is one of the browser's own
 * pages, so without this it would inherit Settings' surface, credentials
 * included. A page that lists files has no business reading a password store.
 */
const DOWNLOAD_REQUESTS = new Set([
  'list-downloads', 'cancel-download', 'clear-download', 'reveal-download', 'open-download']);

function wireRequests({ tabs, shell, credentials, bookmarks, history, downloads, prefs, log,
                       context = { model: null } }) {
  ipcMain.handle('debrowser:request', async (event, command, payload) => {
    // Stricter than the command channel: only Settings may touch credentials.
    const sender = senderPage(tabs, shell, event.sender);
    const allowed =
      sender === 'settings' ||
      (sender === 'chrome' && CHROME_REQUESTS.has(command)) ||
      (sender === 'history' && HISTORY_REQUESTS.has(command)) ||
      (sender === 'downloads' && DOWNLOAD_REQUESTS.has(command)) ||
      (sender === 'newtab' && NEWTAB_REQUESTS.has(command));
    if (!allowed) return null;

    switch (command) {
      // Preferences ride along because the menu view is created on open and
      // destroyed on close: it never receives the state broadcast that carries
      // them to the other views, and a menu that ignored the chosen theme for
      // the life of its two seconds would be the most visible thing in the
      // browser that did.
      case 'menu-model':
        return { items: menuModel({ tabs, shell }), prefs: prefs.all() };

      // Built when the page was right-clicked, not when this is asked - what
      // was under the pointer is gone by now.
      case 'context-model':
        return context.model
          ? { items: context.model.items, prefs: prefs.all() }
          : { items: [], prefs: prefs.all() };

      // The sites the new tab page offers. Derived from history rather than
      // stored separately: a second list of "places you go" would be a second
      // thing to forget when the user clears their history.
      case 'top-sites':
        return { items: topSites(history, bookmarks, Number(payload?.limit) || 8) };

      // Removing a tile removes the site from history, which is the only
      // honest thing it can mean - a tile that came back tomorrow because the
      // visit was still recorded would be a button that does nothing.
      case 'forget-site':
        return { removed: history ? history.forgetSite(String(payload?.url || '')) : 0 };

      // Newest first, filtered by the page's search box. Filtered here rather
      // than in the renderer: ten thousand entries is a list worth not copying
      // into another process on every keystroke.
      case 'list-history':
        return {
          items: history ? history.search(payload?.query, payload?.limit) : [],
          total: history ? history.count() : 0,
          recording: prefs.get('saveHistory')
        };

      case 'delete-history':
        return { removed: Boolean(history && history.remove(String(payload?.id ?? ''))) };

      case 'clear-history':
        return { removed: history ? history.clear() : 0 };

      // The history page's own recording switch, and only that one. Every other
      // preference goes through the command channel in `wireCommands`, which
      // re-applies the ones that change the window or the governor; this one
      // changes neither, and it belongs beside the list it governs, which is
      // where someone turning it off is looking.
      case 'set-pref': {
        if (sender !== 'history' || payload?.key !== 'saveHistory') return null;
        return { ok: prefs.set('saveHistory', payload?.value) };
      }

      case 'list-downloads':
        return { items: downloads ? downloads.list() : [] };

      case 'cancel-download':
        return { cancelled: Boolean(downloads && downloads.cancel(String(payload?.id ?? ''))) };

      case 'clear-download':
        return { removed: Boolean(downloads && downloads.remove(String(payload?.id ?? ''))) };

      // Show the file where it landed. The renderer sends an id and never sees
      // a path, so the worst a compromised chrome can do here is reveal a file
      // the user downloaded themselves.
      case 'reveal-download': {
        const file = downloads && downloads.pathOf(String(payload?.id ?? ''));
        if (!file) return { ok: false };
        electronShell.showItemInFolder(file);
        return { ok: true };
      }

      // And open it with whatever the system uses for that type.
      //
      // The same gesture every browser offers on a finished download, and the
      // same risk: the file is whatever the user chose to fetch, and opening it
      // is their decision exactly as it would be from their file manager. What
      // this must not become is a way to open an *arbitrary* path, which is why
      // the id is resolved against the download store and why `pathOf` answers
      // only for a download that actually completed.
      case 'open-download': {
        const file = downloads && downloads.pathOf(String(payload?.id ?? ''));
        if (!file) return { ok: false };
        const problem = await electronShell.openPath(file);
        return { ok: problem === '', reason: problem || null };
      }

      // Settings' "Check now".
      //
      // A request rather than a command because the page needs the answer: the
      // state broadcast will carry the eventual result, but the button has to
      // change the moment it is pressed. Inert under a test or a benchmark,
      // where no updater is constructed at all.
      case 'check-for-updates':
        return shell.updater ? shell.updater.checkNow()
          : { available: false, reason: 'updates are off in this build' };

      case 'list-bookmarks':
        return { items: bookmarks.all() };

      // Star in the toolbar: saves the page in front of the user, or takes it
      // back off if it is already saved. The URL comes from the tab, never from
      // the payload - a renderer asking to bookmark an arbitrary address would
      // be letting a page write to a list the user believes they curate.
      case 'toggle-bookmark': {
        const tab = tabs.activeTab();
        if (!tab || !tab.url) return null;
        if (bookmarks.has(tab.url)) {
          bookmarks.remove(tab.url);
          return { bookmarked: false };
        }
        const added = bookmarks.add({ url: tab.url, title: tab.title });
        return { bookmarked: Boolean(added), unsupported: !added };
      }

      // Adding and editing by hand, from the manager in Settings.
      //
      // These *do* take a URL from the payload, unlike the star above, and the
      // difference is the sender: only Settings reaches this channel, and
      // Settings is one of our own pages driven by a person typing into it. A
      // website has no route here at all - `CHROME_REQUESTS` does not list
      // these, so the chrome cannot reach them either. What a bookmark may
      // point at is still `bookmarks.js`'s decision, which is where
      // `javascript:` is refused.
      case 'save-bookmark': {
        const id = String(payload?.id ?? '');
        const fields = {
          url: payload?.url,
          title: payload?.title,
          folder: payload?.folder
        };
        const saved = id ? bookmarks.update(id, fields) : bookmarks.add(fields);
        return {
          ok: Boolean(saved),
          item: saved,
          // Said plainly, because the two ways this fails look identical from
          // the page: an address we will not store, and an address already on
          // the list.
          reason: saved ? null
            : id && !bookmarks.all().some((b) => b.id === id)
              ? 'that bookmark is no longer there'
              : 'that address cannot be bookmarked, or is already saved'
        };
      }

      case 'remove-bookmark':
        return { removed: bookmarks.remove(String(payload?.id ?? '')) };

      case 'bookmark-profiles':
        return { profiles: findProfiles() };

      // Reads a profile this machine already has. Chromium-family files are
      // JSON and are read directly; Firefox-family ones are named and refused
      // with the reason, because places.sqlite is a live database.
      case 'import-from-profile': {
        const list = findProfiles();
        const profile = list.find((p) => p.path === payload?.path);
        if (!profile) return { ok: false, reason: 'that profile is no longer there' };
        const read = readProfile(profile);
        if (!read.ok) return { ok: false, reason: read.reason };
        const result = bookmarks.merge(read.entries);
        log('bookmarks', `imported ${result.added} from ${profile.browser}`);
        return { ok: true, ...result, browser: profile.browser };
      }

      // An exported file the user picks. Read in main rather than in the
      // renderer: the page never gets a file path, and the dialog is the only
      // thing that decides which file is opened.
      case 'import-bookmark-file': {
        const picked = dialog.showOpenDialogSync({
          title: 'Import bookmarks',
          properties: ['openFile'],
          filters: [
            { name: 'Bookmarks', extensions: ['html', 'htm', 'json'] },
            { name: 'All files', extensions: ['*'] }
          ]
        });
        if (!picked || !picked.length) return { ok: false, cancelled: true };
        let text;
        try {
          text = require('fs').readFileSync(picked[0], 'utf8');
        } catch (err) {
          return { ok: false, reason: `could not read that file: ${err.message}` };
        }
        const result = bookmarks.merge(parseExport(text));
        log('bookmarks', `imported ${result.added} from ${picked[0]}`);
        return { ok: true, ...result, browser: require('path').basename(picked[0]) };
      }

      default:
        break;
    }

    switch (command) {
      case 'list-credentials': {
        const cap = credentials.capability();
        return { ...credentials.list(), available: cap.available, reason: cap.reason };
      }

      case 'delete-credential':
        return credentials.remove(payload?.kind, payload?.id);

      case 'presence-capability':
        return presence.capability();

      case 'reveal-credential': {
        // Deliberate, one at a time, and never logged.
        //
        // Gated on a presence check where the machine can make one and the user
        // has asked for it. `verify` returns true only on an observed success -
        // a helper that will not start, a throw, a timeout and an unrecognised
        // answer are all refusals - so an error here denies the reveal rather
        // than waving it through. A check that fails open is not a check.
        if (prefs.get('requirePresence')) {
          const allowed = await presence.verify(
            'Show a saved password',
            shell && !shell.window.isDestroyed() ? shell.window : null);
          if (!allowed) {
            log('credentials', 'reveal refused: presence check not satisfied');
            return { denied: true };
          }
        }
        const record = credentials.reveal(payload?.kind, payload?.id);
        if (!record) return null;
        return payload?.kind === 'login'
          ? { password: record.password }
          : { number: record.number, holder: record.holder };
      }

      case 'save-payment':
        return credentials.put('payment', {
          label: String(payload?.label ?? ''),
          number: String(payload?.number ?? '').replace(/\s+/g, ''),
          expiry: String(payload?.expiry ?? ''),
          holder: String(payload?.holder ?? '')
        });

      case 'fill-payment': {
        if (prefs.get('requirePresence')) {
          const allowed = await presence.verify(
            'Fill saved payment details',
            shell && !shell.window.isDestroyed() ? shell.window : null);
          if (!allowed) {
            log('credentials', 'payment fill refused: presence check not satisfied');
            return false;
          }
        }
        // Into the page behind Settings, not into Settings.
        //
        // `activeTab()` is the Settings tab - it is the one the user just
        // clicked in - so filling "the active tab" always refused. The target
        // is the most recently used tab that is actually a web page.
        const record = credentials.reveal('payment', payload?.id);
        const tab = tabs.all()
          .filter((t) => !t.internal && t.isLive)
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
        if (!record || !tab) return false;
        tab.sendToPage('debrowser:payment-fill', record);
        log('credentials', 'filled payment details on request');
        return true;
      }

      default:
        return null;
    }
  });
}

/**
 * Ask whether to remember a sign-in that was just submitted.
 *
 * A dialog rather than anything in the page. A prompt drawn by the site's own
 * renderer would be a prompt the site can see, style, cover, or imitate - and
 * the one question that must never be imitable is "shall I keep your password".
 *
 * Nothing is saved on the way in: the offer is held only long enough to ask.
 */
let credentialPromptOpen = false;

async function offerToSaveCredential({ tab, offer, credentials, shell, log }) {
  const origin = originOf(tab.url);
  if (!origin) return;                       // not a web page we can key on

  // One at a time. The prompt is window-modal, and a page that submits a form
  // in a loop would otherwise stack dialogs the user cannot get out from under
  // - a page-triggered lockout of the whole browser.
  if (credentialPromptOpen) return;
  credentialPromptOpen = true;
  try {
    await askAndSave({ origin, offer, credentials, shell, log });
  } finally {
    credentialPromptOpen = false;
  }
}

async function askAndSave({ origin, offer, credentials, shell, log }) {

  const cap = credentials.capability();
  if (!cap.available) {
    // Said once, in the log, rather than as a dialog on every sign-in. The
    // settings page reports it permanently, which is where someone would look.
    log('credentials', `not offering to save: ${cap.reason}`);
    return;
  }

  // Already known, with the same password? Then there is nothing to ask.
  const existing = credentials.forOrigin(origin)
    .find((r) => r.username === offer.username);
  if (existing && existing.password === offer.password) return;

  const { response } = await dialog.showMessageBox(shell.window, {
    type: 'question',
    buttons: [existing ? 'Update' : 'Save', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: existing ? 'Update saved password?' : 'Save password?',
    message: existing
      ? `Update the saved password for ${offer.username || 'this account'} on ${origin}?`
      : `Save the password for ${offer.username || 'this account'} on ${origin}?`,
    detail: 'It is encrypted with a key held by your operating system, and never leaves this machine.'
  });

  if (response !== 0) return;
  const stored = credentials.put('login', { origin, username: offer.username, password: offer.password });
  log('credentials', stored ? `saved a sign-in for ${origin}` : `could not save a sign-in for ${origin}`);
}

/**
 * Fill a saved sign-in once a page has loaded.
 *
 * Passwords only. Card numbers and addresses are never filled without a click,
 * because a page can place a hidden or off-screen payment field and harvest
 * whatever arrives in it - the attack that makes silent payment autofill a bad
 * trade. A password is bound to an origin the user can see in the address bar;
 * a card number is bound to nothing.
 *
 * Exactly one match fills. With several accounts on a site, picking one would
 * be guessing, and guessing wrong signs the user into the wrong account.
 */
function fillSavedLogin(tab, credentials, prefs, log) {
  if (!credentials || !tab || tab.internal) return;
  if (!prefs || prefs.get('fillPasswords') === false) return;
  if (!credentials.capability().available) return;

  const matches = credentials.forOrigin(tab.url);
  if (matches.length !== 1) return;

  // Through sendToPage, which refuses a stopped renderer. Reaching past it to
  // `wc.send` on a frozen tab segfaults the browser.
  tab.sendToPage('debrowser:credential-fill', matches[0]);
  log('credentials', `filled a saved sign-in on ${matches[0].origin}`);
}

/**
 * Open one of the browser's own pages, or focus it if it is already open.
 *
 * Focus rather than open again, because these are singletons in the way a
 * settings window is: a second Settings tab is never what the user meant, and
 * two of them can disagree about what the current preferences are.
 */
function openInternalPage(tabs, url) {
  // Matched by page name, not by URL string. Once the page has loaded, the tab
  // reports the URL Chromium normalised it to - `debrowser://settings/`, with a
  // trailing slash - so string equality against the URL we opened stops
  // matching the moment the page finishes loading, and every subsequent open
  // makes another tab.
  const wanted = pages.pageName(url);
  const existing = tabs.all().find((t) => t.internal && pages.pageName(t.url) === wanted);
  if (existing) {
    // Already open, and asked for a particular section of it: reload at that
    // address. A page reached by focusing the tab it is already in would
    // otherwise ignore the fragment and leave the user at the top, which is
    // indistinguishable from the menu item doing nothing. Settings and history
    // are both cheap to rebuild and hold no unsaved state, which is what makes
    // this affordable.
    const section = hashOf(url);
    if (section && existing.isLive && hashOf(existing.url) !== section) {
      existing.wc.loadURL(url).catch(() => {});
    }
    tabs.activate(existing.id).catch(() => {});
    return existing;
  }
  return tabs.create({ url });
}

/** The `#section` of one of our own URLs, or '' - never throws on a bad one. */
function hashOf(url) {
  try {
    return new URL(url).hash;
  } catch {
    return '';
  }
}

/**
 * Where a new tab goes.
 *
 * The saved homepage, if there is one, otherwise the default - and never the
 * homepage under `--smoke-test` or `--bench-test`, which must not depend on
 * whatever the machine they run on has saved.
 */
function newTabUrl(prefs) {
  if (OFFLINE_MODE) return HOME_URL;
  const home = prefs?.get('homepage');
  return (home && normaliseUrl(home)) || HOME_URL;
}

/* ------------------------------------------------------------------ */
/* The three-dot menu                                                  */
/* ------------------------------------------------------------------ */

/** Zoom steps, matching the ones Chrome offers. */
const ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function stepZoom(tab, direction) {
  if (!tab?.isLive) return;
  const current = tab.wc.getZoomFactor();
  // Nearest step to where we are, then move one along. Reading the factor back
  // rather than tracking an index keeps this correct after a ctrl+scroll, which
  // sets a factor this list does not contain.
  const nearest = ZOOM_FACTORS.reduce(
    (best, f) => (Math.abs(f - current) < Math.abs(best - current) ? f : best), 1);
  const index = ZOOM_FACTORS.indexOf(nearest) + direction;
  if (index < 0 || index >= ZOOM_FACTORS.length) return;
  tab.wc.setZoomFactor(ZOOM_FACTORS[index]);
}

/**
 * What the menu contains, as data.
 *
 * Built fresh on every open, because half of it depends on the state at the
 * moment the user clicked - what the zoom is, whether the task manager is
 * already showing, whether this page has developer tools open.
 *
 * Data rather than an Electron menu template, because the menu is drawn by a
 * renderer of ours now and this has to cross IPC. Each item's `id` is the
 * command the renderer sends back, which is what keeps the two halves from
 * drifting: there is no second list saying what a label means.
 */
function menuModel({ tabs, shell }) {
  const active = tabs.activeTab();
  const zoom = active?.isLive ? Math.round(active.wc.getZoomFactor() * 100) : 100;
  const live = Boolean(active?.isLive);
  const full = !shell.window.isDestroyed() && shell.window.isFullScreen();

  // Accelerators come from the shortcut table rather than being written here.
  // They were written here, and `Ctrl+Shift+B` was advertised in Settings for a
  // binding that only worked while the toolbar had focus - a label and the key
  // it names cannot be two separate pieces of knowledge.
  const accel = shortcuts.accelFor;

  // Grouped the way Chrome groups it - what you opened, where you have been,
  // what this page can do, what the browser can do - because that ordering is
  // twenty years of muscle memory and there is nothing to gain by being
  // different. What is in each group is ours.
  return [
    { id: 'new-tab', label: 'New tab', accel: accel('new-tab'), icon: 'plus' },
    { kind: 'separator' },
    { id: 'open-history', label: 'History', accel: accel('open-history'), icon: 'clock' },
    { id: 'open-downloads', label: 'Downloads', accel: accel('open-downloads'), icon: 'download' },
    { kind: 'separator' },
    { kind: 'zoom', label: 'Zoom', value: zoom, enabled: live },
    {
      id: 'toggle-fullscreen',
      label: 'Full screen',
      accel: accel('toggle-fullscreen'),
      icon: 'expand',
      kind: 'checkbox',
      checked: full
    },
    { id: 'print', label: 'Print\u2026', accel: accel('print'), icon: 'print', enabled: live },
    { kind: 'separator' },
    {
      id: 'toggle-panel',
      label: 'Task manager',
      accel: accel('toggle-panel'),
      icon: 'gauge',
      kind: 'checkbox',
      checked: shell.panelOpen
    },
    {
      id: 'toggle-devtools',
      label: 'Developer tools',
      accel: accel('toggle-devtools'),
      icon: 'code',
      kind: 'checkbox',
      checked: Boolean(live && active.devToolsOpen),
      enabled: live
    },
    { id: 'open-settings', label: 'Settings', accel: accel('open-settings'), icon: 'gear' },
    { kind: 'separator' },
    { kind: 'note', label: `Debrowser ${app.getVersion()}` }
  ];
}

/**
 * Chromium's own developer tools, on the page in front of the user.
 *
 * The full suite - Elements, Console, Network, Performance, Sources - because
 * it is already in the engine this browser is built on. Shipping a hand-made
 * inspector beside it would be strictly worse at every one of those jobs.
 *
 * Where it goes is the user's choice, and the work of putting it there belongs
 * to the shell, which is the only thing that knows how this window is laid out.
 * This used to open detached always, on the reasoning that a docked panel would
 * be a fourth kind of view sharing the content rectangle and would have to be
 * rebuilt on every tab switch. The first half was true and is simply the price;
 * the second was wrong - a hidden view keeps the inspector's state, so coming
 * back to the tab finds the breakpoints and console history still there.
 */
function toggleDevTools(tab, shell, log = () => {}) {
  if (!tab?.isLive) return false;
  if (!shell) {
    log('devtools: no window to open them in');
    return false;
  }
  return shell.toggleDevTools(tab);
}

/**
 * Turn omnibox input into a URL.
 *
 * Anything that parses as a URL or looks like a hostname is treated as one;
 * everything else is a search. This is the only place the browser decides
 * between the two, and it errs toward navigation so that typing a bare
 * hostname never silently becomes a search query.
 */
const DEFAULT_SEARCH = 'https://duckduckgo.com/?q=%s';

/**
 * The sites the new tab page offers, most-visited first.
 *
 * Folded by origin rather than listed by page: twelve rows of the same forum
 * is a list of what you read this morning, not of where you go. Within an
 * origin the most-visited page wins, which is usually its front page but is
 * correctly the inbox for a mail host.
 *
 * Bookmarks fill the gap on a fresh profile. Without them the page a user sees
 * on first run - the one that is supposed to show them what the browser is -
 * would be an empty grid, and the first thing anyone does in a new browser is
 * import their bookmarks.
 */
function topSites(history, bookmarks, limit = 8) {
  const byOrigin = new Map();

  for (const entry of history ? history.all() : []) {
    let origin;
    try {
      const parsed = new URL(entry.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      origin = parsed.origin;
    } catch {
      continue;
    }

    const seen = byOrigin.get(origin);
    if (!seen) {
      byOrigin.set(origin, {
        url: entry.url, title: entry.title, icon: entry.icon || null,
        visits: entry.visits || 1, origin,
        // The page this tile opens, and how often it was visited.
        //
        // Seeded here rather than left undefined: `1 > (undefined || 0)` is
        // true, so every later page on the same origin won the comparison below
        // and the tile ended up pointing at whichever page history happened to
        // list last rather than at the one you actually go to.
        best: entry.visits || 1
      });
      continue;
    }
    seen.visits += entry.visits || 1;
    // The busiest page on the site is the one the tile opens.
    if ((entry.visits || 1) > seen.best) {
      seen.best = entry.visits || 1;
      seen.url = entry.url;
      seen.title = entry.title;
      seen.icon = entry.icon || null;
    }
  }

  const items = [...byOrigin.values()]
    .sort((a, b) => b.visits - a.visits)
    .slice(0, limit);

  if (items.length >= limit || !bookmarks) return items;

  const have = new Set(items.map((item) => item.origin));
  for (const mark of bookmarks.all()) {
    if (items.length >= limit) break;
    let origin;
    try {
      origin = new URL(mark.url).origin;
    } catch {
      continue;
    }
    if (have.has(origin)) continue;
    have.add(origin);
    items.push({ url: mark.url, title: mark.title, icon: mark.icon || null, visits: 0, origin });
  }

  return items;
}

/**
 * Addresses the browser will open on a menu item's say-so.
 *
 * The URL comes from Chromium's hit test rather than from the page's DOM, but
 * it is still a string that crossed a process boundary, and `javascript:` in a
 * new tab would run in whatever page that tab lands on.
 */
function openableUrl(url) {
  try {
    return ['http:', 'https:', 'debrowser:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function normaliseUrl(input, searchTemplate = DEFAULT_SEARCH, { search = false } = {}) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  // "Search for the selected text" means search, even when the selection
  // happens to look like a hostname. Someone who highlighted `example.com` in
  // an article and asked to search for it wants the results page.
  if (search) return searchTemplate.replace('%s', encodeURIComponent(text));

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^(about|data|blob|file):/i.test(text)) return text;

  const looksLikeHost = /^[^\s/?#]+\.[^\s/?#]{2,}([/?#]|$)/.test(text);
  if (looksLikeHost) return `https://${text}`;
  if (text === 'localhost' || text.startsWith('localhost:')) return `http://${text}`;

  return searchTemplate.replace('%s', encodeURIComponent(text));
}

/* ------------------------------------------------------------------ */
/* Smoke test - exercises the full lifecycle headlessly                */
/* ------------------------------------------------------------------ */

function runSmokeTest({ tabs, governor, shell, prefs, bookmarks, runCommand, history, context }) {
  const { runSmoke } = require('./smoke');
  runSmoke({ tabs, governor, shell, app, cfg, prefs, menuModel, toggleDevTools, openInternalPage, bookmarks,
            senderPage: (t, sender) => senderPage(t, shell, sender),
            // The command dispatcher itself, so the suite exercises find and
            // the context menu the way a keystroke does rather than by calling
            // into their parts.
            runCommand: (command, payload) => runCommand(command, payload),
            history, context }).then((code) => {
    app.exit(code);
  }).catch((err) => {
    console.error('[smoke] failed:', err.stack || err.message);
    app.exit(1);
  });
}

module.exports = { normaliseUrl, menuModel, openInternalPage, senderPage };
