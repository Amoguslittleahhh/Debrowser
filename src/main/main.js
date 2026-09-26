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

const { app, ipcMain, session, Menu, dialog, clipboard, screen, BaseWindow, powerMonitor,
        shell: electronShell } = require('electron');
const { loadConfig, isStopped } = require('./config');
const platform = require('./platform');
const { TabManager, BROWSING_PARTITION } = require('./tabs/tab-manager');
const { sweepThumbnails, sweepThumbnailsSync } = require('./tabs/tab');
const { BrowserShell } = require('./window');
const { Prefs, applyPrefs, ZOOM_STEPS, BUDGET_MB } = require('./prefs');
const { Updater } = require('./updater');
const { SiteZoom } = require('./zoom');
const { Credentials, originOf } = require('./credentials');
const { Bookmarks, findProfiles, readProfile, parseExport } = require('./bookmarks');
const { Session, loadWindowState, saveWindowState } = require('./session');
const { History } = require('./history');
const icons = require('./icons');
const presence = require('./presence');
const { Vault } = require('./vault');
const { Speculation } = require('./speculation');
const { DownloadManager } = require('./downloads');
const { Governor } = require('./governor');
const { Prewarm } = require('./prewarm');
const { IpcHub } = require('./ipc');
const { pageMergingStatus } = require('./memory');
const pages = require('./pages');
const shortcuts = require('./shortcuts');
const contextMenu = require('./context-menu');

const fs = require('fs');
const path = require('path');
const incognito = require('./incognito/mode');
const { launchIncognito } = require('./incognito/launch');
const { Tripwire } = require('./incognito/tripwire');
const { Tor, bundleDir: torBundleDir } = require('./incognito/tor');
const bridges = require('./incognito/bridges');
const torState = require('./incognito/torstate');
const { startRelays } = require('./incognito/relay');
const { Circuits } = require('./incognito/circuits');
const policy = require('./incognito/policy');
const { SlowJsHint } = require('./incognito/slowjs');
const { Camouflage } = require('./incognito/camouflage');
const { suggest } = require('./suggest');
const { classifyAddress } = require('./address');
const palette = require('./palette');
const { SitePermissions, PermissionAsks } = require('./site-permissions');

const SMOKE_TEST = process.argv.includes('--smoke-test');

/*
 * Incognito decides where the profile lives, so it runs before anything reads
 * `userData`. A profile directory that is not provably ours alone is a refusal
 * to start, never a repair: see incognito/mode.js.
 */
let incognitoCtx = null;
if (incognito.INCOGNITO) {
  try {
    incognitoCtx = incognito.prepare(app);
  } catch (err) {
    console.error(`[debrowser] incognito cannot start: ${err.message}`);
    process.exit(78);
  }
}
const INCOGNITO = Boolean(incognitoCtx);
/**
 * A private window kept ready (Settings: "Keep a private window ready"):
 * started with the ordinary browser, Tor connecting, the window built but not
 * shown until Ctrl+Shift+N reaches it. It holds no browsing, only Tor.
 */
const WARM = INCOGNITO && process.argv.includes('--warm');

/** Incognito only: the Tor process every request goes through. */
let tor = null;
/** Every session this incognito process has made, so a port change reaches all of them. */
const incognitoSessions = new Set();
/** Set by main() once there is a window to tell. */
let onIncognitoChange = () => {};

/**
 * Incognito's panic: Tor killed, every window destroyed, the process gone -
 * without the goodbyes a normal quit makes (no Tor state sealed, no windows
 * asked). The exit handler deletes this run's files and the reaper takes what
 * the OS was still holding. From the panic key, and from the idle timer.
 */
function panic(reason) {
  if (!INCOGNITO) return;
  console.error(`[debrowser] private window closed at once: ${reason}`);
  if (tor) tor.kill();
  for (const win of BaseWindow.getAllWindows()) {
    try { win.destroy(); } catch { /* already gone */ }
  }
  app.exit(0);
}
const SPEED_TEST = process.argv.includes('--speed-test');
const OFFLINE_MODE = SMOKE_TEST || SPEED_TEST || process.argv.includes('--bench-test');

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

// Incognito keeps nothing on disk and shares nothing between sites.
//
// Hibernation hands page memory to the OS compressor, which on most machines
// can in turn write it to a swap file or pagefile - so the one tier that could
// put a page's contents on a disk is off. One renderer per site is off because
// incognito spends memory on isolation rather than saving it by sharing.
//
// And discarding is pushed back. A discarded private tab comes back by
// reloading through Tor - seconds rather than milliseconds, and a second visit
// the site can see - so incognito keeps more tabs alive and waits three times
// as long before taking one, and relies on freezing, which costs nothing to
// undo, in the meantime.
if (INCOGNITO) {
  cfg.hibernate.enabled = false;
  cfg.processPerSite = false;
  cfg.discardAfterMs *= 3;
  cfg.autoLiveTabs = Math.round(cfg.autoLiveTabs * 1.5);
  if (!cfg.pinned.maxLiveTabs) cfg.maxLiveTabs = cfg.autoLiveTabs;
}

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
// Not in incognito, whose resolver refuses every name: its tests reach the
// fixtures through a stand-in for Tor, the same way a real page would.
if (!INCOGNITO && (SMOKE_TEST || SPEED_TEST || (argv.includes('--bench-test') && argv.includes('--distinct-origins')))) {
  const { HOST_RESOLVER_RULES } = require('./fixture-server');
  app.commandLine.appendSwitch('host-resolver-rules', HOST_RESOLVER_RULES);
}

for (const [name, value] of platform.chromiumSwitches(cfg, incognitoCtx)) {
  if (value === undefined) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, value);
}

// Hardware acceleration has to be decided before the app starts - Chromium
// reads it once, at launch - so the preferences file is read here rather than
// in whenReady. `app.getPath('userData')` is available this early; nothing else
// about the app has to be.
// Incognito reads the normal profile's settings - theme, search engine, its own
// security level - and never writes them: a setting changed in incognito lasts
// until the window closes. Its own profile directory is empty by design.
const earlyPrefs = INCOGNITO
  ? new Prefs(log, { file: path.join(incognitoCtx.normalUserData, 'preferences.json'), readOnly: true })
  : new Prefs(log);
if (earlyPrefs.get('hardwareAcceleration') === false) {
  app.disableHardwareAcceleration();
  log('config', 'hardware acceleration disabled by preference');
}

// The browser's own pages live behind a real scheme, so they have origins,
// URLs and history like any other page. Registration has to happen before the
// app is ready; the handler is installed after it.
pages.registerScheme();

// One instance owns the profile directory; a second launch focuses the first.
// Incognito has a profile directory of its own, so it has a lock of its own,
// and a second incognito launch lands in the first incognito process.
if (!app.requestSingleInstanceLock()) {
  // A private window is already open and gets a new tab instead. Anything the
  // launcher made for this run - its directory, a Tor already starting - goes
  // with this process: Tor exits on its own when its owning process does.
  if (INCOGNITO) incognito.wipe(incognitoCtx);
  app.quit();
} else {
  if (INCOGNITO) {
    // Holding the lock is what makes this safe: whatever is left in the profile
    // belongs to an incognito process that is no longer running.
    incognito.sweep(incognitoCtx.root);
    app.on('session-created', (ses) => {
      incognitoSessions.add(ses);
      incognito.configureSession(ses, incognitoCtx);
    });
    // A certificate that does not check out is fatal, with no way past it. An
    // exit relay is exactly where someone would sit to intercept a connection,
    // and "proceed anyway" is the button that makes that work. Electron already
    // refuses when nothing answers this event; it is answered here so the rule
    // is written down, and cannot be undone by some later handler that allows.
    app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
      event.preventDefault();
      console.error(`[debrowser] refused ${url}: ${error}`);
      callback(false);
    });
    // `exit` rather than `will-quit`: it also runs when something calls
    // `app.exit()` or `process.exit()`, which skip the quit events entirely.
    process.on('exit', () => incognito.wipe(incognitoCtx));
    incognito.startReaper(incognitoCtx,
      platform.helperPath(process.platform === 'win32' ? 'net-watch.exe' : 'net-watch'), log);

    // Inside the Linux kill switch, Tor is already running outside the
    // namespace and the only way to it is its Unix socket. Chromium gets a
    // loopback port that this process relays onto that socket; a port that is
    // taken moves, the same way a Tor that cannot bind does.
    if (incognitoCtx.killSwitch.available && process.env.DEBROWSER_TOR_DIR && !incognitoCtx.externalProxy) {
      const listen = (tries) => startRelays(incognitoCtx.poolPorts, process.env.DEBROWSER_TOR_DIR, log).catch((err) => {
        if (err.code === 'EADDRINUSE' && tries > 0) {
          incognito.movePort(incognitoCtx, incognitoSessions);
          return listen(tries - 1);
        }
        log('relay', `could not listen: ${err.message}`);
        return null;
      });
      listen(3);
    }

    // Tor starts now rather than when the window is up: bootstrapping takes
    // seconds, and every one of them is spent before a page can load. The
    // leak test brings its own stand-in on a port it chose, so no Tor then.
    if (!incognitoCtx.externalProxy) {
      let moves = 0;
      tor = new Tor({
        ctx: incognitoCtx,
        log,
        onStatus: (status) => {
          // Another program had the port. Pick again and restart; the
          // command-line proxy keeps the old port, where nothing listens now,
          // so anything that only it reaches fails closed.
          if (status.state === 'failed' && /Could not bind/.test(status.warning || '') && moves < 3) {
            moves++;
            incognito.movePort(incognitoCtx, incognitoSessions);
            log('tor', `port taken; moving to ${incognitoCtx.proxyPort}`);
            tor.restart();
            return;
          }
          onIncognitoChange();
        }
      });
      // Bridges as set in the ordinary browser's Settings. The Linux launcher
      // is handed the same lines by the browser that starts it.
      tor.extraConfig = () => bridges.torrcLines({
        mode: earlyPrefs.get('incognitoBridges'),
        custom: earlyPrefs.get('incognitoBridgeLines')
      }, torBundleDir());
      // After ready rather than now, because unsealing Tor's kept state needs
      // the OS keystore, which on Linux is not reachable earlier. A Tor the
      // launcher started had its state put in place before it ran.
      app.whenReady().then(() => {
        if (!tor.attached) {
          if (earlyPrefs.get('incognitoKeepTorState')) {
            torState.restore(incognitoCtx.normalUserData, path.join(tor.dir, 'data'), log);
          } else {
            torState.forget(incognitoCtx.normalUserData);
          }
        }
        tor.start();
      });

      // Sealed again on the way out, once Tor has stopped and written its
      // state - so the quit waits for it, briefly.
      let sealed = false;
      app.on('will-quit', (event) => {
        // Only a Tor that connected has state worth keeping.
        if (sealed || !earlyPrefs.get('incognitoKeepTorState') || !tor.everReady) return;
        event.preventDefault();
        sealed = true;
        tor.stopAndWait(3000).then(() => {
          torState.save(incognitoCtx.normalUserData, path.join(tor.dir, 'data'), log);
          app.quit();
        });
      });
    }
  }
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
  /** The passcode lock in front of them; see vault.js. */
  let vault = null;
  let bookmarks = null;
  // `sessionStore`, not `session`: Electron's own `session` is imported at the
  // top of this file and used to reach the browsing partition a few lines
  // below. A local called `session` shadows it, and the first thing that
  // happens then is `null.fromPartition` at startup.
  let sessionStore = null;
  /** @type {Prewarm|null} */
  let prewarm = null;
  let downloads = null;
  /** @type {History|null} */
  let history = null;
  /** Camera, microphone, location and notifications, per site. Never in a private window. */
  let sitePermissions = null;
  let permissionAsks = null;
  /** Incognito only: the check, from outside Chromium, that nothing went around the proxy. */
  let tripwire = null;
  /** Incognito only: which Tor circuit each tab uses. */
  let circuits = null;
  /** Incognito: decoy loads, when the user has turned them on. */
  let camouflage = null;
  /** Incognito: what the fingerprint self-check found at startup, once it has run. */
  let fingerprintAudit = null;
  /** Incognito: the "this page wants faster JavaScript" hint. See incognito/slowjs.js. */
  const slowJs = INCOGNITO ? new SlowJsHint(incognitoCtx.jsLevel) : null;

  /**
   * Downloads are taken over from Chromium rather than added beside it.
   *
   * Electron's own download path is one connection, start to finish, and there
   * is no way to ask it for more - so `will-download` is cancelled and the URL
   * is handed to our manager, in the session it came from. Cancelled rather
   * than left running: two downloads of the same file would race for the same
   * name on disk. Per session, because incognito has one per tab.
   */
  const takeDownloads = (ses) => {
    ses.on('will-download', (event, item) => {
      const url = item.getURL();
      // Only what a download can mean. A blob: or data: URL has no server to
      // ask for ranges and nothing for our manager to fetch, so Chromium keeps
      // those - taking them over would break them to no purpose.
      if (!/^https?:/i.test(url) || !downloads) return;
      event.preventDefault();
      downloads.start(url, { session: ses });
    });
  };
  /** Set by the incognito test suite, which has to watch a trip rather than be closed by one. */
  let onTripForTest = null;

  /**
   * A connection went somewhere other than the proxy. Close everything first
   * and explain second: a private window that stays open while a dialog waits
   * for a click is a window that can keep making that connection.
   */
  const onEgressTrip = (violations) => {
    console.error(`[debrowser] TRIPWIRE: connection outside the proxy: ${violations.join(' ')}`);
    if (onTripForTest) { onTripForTest(violations); return; }
    for (const win of BaseWindow.getAllWindows()) {
      try { win.destroy(); } catch { /* already gone */ }
    }
    dialog.showErrorBox('Incognito was closed',
      'A connection that did not go through the private network was detected, ' +
      'so the window was closed before anything more could be sent.\n\n' +
      violations.slice(0, 4).join('\n'));
    app.exit(70);
  };

  /** The command dispatcher, once `wireCommands` has built it. */
  let runCommand = () => {};

  /**
   * Whether closing a window of several tabs has been agreed to. A close from
   * the window runs `close` then `before-quit`; a quit from the OS runs them
   * the other way round. Set once the user says yes, so the second never asks.
   */
  const quitState = { confirmed: false, asking: false };

  let publishQueued = false;
  const publish = () => {
    // Tab events can arrive in bursts (a load fires several in a row).
    // Coalesce them into one paint of the UI per frame.
    if (publishQueued || !shell || !governor) return;
    publishQueued = true;
    setImmediate(() => {
      publishQueued = false;
      if (shell && governor) shell.publish(governor.snapshot());
      // Tabs came or went: keep a spare new tab while it is cheap (prewarm.js).
      if (prewarm) prewarm.refresh();
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
  const bindShortcuts = (wc, tab = null, { only = null } = {}) => {
    if (!wc || wc.isDestroyed()) return;
    wc.on('before-input-event', (event, input) => {
      // Esc stops a page that is still loading, as in every browser - and
      // still reaches the page, which uses it to close its own dialogs.
      if (tab && input.type === 'keyDown' && input.key === 'Escape' && !input.control && !input.alt &&
          !input.meta && !input.shift && tab.loading && tab.isLive) {
        tab.wc.stop();
        return;
      }
      const hit = shortcuts.match(input);
      if (!hit || (only && !only.has(hit.command))) return;
      // On a website, a key the page may want for itself goes to the page
      // first. See `awaitPageKey`.
      if (hit.pageFirst && tab && !tab.internal) {
        if (!input.isAutoRepeat) awaitPageKey(tab, hit.command);
        return;
      }
      event.preventDefault();
      runCommand(hit.command, hit.payload);
    });
  };

  /*
   * Ctrl+S and Ctrl+/ on a website: the page's, if it uses them - an editor
   * saves its document, a code editor toggles a comment - and the browser's
   * otherwise.
   *
   * The page probe watches the key go through the page's own handlers and says
   * whether the page took it (`debrowser:page-key`). It runs in the top frame
   * and in frames of the same site. Where it cannot see - a frame from another
   * site, a PDF - nothing answers, and the browser acts after a moment, as it
   * did before the page was asked first. The cost of that is an editor inside
   * another site's frame getting both its own action and the browser's.
   */
  const PAGE_KEY_WAIT_MS = 250;
  const pageKeys = new Map();         // tab id -> { command, timer }
  const awaitPageKey = (tab, command) => {
    const had = pageKeys.get(tab.id);
    if (had) clearTimeout(had.timer);
    const timer = setTimeout(() => {
      pageKeys.delete(tab.id);
      if (tab === tabs?.activeTab()) runCommand(command, null);
    }, PAGE_KEY_WAIT_MS);
    pageKeys.set(tab.id, { command, timer });
  };
  ipcMain.on('debrowser:page-key', (event, command, used) => {
    const tab = tabs?.all().find((t) => t.isLive && t.wc.id === event.sender.id);
    const pending = tab && pageKeys.get(tab.id);
    // Only an answer to a key the browser saw pressed: a page cannot open a
    // dialog by sending this on its own.
    if (!pending || pending.command !== command) return;
    clearTimeout(pending.timer);
    pageKeys.delete(tab.id);
    if (!used && tab === tabs.activeTab()) runCommand(command, null);
  });

  const bindPageShortcuts = (tab) => {
    if (!tab.isLive) return;
    bindShortcuts(tab.wc, tab);
    // A tab pressed in the strip and let go over the page: the strip never
    // sees that release, so it is told. See chrome.js, `pointer-released`.
    tab.wc.on('input-event', (_event, input) => {
      if (input.type === 'mouseUp' && shell) shell.toChrome('pointer-released');
    });
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

  /**
   * Incognito, after each page load: a site refusing Tor gets the tab moved
   * to another exit (circuits.checkBlocked), and a site offering an onion
   * address is either followed there - when the user chose to prefer onions -
   * or has the address shown as a button in the toolbar.
   */
  const onPrivateLoad = (tab) => {
    circuits.checkBlocked(tab).then((result) => {
      if (result !== 'ok') log('circuits', `tab ${tab.id} looks blocked: ${result}`);
      if (result === 'ok' && tab.isLive && prefs.get('incognitoPreferOnion')) {
        const onion = policy.onionFor(tab.wc.id);
        if (onion && !policy.isOnion(tab.wc.getURL())) tab.wc.loadURL(onion).catch(() => {});
      }
      publish();
    }).catch((err) => log('circuits', `block check failed: ${err.message}`));
  };

  const onTabEvent = (tab, event, payload) => {
    switch (event) {
      case 'rebuild':
        if (shell) shell.detachTab(tab);
        break;
      case 'realised':
        if (shell) shell.attachTab(tab);
        if (shell && tab.visible && tabs.activeTab() === tab) tab.wc.focus();
        // Per realisation, not per tab: a discarded tab comes back with a new
        // renderer, and the listener died with the old one.
        bindPageShortcuts(tab);
        bindContextMenu(tab);
        bindFind(tab);
        // A page objecting to being left - unsaved work, usually. Chrome's
        // question in Chrome's words; Leave is the default, as there. Answered
        // synchronously, because the event has to be.
        tab.wc.on('will-prevent-unload', (event) => {
          if (!shell || shell.window.isDestroyed()) return;
          const leave = dialog.showMessageBoxSync(shell.window, {
            type: 'question',
            buttons: ['Leave', 'Stay'],
            defaultId: 0,
            cancelId: 1,
            title: 'Leave this page?',
            message: 'Leave this page?',
            detail: 'Changes you made may not be saved.'
          }) === 0;
          if (leave) event.preventDefault();
          else {
            if (tab.closing) tab.closing.stayed();
            // Staying means the page in front is still this one.
            tab.reconcileUrl();
          }
        });
        // A new page has asked nothing yet, whatever the last one asked.
        if (permissionAsks) tab.wc.on('did-navigate', () => permissionAsks.forget(tab));
        // A real page starting to load: the moment a decoy has to start too.
        if (camouflage && !tab.internal) {
          tab.wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) camouflage.onNavigation(tab, url);
          });
        }
        break;
      case 'loaded':
        // Fill on load, for passwords only. Payment details are never filled
        // without a click; see the note on fillSavedLogin.
        fillSavedLogin(tab, credentials, prefs, log, vault);
        if (circuits) onPrivateLoad(tab);
        break;
      case 'activated':
        if (shell) shell.attachTab(tab);
        // The keyboard follows the tab: switching with Ctrl+Tab left no view
        // focused, and the next key went nowhere. A tab still being rebuilt
        // takes it when its page exists ('realised' below).
        if (shell && tab.isLive) tab.wc.focus();
        // A search belongs to the page it was run on. Carrying the bar over to
        // another tab would show a match count for a page nobody is looking at.
        if (shell && shell.findOpen) { find.query = ''; shell.setFindOpen(false); }
        // And its highlights go with it. Closing the bar on a tab switch left
        // every match lit on the page behind, with no bar left to clear them.
        if (find && find.tabId && find.tabId !== tab.id) {
          const searched = tabs.byId(find.tabId);
          if (searched?.isLive) searched.wc.stopFindInPage('clearSelection');
          find.tabId = null;
        }
        // A question the page asked while it was in the background.
        if (permissionAsks && permissionAsks.has(tab) && shell) shell.toChrome('site-ask');
        break;
      case 'open-tab':
        if (tabs && payload?.url) openLinkTab(tabs, prefs, tab, payload.url);
        break;
      case 'visited':
        if (history && payload?.url && history.record({ url: payload.url, title: tab.title })) {
          // Going back to a forgotten site brings its tile back through
          // history; the hidden entry would only be a record of the visit.
          unhideTile(prefs, payload.url);
        }
        break;
      case 'described':
        if (history && payload?.url) history.describe(payload.url, payload);
        // Remembered so the icon route will fetch it. An address Chromium
        // reported for a page the user loaded is the only kind that route will
        // touch beyond the well-known default path.
        if (payload?.favicon) icons.remember(payload.favicon);
        break;
      case 'closed':
        if (circuits) circuits.forgetTab(tab.id);
        if (permissionAsks) permissionAsks.forget(tab);
        if (shell) shell.detachTab(tab);
        rememberClosed(tab);
        break;
      default:
        break;
    }
    // The session is whatever is open right now, written a couple of seconds
    // later. Every one of the events above can change it - a tab created, a
    // page navigated, a tab closed - and a page that redirects twice fires
    // three of them in a second, which is why this is a debounce and not a
    // write. `tabs` is passed as a function because it does not exist yet when
    // this closure is built.
    if (sessionStore) sessionStore.schedule(() => tabs.all(), () => tabs.activeId);
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
    // `session-created` covers every session made from here on; the default one
    // may already exist, so it is configured by hand as well.
    if (INCOGNITO) {
      incognito.configureSession(session.defaultSession, incognitoCtx);
    }
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

    const siteZoom = new SiteZoom(() => prefs.get('defaultZoom'));
    // Incognito: a Tor circuit and a partition per tab. See incognito/circuits.js.
    circuits = INCOGNITO ? new Circuits(incognitoCtx) : null;
    // Incognito, opt-in: a decoy page load beside every real one. See
    // incognito/camouflage.js for what it buys and what it costs.
    camouflage = INCOGNITO ? new Camouflage({
      ctx: incognitoCtx, circuits, log,
      enabled: prefs.get('incognitoCamouflage'),
      // The leak test aims decoys at its own fixture, never at real sites.
      list: SMOKE_TEST && argValue('leak-decoys') ? argValue('leak-decoys').split(',') : undefined
    }) : null;
    // Incognito: every file picked for upload is handed to the page with its
    // image metadata - GPS, camera, owner - removed. See incognito/sanitise.js.
    if (INCOGNITO) {
      const uploads = path.join(incognitoCtx.sessionDir, 'uploads');
      const pick = async ({ multiple }) => {
        // The leak test picks its fixture the way the user would pick a file.
        const planned = SMOKE_TEST && process.env.DEBROWSER_TEST_UPLOAD;
        if (planned) return [planned];
        const res = await dialog.showOpenDialog(shell.window, {
          properties: ['openFile', ...(multiple ? ['multiSelections'] : [])]
        });
        return res.canceled ? [] : res.filePaths;
      };
      require('./incognito/fingerprint').onCovered(
        (tab) => require('./incognito/sanitise').interceptUploads(tab, uploads, pick, log));
      // Files dropped or pasted into a page, from the page preload: images
      // come back without their metadata. Bytes in, bytes out; no paths.
      ipcMain.handle('debrowser:clean-files', (_event, files) => {
        if (!Array.isArray(files) || files.length > 100) return null;
        const { stripImage } = require('./incognito/sanitise');
        return files.map((f) => {
          const bytes = Buffer.from(f && f.bytes ? f.bytes : []);
          const result = stripImage(bytes);
          if (result && result.removed.length) log('sanitise', `${String(f.name).slice(0, 80)}: removed ${result.removed.join(', ')}`);
          return { bytes: result ? result.data : bytes };
        });
      });
    }
    if (circuits) icons.useSession(circuits.iconSession());

    tabs = new TabManager({
      cfg,
      sessionFor: circuits ? () => circuits.newTabSession() : null,
      onNewSession: (ses) => {
        pages.serveSession(ses, log);
        takeDownloads(ses);
      },
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
      // Never in incognito: loading a page because the pointer rested on its
      // tab tells that site what you were about to do.
      canSpeculate: () => !INCOGNITO && Boolean(governor) && governor.allowsSpeculation(),
      applyZoom: (wc) => siteZoom.apply(wc)
    });
    const ipcHub = new IpcHub(() => tabs.all(), log);

    if (!INCOGNITO) {
      // In memory under a test, which must not leave answers behind.
      sitePermissions = new SitePermissions(log, OFFLINE_MODE ? null : app.getPath('userData'));
      permissionAsks = new PermissionAsks(sitePermissions, {
        tabFor: (wc) => tabs.all().find((t) => t.isLive && t.wc.id === wc.id) || null,
        tabById: (id) => tabs.byId(id),
        isActive: (tab) => tabs.activeTab() === tab,
        // The chrome opens the panel, because only it knows where the padlock is.
        show: () => { if (shell) shell.toChrome('site-ask'); },
        // The page the panel was asking for is gone, so is its question.
        withdrawn: () => { if (shell && shell.sheetPage === 'site') shell.closeSheet({ replacing: true }); }
      });
      tabs.askPermission = (wc, kinds, details, callback) => permissionAsks.request(wc, kinds, details, callback);
      tabs.permissionGranted = (origin, kinds) => sitePermissions.decide(originOf(origin), kinds) === 'allow';
    }

    // None at all in a private window. Every request that reads or writes it
    // is refused there already, but filling a saved login on page load asked
    // the store for a key - and on Windows, where the keystore always exists,
    // that created one in the private profile: the leak test found it left
    // behind after exit. A store that is not there cannot be asked.
    credentials = INCOGNITO ? null : new Credentials(log);
    // Links fetched on the pointer's way to them (speculation.js). Not in a
    // private window, where nothing is watched and nothing is asked - and not
    // under `--no-speculation`, which the speed test uses to measure what the
    // whole thing, header watch included, costs and saves.
    if (!INCOGNITO && !argv.includes('--no-speculation')) {
      const speculation = new Speculation({
        enabled: () => prefs.get('preloadPages') !== false,
        isTab: (sender) => tabs.all().some((t) => t.isLive && t.wc.id === sender.id && !t.internal)
      });
      speculation.watch(session.fromPartition(BROWSING_PARTITION));
      speculation.wire();
    }

    // In memory under a test, which must not leave a passcode behind.
    vault = INCOGNITO ? null : new Vault(OFFLINE_MODE ? null : app.getPath('userData'), { log });

    // A submitted sign-in becomes a question, never a save. The origin comes
    // from the tab, not from the page that sent the message.
    if (!INCOGNITO) ipcHub.wireCredentialOffer((tab, offer) => {
      offerToSaveCredential({ tab, offer, credentials, vault, shell, log }).catch(
        (err) => log(`credential offer failed: ${err.message}`));
    });

    shell = new BrowserShell({
      tabManager: tabs,
      prefs,
      log,
      onCommand: (name) => { if (name === 'chrome-ready' || name === 'view-ready') publish(); },
      // Every view the shell owns answers the same table the tabs do - the
      // chrome included, since its own DOM handler is gone.
      bindShortcuts,
      // Never under a test or a benchmark, which assert on the default size.
      bounds: !OFFLINE_MODE && prefs.get('rememberWindowBounds')
        ? fitToDisplay(loadWindowState())
        : null,
      held: WARM
    });
    shell.onSheetClosed = (page) => { if (page === 'site' && permissionAsks) permissionAsks.dismissShown(); };
    // What the main process paints - an error page, the surface behind a tab -
    // takes the window's palette and accent, as our own pages do.
    palette.useTheme(() => ({ light: shell.lightTheme(), accent: prefs.get('accent'), design: prefs.get('design') }));

    shell.window.on('close', (event) => {
      if (shouldAskToClose()) {
        event.preventDefault();
        askToClose(() => shell.close());
        return;
      }
      if (!OFFLINE_MODE && prefs.get('rememberWindowBounds')) {
        try {
          saveWindowState({ ...shell.window.getNormalBounds(), maximized: shell.window.isMaximized() });
        } catch (err) { log(`could not remember the window: ${err.message}`); }
      }
    });

    if (INCOGNITO) {
      // What the window shows about the private connection, on every broadcast.
      // The tab in front: an onion address its site offered, and whether the
      // site refused every exit it was tried from.
      const activeTabPrivacy = () => {
        const tab = tabs && tabs.activeTab();
        if (!tab || !tab.isLive) return { onion: null, refused: false, slowJs: false };
        const onion = policy.onionFor(tab.wc.id);
        return {
          slowJs: slowJs ? slowJs.visibleFor(tab) : false,
          onion: onion && !policy.isOnion(tab.wc.getURL()) ? onion : null,
          refused: circuits ? circuits.refused(tab.id) : false
        };
      };
      shell.incognito = () => ({
        tor: tor ? { ...tor.status } : { state: 'ready', progress: 100, summary: 'External proxy (test)', transport: 'direct' },
        killSwitch: incognitoCtx.killSwitch,
        tripwire: tripwire ? tripwire.status() : null,
        fingerprint: fingerprintAudit,
        // setContentProtection does nothing on Linux; see window.js.
        contentProtection: process.platform !== 'linux',
        fonts: incognitoCtx.fonts,
        ...activeTabPrivacy()
      });
      onIncognitoChange = publish;

      tripwire = new Tripwire({
        app,
        log,
        // The proxy and Tor's control port, and nothing else. Loopback on any
        // other port is a violation too: see net-watch.c for the measurement
        // that made "any loopback" the wrong rule.
        allowedPorts: () => [...incognitoCtx.poolPorts, tor && tor.controlPort].filter(Boolean),
        onTrip: onEgressTrip
      });
      // Away for longer than the user allowed: the same as the panic key. The
      // system's idle time, not this window's - a private window left open on
      // an unattended computer is the case this is for.
      const idleMinutes = prefs.get('incognitoIdleWipeMinutes');
      if (idleMinutes > 0) {
        setInterval(() => {
          if (powerMonitor.getSystemIdleTime() >= idleMinutes * 60) panic(`idle for ${idleMinutes} minutes`);
        }, 15_000).unref();
      }

      // A window kept ready belongs to the browser that started it: if that
      // browser goes while the window was never shown, this goes too. ESRCH
      // only - a signal refused is a process that exists.
      if (WARM) {
        const parent = Number(argValue('warm-parent'));
        if (parent) {
          setInterval(() => {
            if (!shell || !shell.held) return;
            try { process.kill(parent, 0); } catch (err) { if (err.code === 'ESRCH') app.quit(); }
          }, 5000).unref();
        }
      }

      tripwire.capability().then((caps) => log('tripwire', JSON.stringify(caps)));
      tripwire.start();

      // The fingerprint self-check, once, on a session of its own. What it
      // finds is shown on the connection page; a check that could not run is
      // shown too, never taken as a pass.
      const fp = require('./incognito/fingerprint');
      const auditSession = circuits ? circuits.newTabSession() : session.defaultSession;
      pages.serveSession(auditSession, log);
      fp.audit(auditSession, pages.FINGERPRINT_URL, log).then((result) => {
        fingerprintAudit = result.error
          ? { error: result.error }
          : { checked: result.checks.length, problems: result.problems.map((c) => `${c.name} (${c.surface}): ${c.got}`) };
        log('fingerprint', JSON.stringify(fingerprintAudit));
        publish();
      }).catch((err) => { fingerprintAudit = { error: err.message }; publish(); });
    }

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
        onUpdate: (state) => {
          // Incognito: a page too heavy for Balanced JavaScript gets one hint.
          if (slowJs && slowJs.observe(tabs.activeTab())) log('incognito', 'slow-page hint shown');
          if (shell) shell.publish(state);
        }
      });
      governor.start();
    }

    // Started while the pointer is still on its way to the + or the menu, so
    // the first new tab page of a session does not pay to start a renderer
    // after the click. Off under a test or a benchmark: both assert on measured
    // memory, and a spare renderer appearing on a timer would make the numbers
    // depend on where a pointer had been.
    prewarm = new Prewarm({
      session: () => session.fromPartition(BROWSING_PARTITION),
      hasLiveInternal: () => tabs.all().some((t) => t.internal && t.isLive),
      // An animation to keep out of the way of, or memory getting tight: a
      // spare is the first thing to give up.
      busy: () => Boolean(governor && (governor.boost.quiesceRequested || governor.pressure !== 'none')),
      // The speed test measures it; the smoke test and the memory benchmark
      // must not have a spare view appearing under their counts.
      enabled: !INCOGNITO && (!OFFLINE_MODE || SPEED_TEST),
      log
    });
    // A new tab page takes the spare, already loaded and drawn.
    tabs.takeSpare = () => prewarm.take();

    // Incognito reads the normal profile's bookmarks - they are how people get
    // to the sites they use - and cannot change them: a bookmark saved from a
    // private window would be a record of it in the ordinary profile.
    bookmarks = INCOGNITO ? new Bookmarks(log, incognitoCtx.normalUserData) : new Bookmarks(log);
    bookmarks.onChange = () => publish();
    // Bookmarking a site whose tile was taken away is asking for it back.
    bookmarks.onAdd = (entry) => unhideTile(prefs, entry.url);
    if (INCOGNITO) bookmarks.readOnly = true;
    // So the state broadcast can carry the revision the bookmarks bar watches.
    shell.bookmarks = bookmarks;
    // Read live rather than captured, so switching recording off in the history
    // page stops the very next navigation from being written down.
    //
    // Never under a test or a benchmark. Those run against the real profile
    // directory and visit two dozen fixture pages per run, and writing them
    // into the user's own history would be this browser filling their records
    // with its own test suite.
    history = new History(log, { enabled: () => !OFFLINE_MODE && !INCOGNITO && prefs.get('saveHistory') });
    // The stored icon addresses came from this same signal in earlier sessions,
    // so they are exactly as trusted as the ones this session will report - and
    // without seeding them, every row from before today would fall back to its
    // letter until the site was visited again.
    icons.rememberAll(history.all().map((entry) => entry.icon));

    runCommand = wireCommands({
      tabs, shell, governor, prefs, publish, log, prewarm,
      bookmarks, closedTabs, context, find, quitState, siteZoom, circuits, slowJs,
      sitePermissions, permissionAsks,
      // A getter: the manager is made just below, once the commands exist.
      getDownloads: () => downloads
    });

    // Downloads are taken over from Chromium rather than added beside it.
    //
    // Electron's own download path is one connection, start to finish, and
    // there is no way to ask it for more - so `will-download` is cancelled and
    // the URL is handed to our manager. Cancelled rather than left running: two
    // downloads of the same file would race for the same name on disk.
    downloads = new DownloadManager({
      dir: () => downloadDir(prefs),
      // One connection over Tor: several would share a circuit and gain nothing
      // but load on the exit relay.
      connections: () => (INCOGNITO ? 1 : prefs.get('downloadConnections')),
      // The system's own save dialog, when Settings asks for one. Never under a
      // test, where nobody is there to answer it.
      // "Save link as…" and "Save image as…" always ask - that is what the
      // words promise - whatever the setting says.
      saveAs: (defaultPath, { ask = false } = {}) => {
        if (OFFLINE_MODE || (!ask && !prefs.get('askWhereToSave'))) return undefined;
        const asked = shell && !shell.window.isDestroyed()
          ? dialog.showSaveDialog(shell.window, { defaultPath })
          : dialog.showSaveDialog({ defaultPath });
        return asked.then((r) => (r.canceled || !r.filePath ? null : r.filePath));
      },
      // Same session the cancelled download came from, so a file behind a
      // sign-in still fetches as the signed-in user.
      session: session.fromPartition(BROWSING_PARTITION),
      log,
      onChange: () => publish()
    });
    // So the state broadcast can carry the count and progress the toolbar
    // button draws, without carrying the list itself.
    shell.downloads = downloads;
    takeDownloads(session.fromPartition(BROWSING_PARTITION));
    wireRequests({ tabs, shell, credentials, vault, bookmarks, history, downloads, prefs, log, context,
      sitePermissions, permissionAsks });

    /*
     * The tabs from last time, or one new one.
     *
     * Restored unrealised - a strip entry and a saved address, no renderer -
     * which is the same state the idle ladder leaves a tab in. Forty restored
     * tabs are forty rows and one renderer for the one you are looking at, so a
     * restart costs about what a single tab costs. That is the point: the
     * browser that argues tabs should be cheap to keep should not lose them all
     * when you close the window.
     *
     * Never under a test or a benchmark, which must start from a known state
     * rather than from whatever the machine's last real run left behind.
     */
    sessionStore = OFFLINE_MODE || INCOGNITO ? null : new Session(log);
    const saved = sessionStore && prefs.get('restoreTabs') === true
      ? sessionStore.load()
      : { tabs: [], activeIndex: 0 };

    if (saved.tabs.length) {
      saved.tabs.forEach((entry, i) => {
        const tab = tabs.create({ url: entry.url, activate: false, realise: false });
        tab.title = entry.title || tab.title;
        tab.pinned = entry.pinned === true;
      });
      const active = tabs.all()[saved.activeIndex] || tabs.all()[0];
      if (active) tabs.activate(active.id).catch((err) => log(`restore failed: ${err.message}`));
      log('session', `restored ${saved.tabs.length} tab(s)`);
    } else if (INCOGNITO && tor && tor.status.state !== 'ready') {
      // Nothing can load until Tor is connected, so the first page is the one
      // that says how far along it is. It moves on to a new tab by itself.
      tabs.create({ url: `${pages.TOR_URL}?then=newtab` });
    } else {
      tabs.create({ url: newTabUrl(prefs) });
    }
    shell.layout();
    if (prewarm) prewarm.holdUntil(firstTabLoaded(tabs.activeTab()));

    // Updates last, and never under a test or a benchmark: both assert on
    // measured memory and CPU, and a background download competing with them
    // would make the numbers depend on whether a release happened to be out.
    if (!OFFLINE_MODE && !INCOGNITO) {
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

    if (SMOKE_TEST && INCOGNITO) {
      require('./smoke-incognito').run({
        app, tabs, shell, downloads, tripwire, circuits, camouflage, runCommand, ctx: incognitoCtx, log,
        setTripHook: (fn) => { onTripForTest = fn; }
      }).then((code) => app.exit(code), (err) => {
        console.error('[smoke-incognito] failed:', err.stack || err.message);
        app.exit(1);
      });
    } else if (SMOKE_TEST) {
      runSmokeTest({ tabs, governor, shell, prefs, bookmarks, runCommand, history, context, credentials, vault });
    } else if (SPEED_TEST) {
      // Startup, from this process starting to the first tab drawn.
      const startedAt = Date.now() - process.uptime() * 1000;
      const first = tabs.activeTab();
      const speed = require('./speed');
      (async () => {
        let startup = null;
        if (first && first.wc) {
          const painted = await speed.paintedAt(first.wc).catch(() => null);
          if (painted) startup = Math.round(painted - startedAt);
        }
        const runs = Number((argv.find((a) => a.startsWith('--speed-runs=')) || '').split('=')[1]) || 15;
        const report = await speed.runSpeed({ tabs, runCommand, log, runs });
        speed.print(report, startup);
        if (argv.includes('--speed-json')) console.log(`SPEED_JSON ${JSON.stringify({ startup, report })}`);
        app.exit(0);
      })().catch((err) => { console.error('[speed] failed:', err.stack || err.message); app.exit(1); });
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
    // A window kept ready is shown, with the tab it already has.
    if (shell && shell.held) {
      shell.release();
      return;
    }
    // A second Ctrl+Shift+N reaches the incognito process that is already
    // running, and means what it says: another private tab.
    if (INCOGNITO && tabs) tabs.create({ url: pages.NEW_TAB_URL });
    if (shell && !shell.window.isDestroyed()) {
      if (shell.window.isMinimized()) shell.window.restore();
      shell.window.focus();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { quittingForGood = true; });

  // Keep a private window ready, if asked: after the ordinary window exists,
  // so its start is not slowed by Tor's.
  // Inside whenReady: `prefs` is assigned by the ready handler registered above,
  // which runs first.
  app.whenReady().then(() => {
    if (INCOGNITO || OFFLINE_MODE || !prefs || !prefs.get('incognitoKeepWarm')) return;
    setTimeout(() => startIncognito({ prefs, log, warm: true }), 2000);
  });

  app.on('before-quit', (event) => {
    // A quit from the OS arrives here before the window hears of it, and what
    // follows empties the tab list, so the question has to be asked first.
    if (shouldAskToClose()) {
      event.preventDefault();
      askToClose(() => app.quit());
      return;
    }
    if (updater) updater.stop();
    if (prewarm) prewarm.drop();
    if (governor) governor.stop();
    // Writes are debounced by a few seconds, and quit does not wait for a
    // timer, so the last few pages visited would be lost on every close.
    // Cleared instead, if Settings asks for that; `clear` writes synchronously.
    if (history && !OFFLINE_MODE && prefs && prefs.get('clearHistoryOnExit')) {
      history.clear();
      if (prefs.get('hiddenTiles').length) prefs.set('hiddenTiles', []);
    }
    else if (history) history.flush();
    // Before `closeAll`, which empties the list this describes. Written
    // synchronously because quit does not wait for a timer, and the debounce
    // above means the last thing the user did is usually still pending.
    if (sessionStore && tabs) sessionStore.flush(tabs.all(), tabs.activeId);
    if (tabs) tabs.closeAll();
    // The trim helper is a long-lived child process of ours. Nothing else ends
    // it, and it holds an open stdin on a pipe that outlives us.
    platform.stopTrimHelper();
    platform.stopMeasureHelper();
    if (tripwire) tripwire.dispose();
    if (tor) tor.stop();
    // Synchronous on purpose: quit does not wait for promises, and leaving
    // page screenshots on disk is the one cleanup that must not be best effort.
    sweepThumbnailsSync();
  });

  /** Whether closing now needs the user's say-so: several tabs, and the setting on. */
  function shouldAskToClose() {
    return !OFFLINE_MODE && !quitState.confirmed && Boolean(prefs && tabs) &&
      prefs.get('confirmCloseTabs') === true && tabs.all().length > 1;
  }

  /** Ask once, however many close attempts arrive while the dialog is up. */
  function askToClose(proceed) {
    if (quitState.asking || !shell || shell.window.isDestroyed()) return;
    quitState.asking = true;
    const count = tabs.all().length;
    dialog.showMessageBox(shell.window, {
      type: 'question',
      buttons: ['Close tabs', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Close window?',
      message: `Close the window and its ${count} tabs?`,
      detail: prefs.get('restoreTabs') ? 'They reopen the next time you start the browser.' : '',
      checkboxLabel: 'Don\'t ask again'
    }).then(({ response, checkboxChecked }) => {
      quitState.asking = false;
      if (checkboxChecked) { prefs.set('confirmCloseTabs', false); publish(); }
      if (response !== 0) return;
      quitState.confirmed = true;
      proceed();
    }).catch((err) => {
      quitState.asking = false;
      log(`close prompt failed: ${err.message}`);
    });
  }

  // Pages must never be able to open a renderer with elevated privileges.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

/* ------------------------------------------------------------------ */
/* Commands from the browser chrome                                    */
/* ------------------------------------------------------------------ */

let quittingForGood = false;
/** A private window gone this soon never got as far as showing itself. */
const PRIVATE_START_MS = 15_000;

/**
 * Start the private browser - or, with `warm`, one that connects Tor and keeps
 * its window back until Ctrl+Shift+N reaches it. A kept-ready one that ends,
 * because it was shown and then closed, is replaced by a new one while the
 * setting is on and this browser is not quitting.
 */
function startIncognito({ prefs, log, warm = false }) {
  return launchIncognito(log, bridges.torrcLines({
    mode: prefs.get('incognitoBridges'),
    custom: prefs.get('incognitoBridgeLines')
  }, torBundleDir()), {
    keepTorState: prefs.get('incognitoKeepTorState'),
    userData: app.getPath('userData'),
    warm,
    onExit: warm ? () => {
      if (quittingForGood || !prefs.get('incognitoKeepWarm')) return;
      setTimeout(() => startIncognito({ prefs, log, warm: true }), 3000).unref();
    } : null,
    // Asked for and gone with an error: without this, Ctrl+Shift+N did
    // nothing at all that anyone could see.
    //
    // Only a failure to start says it failed to start. The tripwire closes a
    // window in use with its own explanation (exit 70), and a private window
    // that ends later with an error had a window - saying it "couldn't open"
    // then would be false, and would bury the real reason under it.
    onFail: warm ? null : (code, ranMs) => {
      log('incognito', `private window exited with code ${code} after ${ranMs} ms`);
      if (quittingForGood || code === 70) return;
      const early = ranMs < PRIVATE_START_MS;
      const parent = BaseWindow.getAllWindows().find((w) => !w.isDestroyed());
      dialog.showMessageBox(parent, {
        type: 'warning',
        buttons: ['OK'],
        title: 'Private window',
        message: early ? 'The private window couldn’t open.' : 'The private window closed unexpectedly.',
        detail: early ? 'It stopped before its window appeared. Try again in a moment.'
          : 'Nothing from it was kept. Open a new one with Ctrl+Shift+N.'
      }).catch(() => {});
    }
  });
}

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
                       find = null, quitState = null, siteZoom = new SiteZoom(() => 1),
                       circuits = null, slowJs = null, sitePermissions = null, permissionAsks = null,
                       getDownloads = () => null }) {
  /** Activate a tab, repaint, and say so if it failed. Used by four commands. */
  const goTo = (id) => tabs.activate(id)
    .then(publish)
    .catch((err) => log(`activate failed: ${err.message}`));

  /**
   * Close a tab once its page has agreed to go.
   *
   * The page runs its beforeunload; if it objects, `will-prevent-unload`
   * asks the user, and "Stay" keeps the tab. A page that never answers - hung
   * on a script - is closed anyway after a moment, since a close button that
   * does nothing is worse than the work it might lose.
   */
  const closeAfterUnload = (tab) => {
    if (tab.closing) return;
    const wc = tab.wc;
    let timer = null;
    const finish = () => {
      clearTimeout(timer);
      if (!tab.closing) return;
      tab.closing = null;
      if (!tabs.all().includes(tab)) return;
      tabs.close(tab.id);
      if (tabs.all().length === 0) lastTabClosed();
      publish();
    };
    tab.closing = {
      // "Stay": the page keeps its tab.
      stayed: () => {
        clearTimeout(timer);
        wc.removeListener('destroyed', finish);
        tab.closing = null;
      }
    };
    wc.once('destroyed', finish);
    timer = setTimeout(finish, 1500);
    wc.close({ waitForBeforeUnload: true });
  };

  /** The strip just emptied: close the window, or keep it with a new tab. */
  const lastTabClosed = () => {
    if (prefs.get('lastTabCloses') === 'new-tab') tabs.create({ url: newTabUrl(prefs) });
    else shell.close();
  };

  // Commands that change nothing the state broadcast carries. Each is sent as
  // the pointer moves, and repainting every view in the browser for each one
  // would cost more than the command itself.
  const UNPUBLISHED = new Set(['suggest-hover', 'suggest-select', 'suggest-size', 'prefetch-tab']);

  const runCommand = (command, payload, sender = null) => {
    if (INCOGNITO && INCOGNITO_REFUSED.has(command)) return undefined;
    const active = tabs.activeTab();

    switch (command) {
      case 'new-tab':
        tabs.create({ url: payload?.url || newTabUrl(prefs) });
        break;

      case 'tor-retry':
        if (tor) tor.restart();
        break;

      // A different exit for the tab in front - the thing to try when a site
      // blocks one exit, or a page is slow on one circuit. The tab reloads on
      // the new circuit; the pages it opened share its partition and move too.
      case 'new-circuit': {
        if (!circuits || !active) break;
        circuits.newCircuit(active.session);
        if (active.isLive) active.wc.reload();
        break;
      }

      // Everything forgotten at once: every tab closed, every partition's
      // cookies, storage and cache cleared, every connection dropped, and Tor
      // told to build new circuits for everything after. One fresh tab is
      // opened first, because closing the last tab closes the window.
      case 'panic':
        panic('panic key');
        break;

      // The address bar's list: the highlight moved, it was dismissed, or a row
      // was taken - by the keyboard in the bar, or by a press in the list.
      case 'suggest-select':
        shell.selectSuggestion(Number(payload?.index ?? -1));
        break;
      case 'suggest-hide':
        shell.hideSuggestions();
        break;
      case 'suggest-size':
        shell.sizeSuggestions(Number(payload?.height));
        break;
      // The pointer moved onto a row: it is the selection now, for Enter too.
      case 'suggest-hover': {
        const index = Number(payload?.index);
        if (!Number.isInteger(index) || index < 0) break;
        shell.suggestSelected = index;
        shell.toChrome('suggest-hover', { index });
        break;
      }

      case 'suggest-pick': {
        const item = (shell.suggestItems || [])[Number(payload?.index)];
        shell.hideSuggestions();
        shell.toChrome('suggest-done');
        if (!item) break;
        if (item.kind === 'tab') {
          if (tabs.byId(item.tabId)) goTo(item.tabId);
          break;
        }
        // The go row is exactly what was typed, and goes as typed, so it gets
        // the same retry over http that Enter on the same text does.
        const url = item.kind === 'search'
          ? normaliseUrl(item.title, prefs.searchTemplate(), { search: true })
          : item.kind === 'go' ? item.url : normaliseUrl(item.url, prefs.searchTemplate());
        if (!url) break;
        // A middle-click opens it as a link would: behind the page, beside it.
        // A new tab has no retry over http, so it gets the full address.
        if (payload?.newTab) openLinkTab(tabs, prefs, active, normaliseUrl(url, prefs.searchTemplate()));
        else runCommand('navigate', { url });
        break;
      }

      case 'dismiss-slow-js':
        if (slowJs) slowJs.dismiss();
        break;

      // The onion address the tab's site offered, opened in the same tab.
      // Taken from what the site sent, never from the renderer's payload.
      case 'open-onion': {
        if (!INCOGNITO || !active || !active.isLive) break;
        const onion = policy.onionFor(active.wc.id);
        if (onion) active.wc.loadURL(onion).catch(() => {});
        break;
      }

      case 'new-identity': {
        if (!INCOGNITO) break;
        const old = tabs.all().slice();
        tabs.create({ url: newTabUrl(prefs) });
        for (const tab of old.reverse()) tabs.close(tab.id);
        closedTabs.length = 0;
        for (const ses of incognitoSessions) {
          ses.clearStorageData().catch(() => {});
          ses.clearCache().catch(() => {});
          try { ses.closeAllConnections(); } catch { /* older Electron */ }
        }
        if (tor) tor.newIdentity().catch((err) => log('tor', `new identity: ${err.message}`));
        break;
      }

      // The one way to load a page over plain HTTP in a private window: the
      // explanation page's own button, for that host, until the window closes.
      // Only that page may send it - anything else asking is refused.
      case 'allow-http': {
        if (!INCOGNITO || !sender || pages.pageName(sender.getURL()) !== 'insecure') break;
        const url = String(payload?.url || '');
        if (!policy.allowHttp(url)) break;
        const tab = tabs.all().find((t) => t.isLive && t.wc === sender) || active;
        if (tab && tab.isLive) tab.wc.loadURL(url).catch(() => {});
        break;
      }

      case 'new-incognito-window':
        // From inside incognito this is simply another private tab.
        if (INCOGNITO) tabs.create({ url: newTabUrl(prefs) });
        else startIncognito({ prefs, log });
        break;

      case 'close-tab': {
        // A page with work it has not saved gets its say first - its own
        // beforeunload, which the browser asks about as "Leave this page?".
        // Only a page that can answer: a frozen, discarded or crashed one
        // would never reply, and our own pages have nothing to lose.
        const tab = tabs.byId(payload?.id ?? tabs.activeId);
        if (!tab) break;
        if (tab.isLive && !tab.crashed && !tab.internal && !isStopped(tab.tier)) {
          closeAfterUnload(tab);
          break;
        }
        tabs.close(tab.id);
        // Closing the last tab closes the browser, the way every other browser
        // behaves. An empty window with a tab strip holding nothing is a state
        // with no way forward except opening a tab or closing the window, so
        // offering it is offering a dead end.
        //
        // The window is closed rather than the app quit directly: the
        // `window-all-closed` handler already owns quitting, and `before-quit`
        // does real work - session state is written there - which a quit from
        // here would be racing.
        //
        // Unless the user asked to keep the window, in which case the dead end
        // becomes a fresh tab instead.
        if (tabs.all().length === 0) lastTabClosed();
        break;
      }

      case 'activate-tab':
        goTo(payload?.id);
        break;

      case 'prefetch-tab':
        // Pointer resting on a tab. Deliberately not followed by publish(): a
        // speculation is not a state change the user asked for, and repainting
        // the chrome for every tab the pointer pauses on would cost more than
        // the head start is worth.
        if (prefs.get('hoverPrefetch') !== false) tabs.speculate(payload?.id);
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
          // The private window's own pages mean nothing here - the plain-HTTP
          // explanation's buttons did nothing, the self-check checked nothing -
          // so the ordinary browser shows the page that says what private
          // windows are, instead.
          const privateOnly = ['insecure', 'fingerprint', 'blank'].includes(pages.pageName(target));
          openInternalPage(tabs, !INCOGNITO && privateOnly ? pages.TOR_URL : target);
          break;
        }

        const tab = payload?.id ? tabs.byId(payload.id) : active;
        if (!tab) break;
        if (!tab.isLive) tab.realise();
        // https was a guess - the user typed no scheme - so a site that turns
        // out not to speak it is tried again over http rather than left as an
        // error page. Never in a private window, which has its own rule: the
        // plain version is only loaded after the user is told what it costs.
        const fallback = !INCOGNITO && classifyAddress(payload?.url) === 'host' ? target : null;
        // A renderer built for one of our pages never carries a website.
        // Before `url` changes: the rebuild remembers the page it left, to go
        // back to if the site never commits (a download link, or Esc).
        if (tab.realisedInternal) {
          tab.rebuildFor(target);
          tab.httpFallback = fallback;
          break;
        }
        tab.url = target;
        tab.httpFallback = fallback;
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
        if (find) find.tabId = active.id;
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
        // Opened only if it is not up: asking an open bar to open again selects
        // its text, and Enter or F3 then made the next letter typed replace
        // the whole query instead of refining it.
        if (!shell.findOpen) shell.setFindOpen(true);
        if (!query || !active?.isLive) { shell.focusChrome(); break; }
        if (find) find.tabId = active.id;
        active.wc.findInPage(query, { findNext: true, forward: command === 'find-next' });
        break;
      }

      /* -- From the page's own context menu --------------------------- */

      case 'open-link-tab': {
        const url = String(payload?.url || '');
        // The page that was right-clicked, which the menu recorded; the tab in
        // front is the same one unless something switched tabs meanwhile.
        // From the bookmarks bar there is no menu behind it: the tab in front.
        const opener = (!payload?.fromBar && context.model?.tabId && tabs.byId(context.model.tabId)) || active;
        if (openableUrl(url)) openLinkTab(tabs, prefs, opener, url);
        break;
      }

      case 'copy-link':
      case 'copy-text': {
        const text = String(payload?.text ?? '');
        if (text) clipboard.writeText(text);
        break;
      }

      // Straight to the download manager, which names the file - and asks where
      // to put it, if Settings says to - the same path a click on a download
      // link takes.
      case 'save-link': {
        const url = String(payload?.url || '');
        if (!active?.isLive) break;
        const downloads = getDownloads();
        if (/^https?:/i.test(url) && downloads) {
          // Asking where, with the page as referrer - except from a private
          // window, whose referrers never leave the site (see policy.js).
          downloads.start(url, {
            session: active.wc.session,
            ask: true,
            referrer: INCOGNITO ? null : active.wc.getURL()
          });
        } else if (/^(data|blob):/i.test(url)) {
          // No server to fetch it from again: Chromium saves these itself, and
          // asks where.
          active.wc.downloadURL(url);
        }
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
      // The image under the pointer, onto the clipboard as a picture.
      case 'copy-image': {
        const at = context.model?.params;
        if (active?.isLive && at) active.wc.copyImageAt(Math.round(at.x || 0), Math.round(at.y || 0));
        break;
      }

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
        // So those ask the chrome, which measures its button and sends this
        // again with the anchor.
        const right = Number(payload?.right);
        if (!(Number.isFinite(right) && right > 0)) { shell.toChrome('open-downloads'); break; }
        shell.openSheet('downloads', payload);
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

      // Ctrl+/ - every shortcut, in words, over the window.
      case 'show-shortcuts':
        shell.openSheet('shortcuts');
        break;

      // The padlock, or a site asking for something: the site panel, hung
      // from the padlock. The chrome measures where that is.
      // From the padlock, a toggle. From a question arriving, never a close:
      // the panel already open is drawn again with the question in it.
      case 'open-site':
        shell.openSheet('site', payload, { refresh: payload?.ask === true });
        break;

      // An answer to the question the panel is showing, which is always the
      // active tab's: the origin comes from the tab, never from the payload.
      case 'permission-answer': {
        if (!permissionAsks || !active) break;
        // Only the question the panel drew. If the page has since moved on
        // and asked something else, that one is shown instead of answered.
        const answered = permissionAsks.answer(active, payload?.allow === true);
        shell.closeSheet();
        if (!answered || permissionAsks.has(active)) shell.toChrome('site-ask');
        break;
      }

      // A switch in the panel. Also for the active tab's own site only.
      case 'site-permission': {
        const origin = active && originOf(active.url);
        if (!sitePermissions || !origin) break;
        const value = payload?.value === 'allow' || payload?.value === 'block' ? payload.value : null;
        sitePermissions.set(origin, String(payload?.kind), value);
        if (permissionAsks) permissionAsks.settle(active);
        break;
      }

      // Cookies and everything else the site keeps in the browser, for this
      // one site, then the page reloaded so it starts again without them.
      case 'site-clear-data': {
        const origin = active && originOf(active.url);
        if (!origin || !active.isLive) break;
        active.wc.session.clearStorageData({ origin })
          .then(() => { if (active.isLive) active.wc.reload(); })
          .catch((err) => log(`clearing site data failed: ${err.message}`));
        break;
      }

      // From the browser's own update prompt. Restarting into the installer is
      // the updater's to do - this only carries the answer.
      case 'update-restart':
        shell.closeSheet();
        // The user already chose to restart; the tabs come back with the session.
        if (quitState) quitState.confirmed = true;
        if (prewarm) prewarm.drop();
        if (shell.updater) shell.updater.install();
        break;

      case 'open-settings':
        // One deep link, from the passwords page to where its passcode is set.
        openInternalPage(tabs, payload?.section === 'credentials'
          ? `${pages.SETTINGS_URL}#credentials` : pages.SETTINGS_URL);
        publish();
        break;

      case 'open-history':
        openInternalPage(tabs, pages.HISTORY_URL);
        publish();
        break;

      case 'open-passwords':
        if (INCOGNITO) break;
        openInternalPage(tabs, pages.PASSWORDS_URL);
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
          // Forgets the site's own zoom, so it follows the default again -
          // including a default changed later.
          if (active?.isLive) siteZoom.reset(active.wc);
        } else {
          stepZoom(active, payload?.direction === 'out' ? -1 : +1, siteZoom);
        }
        // The badge in the address bar follows at once, not at the next tick.
        publish();
        break;

      // The page and what it needs to show - images, styles - saved beside
      // it, where the user chooses. Suggested under the page's title in the
      // downloads folder, which is where they look for anything they kept.
      case 'save-page': {
        const tab = active;
        if (!tab?.isLive || tab.internal) break;
        const name = (tab.title || 'page').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ')
          .trim().slice(0, 100) || 'page';
        downloadDir(prefs)
          .then((dir) => dialog.showSaveDialog(shell.window, {
            title: 'Save page',
            defaultPath: path.join(dir, `${name}.html`),
            filters: [{ name: 'Web page', extensions: ['html', 'htm'] }]
          }))
          .then(({ canceled, filePath }) => {
            if (canceled || !filePath || !tab.isLive) return null;
            return tab.wc.savePage(filePath, 'HTMLComplete');
          })
          .catch((err) => log(`saving the page failed: ${err.message}`));
        break;
      }

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
        // Open pages follow a new default at once, bar the sites zoomed by hand.
        if (payload.key === 'defaultZoom') {
          for (const tab of tabs.all()) if (tab.isLive) siteZoom.apply(tab.wc);
        }
        // What the main process painted in the old palette: error pages, and
        // the surface behind our own pages.
        if (payload.key === 'theme' || payload.key === 'accent' || payload.key === 'design') {
          for (const tab of tabs.all()) {
            if (!tab.isLive) continue;
            if (tab.failed) tab.redrawError();
            try { tab.view.setBackgroundColor(palette.surfaceFor(tab.url)); } catch { /* view going away */ }
          }
        }
        publish();
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

      // A dwell on the + or the menu. Both open one of the browser's own pages,
      // and all of them share a renderer - so one warm process serves the new
      // tab page, Settings and History alike.
      case 'prefetch-new-tab':
        if (prewarm && prefs.get('hoverPrefetch') !== false) prewarm.warm();
        break;

      // How tall the chrome's own contents come to. Only it can measure that,
      // and full screen down the side is where the answer matters: the strip is
      // a floating panel there, and a panel is as tall as what is in it.
      case 'chrome-size':
        shell.setChromeHeight(payload?.height);
        break;

      /*
       * Right-click on a tab.
       *
       * The one menu this browser was missing, and the one people reach for
       * without thinking: close the other twelve, duplicate this, silence
       * whichever tab is making that noise. Built here rather than in the strip
       * because every item is a command with a tab id, and the chrome holds no
       * authority over tabs beyond naming one.
       *
       * Drawn in the context sheet, which is already a list of labelled
       * commands anchored to a point - the same view the page menu and the
       * bookmarks overflow use.
       */
      // Right-click on a bookmark in the bar: open it, change it, or let it go.
      case 'bookmark-menu': {
        const mark = bookmarks && bookmarks.all().find((b) => b.id === String(payload?.id ?? ''));
        if (!mark) break;
        context.model = {
          params: {},
          items: [
            { id: 'navigate', label: 'Open', icon: 'forward', payload: { url: mark.url } },
            { id: 'new-tab', label: 'Open in new tab', icon: 'plus', payload: { url: mark.url } },
            // A private window reads the bookmarks and never changes them.
            ...(INCOGNITO ? [] : [
              { kind: 'separator' },
              { id: 'open-bookmarks', label: 'Edit…', icon: 'star' },
              { id: 'forget-bookmark', label: 'Delete', icon: 'close', payload: { id: mark.id } }
            ])
          ]
        };
        const x = Math.round(Number(payload?.x) || 0);
        const y = Math.round(Number(payload?.y) || 0);
        shell.openSheet('context', { x, y, right: x });
        break;
      }

      case 'forget-bookmark':
        if (bookmarks) bookmarks.remove(String(payload?.id ?? ''));
        break;

      case 'tab-menu': {
        const tab = tabs.byId(payload?.id);
        if (!tab) break;
        const all = tabs.all();
        const at = all.indexOf(tab);
        const others = all.filter((t) => t !== tab && !t.pinned).length;
        const right = all.slice(at + 1).filter((t) => !t.pinned).length;
        const id = tab.id;

        context.model = {
          params: {},
          items: [
            { id: 'duplicate-tab', label: 'Duplicate', icon: 'copy', payload: { id } },
            {
              id: 'pin-tab',
              label: tab.pinned ? 'Unpin' : 'Pin',
              icon: 'pin',
              payload: { id }
            },
            {
              id: 'mute-tab',
              // Named for what it will do, not for what is true now: a menu
              // item that says "Muted" leaves you guessing whether pressing it
              // mutes or unmutes.
              label: tab.muted ? 'Unmute' : 'Mute',
              icon: 'mute',
              payload: { id }
            },
            { kind: 'separator' },
            { id: 'close-tab', label: 'Close', icon: 'close', accel: shortcuts.accelFor('close-tab'), payload: { id } },
            {
              id: 'close-other-tabs',
              label: 'Close other tabs',
              icon: 'close',
              payload: { id },
              enabled: others > 0
            },
            {
              id: 'close-tabs-right',
              label: 'Close tabs to the right',
              icon: 'close',
              payload: { id },
              enabled: right > 0
            },
            { kind: 'separator' },
            {
              id: 'reopen-closed-tab',
              label: 'Reopen closed tab',
              icon: 'clock',
              accel: shortcuts.accelFor('reopen-closed-tab'),
              enabled: closedTabs.length > 0
            }
          ]
        };

        const x = Math.round(Number(payload?.x) || 0);
        const y = Math.round(Number(payload?.y) || 0);
        shell.openSheet('context', { x, y, right: x });
        break;
      }

      // The bookmarks that did not fit on the bar, as a menu.
      //
      // The chrome names them by id and nothing else: it holds no addresses,
      // and a bar that could ask for a menu of arbitrary URLs would be a page
      // deciding what the browser offers to open. The ids are looked up here,
      // in the store, and anything that no longer exists is simply absent.
      //
      // Drawn in the context sheet because it is the same thing - a list of
      // labelled commands anchored to a point - and a second sheet for it would
      // be a second set of keyboard handling and a second stylesheet to keep in
      // step with this one.
      case 'bookmarks-overflow': {
        if (!bookmarks) break;
        const wanted = Array.isArray(payload?.ids) ? payload.ids.slice(0, 200) : [];
        const byId = new Map(bookmarks.all().map((b) => [b.id, b]));
        const items = wanted
          .map((id) => byId.get(String(id)))
          .filter(Boolean)
          .map((b) => ({
            id: 'new-tab',
            label: b.title || b.url,
            payload: { url: b.url },
            icon: 'star'
          }));
        if (!items.length) break;

        context.model = { items, params: {} };
        const x = Math.round(Number(payload?.x) || 0);
        const y = Math.round(Number(payload?.y) || 0);
        shell.openSheet('context', { x, y, right: Math.round(Number(payload?.right) || x) });
        break;
      }

      // The pointer reached the window's left edge, or left the strip. Only
      // the chrome can tell us: it is the view the pointer enters and leaves.
      case 'sidebar-hover':
        shell.setSidebarOpen(Boolean(payload?.over));
        break;
      case 'sidebar-typing':
        shell.sidebarTyping = Boolean(payload?.typing);
        shell.releaseSidebar();
        break;

      // The pin at the bottom of the strip.
      case 'toggle-sidebar-pin':
        // Pinning a detached strip puts it back beside the page, held open.
        if (prefs.get('sidebarDetached') === true) {
          prefs.set('sidebarDetached', false);
          prefs.set('sidebarPinned', true);
        } else {
          prefs.set('sidebarPinned', !shell.sidebarPinned());
        }
        shell.applyWindowPrefs();
        publish();
        break;

      // Detach: the page takes the whole window and the strip floats over it
      // when the pointer reaches the left edge. Pinning undoes it, since a
      // strip held open is a column again.
      case 'toggle-sidebar-detach': {
        const detach = prefs.get('sidebarDetached') !== true;
        prefs.set('sidebarDetached', detach);
        if (detach) prefs.set('sidebarPinned', false);
        shell.applyWindowPrefs();
        publish();
        break;
      }

      // Ctrl+Shift+B. Through the preference rather than a flag in the chrome,
      // because showing the bar takes 34px from the page - the window has to
      // lay out again, and the choice has to survive a restart.
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

      // Dropped somewhere else in the strip. The index is where the strip drew
      // it; `move` clamps it.
      case 'move-tab':
        tabs.move(Number(payload?.id), Number(payload?.index));
        break;

      case 'pin-tab': {
        const tab = tabs.byId(payload?.id);
        if (tab) tabs.setPinned(tab.id, !tab.pinned);
        break;
      }

      // Silence a tab without hunting for the thing making the noise, which is
      // the reason anyone reaches for this: an autoplaying video three tabs
      // over, in a page you have not scrolled to yet.
      case 'mute-tab': {
        const tab = tabs.byId(payload?.id);
        if (tab) tab.setMuted(!tab.muted);
        break;
      }

      // The same page again, beside the one it came from. Copying the address
      // rather than the history: a duplicate is a second copy of where you are,
      // and carrying the back stack over would make the two share a past they
      // did not share.
      case 'duplicate-tab': {
        const tab = tabs.byId(payload?.id);
        if (!tab || !tab.url) break;
        const at = tabs.all().indexOf(tab);
        tabs.create({ url: tab.url, activate: true, index: at + 1, opener: tab });
        break;
      }

      /*
       * Close everything but this one, or everything after it.
       *
       * Closed oldest-last, because `close` mutates the list this is walking -
       * taking a copy first and going backwards is what stops the third tab
       * being skipped when the second one goes. Pinned tabs are left alone,
       * which is what pinning is for.
       */
      case 'close-other-tabs':
      case 'close-tabs-right': {
        const tab = tabs.byId(payload?.id);
        if (!tab) break;
        const all = tabs.all();
        const from = all.indexOf(tab);
        const doomed = all.filter((t, i) => t !== tab && !t.pinned &&
          (command === 'close-other-tabs' || i > from));
        for (const other of doomed.reverse()) tabs.close(other.id);
        if (tabs.all().length === 0) lastTabClosed();
        break;
      }

      case 'set-budget': {
        // Through the preference, like Settings' budget field. Writing
        // `cfg` directly was undone by the next `applyPrefs` and forgotten at
        // restart. Clamped to the range the preference accepts, so a value
        // just outside it is honoured as near as allowed rather than dropped.
        const mb = Number(payload?.mb);
        if (!Number.isFinite(mb)) break;
        const clamped = Math.min(BUDGET_MB.max, Math.max(BUDGET_MB.min, Math.round(mb)));
        // A `--budget` on the command line outranks the preference, so saving
        // one would change nothing this run; the slider then adjusts the run
        // itself, as it always did, and leaves the saved value alone.
        if (cfg.pinned?.memoryBudgetMB) { cfg.memoryBudgetMB = clamped; break; }
        if (!prefs.set('memoryBudgetMB', clamped)) break;
        applyPrefs(cfg, prefs, log);
        break;
      }

      default:
        break;
    }

    if (!UNPUBLISHED.has(command)) publish();
  };

  ipcMain.on('debrowser:command', (event, command, payload) => {
    if (!pageMay(senderPage(tabs, shell, event.sender), 'commands', command)) return;
    runCommand(command, payload ?? null, event.sender);
  });

  /*
   * Ctrl and the wheel, from any page.
   *
   * Chromium does not zoom an embedded view on this gesture and does not raise
   * `zoom-changed` for it either - measured - so the page probe notices it and
   * this applies it. Resolved to the tab that *sent* it rather than to the
   * active one: the pointer is over the page it is zooming, which is the tab
   * the event came from, and on a window with a docked inspector those are not
   * always the same.
   *
   * No privilege is involved - a page asking to zoom itself is a page changing
   * its own scale - so this needs no sender check beyond being a tab we own.
   */
  ipcMain.on('debrowser:zoom-gesture', (event, payload) => {
    const tab = tabs.all().find((t) => t.isLive && t.wc.id === event.sender.id);
    if (!tab) return;
    stepZoom(tab, payload?.direction === 'out' ? -1 : +1, siteZoom);
    publish();
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

/**
 * What each of our pages other than Settings may command, gated like the
 * request channel below and for the same reason: the new tab page is one
 * navigation away from being a website, and with the whole command surface it
 * could `set-pref` a homepage or `set-budget` the governor. Each list is
 * exactly what that page's script sends, plus the two every page's bridge
 * sends on its own - `page-dirty` from theme.js and `zoom` from the preload's
 * Ctrl+wheel handler.
 */
const PAGE_COMMON_COMMANDS = ['page-dirty', 'zoom'];

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
/**
 * What a private window does not offer at all.
 *
 * Everything here either writes to a profile - a password, a payment card, a
 * bookmark, a history entry - or reaches outside the private connection on its
 * own: the update check, the Windows Hello probe, loading a tab because the
 * pointer rested on it. Refused at the dispatcher, so a keyboard shortcut, a
 * menu item and a page's request all meet the same wall. A command that is not
 * there cannot be abused, whatever the sender.
 */
const INCOGNITO_REFUSED = new Set([
  'list-credentials', 'delete-credential', 'reveal-credential', 'save-payment', 'fill-payment',
  'vault-status', 'vault-unlock', 'vault-lock', 'vault-set', 'vault-remove', 'open-passwords',
  'list-history', 'delete-history', 'clear-history', 'forget-site',
  'toggle-bookmark', 'remove-bookmark', 'forget-bookmark', 'bookmark-page', 'bookmark-profiles',
  'import-from-profile', 'import-bookmark-file',
  'check-for-updates', 'update-restart', 'presence-capability',
  'prefetch-tab', 'prefetch-new-tab'
]);

const CHROME_REQUESTS = new Set([
  'list-bookmarks', 'toggle-bookmark', 'remove-bookmark',
  // The address bar's list: open tabs, bookmarks and history matching what is
  // typed - the user's own, shown to the user, in the bar they are typing into.
  'suggest',
  // The site panel: the active tab's connection, permissions and zoom.
  'site-info',
  // The keyboard shortcut sheet: labels and keys, nothing of the user's.
  'shortcut-list',
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
const NEWTAB_REQUESTS = new Set(['top-sites', 'forget-site', 'recent-pages', 'hide-continue-card']);

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
/** Files a private window opens in a tab of its own rather than another program. */
const OPENS_IN_BROWSER = /\.(pdf|png|jpe?g|gif|webp|avif|bmp|txt|md|json|csv|mp3|m4a|ogg|oga|opus|wav|flac|mp4|webm|ogv)$/i;

const DOWNLOAD_REQUESTS = new Set([
  'list-downloads', 'cancel-download', 'clear-download', 'reveal-download', 'open-download', 'safe-copy']);

/**
 * Who may send what, on both channels, in one table.
 *
 * Commands are open to the chrome and Settings, and to our other pages by list;
 * requests are stricter, since only the passwords page may touch credentials. Adding a
 * page is one row here. A Map, not an object: the key comes from a page's own
 * URL, and `constructor` must not find anything.
 */
const ANY = '*';
/** What only the passwords page may ask: unlocking, and the records. */
const VAULT_RECORD_REQUESTS = new Set([
  'vault-unlock', 'list-credentials', 'delete-credential', 'reveal-credential', 'save-payment', 'fill-payment'
]);
const PAGE_POLICY = new Map([
  ['chrome', { commands: ANY, requests: CHROME_REQUESTS }],
  // Settings may ask anything but the saved records themselves, which are the
  // passwords page's alone: it sets and removes the passcode, and that is all.
  ['settings', { commands: ANY, requests: { except: VAULT_RECORD_REQUESTS } }],
  // The passwords page: the lock, and the records behind it.
  ['passwords', {
    commands: new Set([...PAGE_COMMON_COMMANDS, 'open-settings', 'close-tab']),
    requests: new Set([...VAULT_RECORD_REQUESTS, 'vault-status', 'vault-lock', 'presence-capability'])
  }],
  ['newtab', {
    commands: new Set([...PAGE_COMMON_COMMANDS, 'navigate', 'new-tab', 'open-history']),
    requests: NEWTAB_REQUESTS
  }],
  ['history', {
    commands: new Set([...PAGE_COMMON_COMMANDS, 'navigate', 'new-tab', 'close-tab']),
    requests: HISTORY_REQUESTS
  }],
  ['downloads', {
    commands: new Set([...PAGE_COMMON_COMMANDS, 'close-tab']),
    requests: DOWNLOAD_REQUESTS
  }],
  // Incognito's connection page: try again, and nothing else. It moves on to a
  // new tab by navigating itself, which needs no command.
  ['tor', {
    commands: new Set([...PAGE_COMMON_COMMANDS, 'tor-retry']),
    requests: new Set()
  }],
  // The fingerprint self-check: it asks what a private window should report,
  // and nothing else.
  ['fingerprint', {
    commands: new Set(PAGE_COMMON_COMMANDS),
    requests: new Set(['fingerprint-expected'])
  }],
  // The plain-HTTP explanation: go back, or continue to that one host - and
  // `allow-http` is also checked against the sender where it is handled.
  ['insecure', {
    commands: new Set([...PAGE_COMMON_COMMANDS, 'allow-http', 'back']),
    requests: new Set()
  }]
]);

/** Whether a page - a `senderPage` answer - may send `name` on `channel`. */
function pageMay(page, channel, name) {
  const allowed = PAGE_POLICY.get(page)?.[channel];
  if (allowed && allowed.except) return !allowed.except.has(name);
  return allowed === ANY || Boolean(allowed?.has(name));
}

function wireRequests({ tabs, shell, credentials, vault = null, bookmarks, history, downloads, prefs, log,
                       sitePermissions = null, permissionAsks = null,
                       context = { model: null } }) {
  ipcMain.handle('debrowser:request', async (event, command, payload) => {
    // Stricter than the command channel: only the passwords page may touch credentials.
    const sender = senderPage(tabs, shell, event.sender);
    if (!pageMay(sender, 'requests', command)) return null;
    if (INCOGNITO && INCOGNITO_REFUSED.has(command)) return null;

    switch (command) {
      // Preferences ride along because the menu view is created on open and
      // destroyed on close: it never receives the state broadcast that carries
      // them to the other views, and a menu that ignored the chosen theme for
      // the life of its two seconds would be the most visible thing in the
      // browser that did.
      case 'menu-model':
        return { items: menuModel({ tabs, shell }), prefs: prefs.all() };

      // What a private window should report, for its self-check to compare.
      case 'fingerprint-expected':
        return INCOGNITO ? require('./incognito/fingerprint').expected() : null;

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
        return { items: topSites(history, bookmarks, Number(payload?.limit) || 8, prefs.get('hiddenTiles')) };

      // "Continue with these tabs": the last pages visited that are not open
      // now, newest first. Nothing when the card is off, and nothing in a
      // private window, which has no history to give.
      case 'recent-pages': {
        if (!history || !prefs.get('continueCard')) return { items: [] };
        const open = new Set(tabs.all().map((t) => t.url));
        const limit = Math.min(Math.max(Number(payload?.limit) || 4, 1), 12);
        const items = [];
        for (const e of history.entries()) {
          if (!/^https?:/i.test(e.url) || open.has(e.url)) continue;
          items.push({ url: e.url, title: e.title || '', visitedAt: e.visitedAt, icon: e.icon || null });
          if (items.length >= limit) break;
        }
        return { items };
      }

      case 'hide-continue-card':
        // Settings hears of it on the next state broadcast, like any change.
        prefs.set('continueCard', false);
        return true;

      // Removing a tile removes the site from history, which is the only
      // honest thing it can mean - a tile that came back tomorrow because the
      // visit was still recorded would be a button that does nothing.
      case 'forget-site': {
        const url = String(payload?.url || '');
        let origin = null;
        try { origin = new URL(url).origin; } catch { /* not a site */ }
        if (origin && origin !== 'null') {
          const hidden = prefs.get('hiddenTiles').filter((o) => o !== origin);
          prefs.set('hiddenTiles', [origin, ...hidden].slice(0, 200));
        }
        return { removed: history ? history.forgetSite(url) : 0 };
      }

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

      // Hidden tiles go with it: that list is a list of sites visited too.
      case 'clear-history':
        prefs.set('hiddenTiles', []);
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
      // Incognito: a flat copy of a downloaded PDF, made of pictures of its
      // pages - no scripts, forms, links or metadata. See incognito/sanitise.js.
      case 'safe-copy': {
        if (!INCOGNITO) return { ok: false };
        const file = downloads && downloads.pathOf(String(payload?.id ?? ''));
        if (!file || !/\.pdf$/i.test(file)) return { ok: false, reason: 'not a PDF' };
        const sanitise = require('./incognito/sanitise');
        try {
          const out = sanitise.safeCopyName(file);
          const pages = await sanitise.flattenPdf(require('electron'), file, out, log);
          return { ok: true, pages, name: path.basename(out) };
        } catch (err) {
          log('sanitise', `safe copy failed: ${err.message}`);
          return { ok: false, reason: err.message };
        }
      }

      case 'open-download': {
        const file = downloads && downloads.pathOf(String(payload?.id ?? ''));
        if (!file) return { ok: false };
        if (INCOGNITO) {
          // Another program is outside the private window: if it goes online -
          // a document fetching its template or a remote image, a viewer
          // checking for updates - it goes directly, not through Tor, and
          // whoever it reaches sees this computer's address. So what the
          // browser can show itself opens in a private tab, and anything else
          // is opened only after saying that.
          if (OPENS_IN_BROWSER.test(file)) {
            tabs.create({ url: require('url').pathToFileURL(file).href });
            return { ok: true, inBrowser: true };
          }
          const { response } = await dialog.showMessageBox(shell.window, {
            type: 'warning',
            buttons: ['Cancel', 'Show in folder', 'Open anyway'],
            defaultId: 0,
            cancelId: 0,
            title: 'Open outside the private window?',
            message: `${path.basename(file)} would open in another program.`,
            detail: 'That program is not part of the private window. If it goes online – to fetch a template, an ' +
              'image or a font, or to check for updates – it does so directly, without Tor, and whoever it ' +
              'reaches sees your real address. Opening the file can be enough.'
          });
          if (response === 1) electronShell.showItemInFolder(file);
          if (response !== 2) return { ok: false, reason: 'not opened' };
        }
        const problem = await electronShell.openPath(file);
        return { ok: problem === '', reason: problem || null };
      }

      // Settings' "Check now".
      //
      // A request rather than a command because the page needs the answer: the
      // state broadcast will carry the eventual result, but the button has to
      // change the moment it is pressed. Inert under a test or a benchmark,
      // where no updater is constructed at all.
      //
      // `{ auto: true }` is the section scrolling into view rather than the
      // button, and is held to the preference and rate limit like any check
      // the browser starts on its own.
      case 'check-for-updates':
        return shell.updater ? shell.updater.checkNow(payload?.auto !== true)
          : { available: false, reason: 'updates are off in this build' };

      // What the address bar offers for what has been typed so far: drawn in
      // the list under it, and returned so the bar can complete inline and
      // move the highlight without asking again. See suggest.js.
      case 'suggest': {
        const text = String(payload?.text || '').slice(0, 500);
        const active = tabs.activeTab();
        const result = suggest({
          text,
          tabs: tabs.all().filter((t) => t !== active).map((t) => ({ id: t.id, title: t.title, url: t.url })),
          bookmarks: bookmarks ? bookmarks.all() : [],
          // Not `all()`, which copies ten thousand entries on every letter.
          history: history ? history.entries() : [],
          engine: prefs.engineName(),
          complete: payload?.complete !== false
        });
        shell.suggestItems = result.items;
        shell.suggestSelected = -1;
        preconnectLead(prefs, result.items[0]);
        const a = payload?.anchor || {};
        if (Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.width)) {
          shell.showSuggestions(result.items, a);
        }
        return result;
      }

      // What the site panel shows: always about the active tab, and the
      // question it is asking, if it is asking one.
      case 'site-info': {
        const active = tabs.activeTab();
        if (!active) return null;
        const origin = originOf(active.url);
        let host = '';
        try { host = new URL(active.url).hostname; } catch { /* not a URL */ }
        const ask = permissionAsks ? permissionAsks.current(active) : null;
        if (ask) permissionAsks.markShown(active);
        return {
          host,
          // Not on a page that failed: an https address whose handshake never
          // completed is not a secure connection.
          secure: /^https:/i.test(active.url) && !active.failed,
          website: Boolean(origin),
          incognito: INCOGNITO,
          ask,
          permissions: sitePermissions && origin ? sitePermissions.forOrigin(origin) : {},
          zoom: active.isLive ? Math.round(active.wc.getZoomFactor() * 100) : 100,
          zoomDefault: Math.round((Number(prefs.get('defaultZoom')) || 1) * 100)
        };
      }

      case 'shortcut-list':
        return { groups: shortcuts.sheet({ incognito: INCOGNITO }) };

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
        // Not the synchronous picker: it held the whole browser - every tab,
        // the chrome - until it closed, and without a parent it could open
        // behind the window it was freezing.
        const { canceled, filePaths: picked } = await dialog.showOpenDialog(shell.window, {
          title: 'Import bookmarks',
          properties: ['openFile'],
          filters: [
            { name: 'Bookmarks', extensions: ['html', 'htm', 'json'] },
            { name: 'All files', extensions: ['*'] }
          ]
        });
        if (canceled || !picked || !picked.length) return { ok: false, cancelled: true };
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
      /*
       * Saved sign-ins and cards, and the lock in front of them (vault.js).
       *
       * Everything that reads or changes a saved record needs the vault
       * unlocked, and using it keeps it unlocked; the page asks to unlock with
       * Windows Hello or Touch ID, or with the passcode. Only the passwords
       * page may ask any of this (PAGE_POLICY); Settings sets and removes the
       * passcode and nothing else.
       */
      case 'vault-status': {
        const cap = credentials.capability();
        return { ...vault.status(), available: cap.available, reason: cap.reason };
      }

      case 'vault-unlock': {
        if (payload?.method === 'presence') {
          if (!vault.configured()) return { ok: false };
          const allowed = await presence.verify(
            'Unlock saved passwords',
            shell && !shell.window.isDestroyed() ? shell.window : null);
          if (!allowed) return { ok: false, reason: 'The check was not completed.' };
          vault.unlockByPresence();
          return { ok: true };
        }
        return vault.unlockWithPasscode(payload?.passcode);
      }

      case 'vault-lock':
        vault.lock();
        return true;

      case 'vault-set':
        return vault.setPasscode(payload?.passcode, payload?.current ?? null);

      case 'vault-remove': {
        const result = await vault.removePasscode(payload?.current);
        // Everything saved goes with it; see vault.js.
        if (result.ok) log('credentials', `passcode removed; ${credentials.clear()} saved item(s) deleted`);
        return result;
      }

      case 'presence-capability':
        return presence.capability();

      case 'list-credentials':
      case 'delete-credential':
      case 'reveal-credential':
      case 'save-payment':
      case 'fill-payment': {
        if (!vault.unlocked()) return { locked: true };
        vault.touch();
        return credentialRequest(command, payload, { tabs, credentials, log });
      }

      default:
        return null;
    }
  });
}

/** The saved-record requests, once the vault is known to be unlocked. */
function credentialRequest(command, payload, { tabs, credentials, log }) {
  switch (command) {
    case 'list-credentials': {
      const cap = credentials.capability();
      return { ...credentials.list(), available: cap.available, reason: cap.reason };
    }
    case 'delete-credential':
      return credentials.remove(payload?.kind, payload?.id);
    // Deliberate, one at a time, and never logged.
    case 'reveal-credential': {
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
      // Into the page behind this one, not into the passwords page: the most
      // recently used tab that is actually a web page.
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

async function offerToSaveCredential({ tab, offer, credentials, vault = null, shell, log }) {
  // No passcode, no saved passwords: see vault.js.
  if (!vault || !vault.configured()) return;
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
function fillSavedLogin(tab, credentials, prefs, log, vault = null) {
  if (!credentials || !tab || tab.internal) return;
  // The feature is off until a passcode is set; see vault.js.
  if (!vault || !vault.configured()) return;
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
    //
    // After the activation, not before: a page left in the background may be
    // frozen, and navigating a stopped renderer is the same hazard as sending
    // it IPC. The activation is what thaws it.
    const section = hashOf(url);
    const reload = section && hashOf(existing.url) !== section;
    tabs.activate(existing.id).then(() => {
      if (reload && existing.isLive && !isStopped(existing.tier)) {
        existing.wc.loadURL(url).catch(() => {});
      }
    }).catch(() => {});
    return existing;
  }
  return tabs.create({ url });
}

/**
 * A tab opened from a link, by the page itself or from its context menu.
 *
 * Placed and focused as Settings says. "After the current tab" also skips the
 * tabs this opener already opened, so links opened in order read left to right.
 */
function openLinkTab(tabs, prefs, opener, url) {
  const foreground = prefs?.get('linkTabsInBackground') === false;
  let index = null;
  if (opener && prefs?.get('newTabPosition') === 'after-current') {
    const list = tabs.all();
    let at = list.indexOf(opener);
    if (at !== -1) {
      at += 1;
      while (at < list.length && list[at].openerId === opener.id) at += 1;
      index = at;
    }
  }
  const tab = tabs.create({ url, activate: foreground, realise: foreground, index, opener });
  if (opener) tab.openerId = opener.id;
  return tab;
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
 * The folder downloads are written to: the chosen one while it exists, else
 * the system's. Checked per download, since a removable drive comes and goes.
 */
async function downloadDir(prefs) {
  const chosen = prefs?.get('downloadDir');
  // Windows can fail to name the Downloads folder at all - "Failed to get
  // 'downloads' path" - when it has been deleted or redirected somewhere that
  // is gone; the leak test found it with a fresh profile. A browser that then
  // cannot download anything is worse than one that makes the folder, which
  // is what Chrome does too.
  let base;
  try {
    base = app.getPath('downloads');
  } catch {
    base = path.join(app.getPath('home'), 'Downloads');
    await fs.promises.mkdir(base, { recursive: true }).catch(() => {});
  }
  // Asynchronously: a sleeping drive or a stalled network mount can hold a
  // stat for seconds, and a synchronous one would hold the whole browser.
  if (chosen && !OFFLINE_MODE) {
    const stat = await fs.promises.stat(chosen).catch(() => null);
    if (stat && stat.isDirectory()) base = chosen;
  }
  if (!INCOGNITO) return base;
  // A private window's files go in a folder of their own: kept apart from
  // everything else downloaded, so they are easy to find and to delete in one
  // go, and readable by nobody else on the machine. A download is the one
  // thing a private window writes on purpose, so it is the user's to keep.
  const own = path.join(base, 'Private downloads');
  try {
    await fs.promises.mkdir(own, { recursive: true, mode: 0o700 });
    return own;
  } catch {
    return base;
  }
}

/**
 * A saved window rectangle, moved and shrunk to fit the display nearest it,
 * so a monitor unplugged since last time cannot leave the window off screen.
 */
function fitToDisplay(saved) {
  if (!saved) return null;
  try {
    const area = screen.getDisplayMatching(saved).workArea;
    const width = Math.min(saved.width, area.width);
    const height = Math.min(saved.height, area.height);
    return {
      x: Math.min(Math.max(saved.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(saved.y, area.y), area.y + area.height - height),
      width,
      height,
      maximized: saved.maximized
    };
  } catch {
    return null;
  }
}

/**
 * Where a new tab goes.
 *
 * The saved homepage, if there is one, otherwise the default - and never the
 * homepage under `--smoke-test` or `--bench-test`, which must not depend on
 * whatever the machine they run on has saved.
 */
/**
 * Open a connection to where Enter is about to go, while the rest of the
 * address is still being typed: DNS, TCP and TLS, which on a real network are
 * most of the first 100-300 ms of a page, are done by the time the key goes
 * down. Only a connection - no request, no cookie, nothing a site can log as a
 * visit - and only to somewhere the user has already been (an open tab, a
 * bookmark, history) or to their own search engine when Enter would search.
 * An address being typed for the first time is not guessed at. Never in a
 * private window; off with "Preload pages you point at".
 */
const preconnected = new Map();   // origin -> when, so each letter is not another connection
function preconnectLead(prefs, row) {
  if (INCOGNITO || !row || prefs.get('preloadPages') === false) return;
  // Tests make no connections outside the machine, a search engine's included.
  if (OFFLINE_MODE && row.kind === 'search') return;
  let target = null;
  if (row.kind === 'search') target = prefs.searchTemplate();
  else if (row.kind === 'tab' || row.kind === 'bookmark' || row.kind === 'history') target = row.url;
  let origin;
  try { origin = new URL(String(target || '').replace('%s', '')).origin; } catch { return; }
  if (!/^https?:/.test(origin)) return;
  const now = Date.now();
  if (now - (preconnected.get(origin) || 0) < 10_000) return;
  preconnected.set(origin, now);
  if (preconnected.size > 64) preconnected.delete(preconnected.keys().next().value);
  try {
    session.fromPartition(BROWSING_PARTITION).preconnect({ url: origin, numSockets: 1 });
  } catch { /* the session is gone at quit */ }
}

/**
 * Settles once the tab has loaded and drawn - or after three seconds, for a
 * tab that never realises (a restored one) or never finishes. What waits on it
 * should not be kept waiting by a slow site.
 */
function firstTabLoaded(tab) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    const done = () => { clearTimeout(timer); setTimeout(resolve, 100); };
    if (tab && tab.wc && !tab.wc.isDestroyed()) tab.wc.once('did-finish-load', done);
  });
}

function newTabUrl(prefs) {
  // The speed test times the real new tab page; the rest stay on a file.
  if (SPEED_TEST) return pages.NEW_TAB_URL;
  if (OFFLINE_MODE) return HOME_URL;
  const home = prefs?.get('homepage');
  return (home && normaliseUrl(home)) || HOME_URL;
}

/* ------------------------------------------------------------------ */
/* The three-dot menu                                                  */
/* ------------------------------------------------------------------ */


function stepZoom(tab, direction, siteZoom) {
  if (!tab?.isLive) return;
  const current = tab.wc.getZoomFactor();
  // Nearest step to where we are, then move one along. Reading the factor back
  // rather than tracking an index keeps this correct after a ctrl+scroll, which
  // sets a factor this list does not contain.
  const nearest = ZOOM_STEPS.reduce(
    (best, f) => (Math.abs(f - current) < Math.abs(best - current) ? f : best), 1);
  const index = ZOOM_STEPS.indexOf(nearest) + direction;
  if (index < 0 || index >= ZOOM_STEPS.length) return;
  siteZoom.choose(tab.wc, ZOOM_STEPS[index]);
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
    // Not offered from inside incognito: a second one is just another tab there.
    ...(INCOGNITO ? [
      { id: 'new-circuit', label: 'New circuit for this tab', accel: accel('new-circuit'), icon: 'reload' },
      { id: 'new-identity', label: 'New identity', accel: accel('new-identity'), icon: 'shield' },
      { id: 'panic', label: 'Close and erase now', accel: accel('panic'), icon: 'close' }
    ] : [{
      id: 'new-incognito-window', label: 'New private window',
      accel: accel('new-incognito-window'), icon: 'shield'
    }]),
    { kind: 'separator' },
    { id: 'open-bookmarks', label: 'Bookmarks', accel: accel('open-bookmarks'), icon: 'star' },
    { id: 'open-history', label: 'History', accel: accel('open-history'), icon: 'clock' },
    { id: 'open-downloads', label: 'Downloads', accel: accel('open-downloads'), icon: 'download' },
    // Not in a private window, which has no saved passwords to show.
    ...(INCOGNITO ? [] : [{ id: 'open-passwords', label: 'Passwords', icon: 'key' }]),
    { kind: 'separator' },
    { kind: 'zoom', label: 'Zoom', value: zoom, enabled: live,
      // The ends of the ladder, so − and + can say when there is no further.
      min: Math.round(ZOOM_STEPS[0] * 100), max: Math.round(ZOOM_STEPS[ZOOM_STEPS.length - 1] * 100) },
    {
      id: 'toggle-fullscreen',
      label: 'Full screen',
      accel: accel('toggle-fullscreen'),
      icon: 'expand',
      kind: 'checkbox',
      checked: full
    },
    { id: 'save-page', label: 'Save page as\u2026', accel: accel('save-page'), icon: 'download',
      enabled: live && !tabs.activeTab()?.internal },
    { id: 'print', label: 'Print\u2026', accel: accel('print'), icon: 'print',
      enabled: live && !tabs.activeTab()?.internal },
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
    { id: 'show-shortcuts', label: 'Keyboard shortcuts', accel: accel('show-shortcuts'), icon: 'keyboard' },
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
/**
 * Give a site back its new tab tile, if it was taken away.
 *
 * The hidden list exists only so a forgotten site is not filled back in from
 * the bookmarks. Visiting or bookmarking the site again means the user wants
 * it, and keeping its origin there after that would be a second record of
 * where they go, kept after history is cleared.
 */
function unhideTile(prefs, url) {
  if (!prefs) return;
  let origin;
  try { origin = new URL(url).origin; } catch { return; }
  const hidden = prefs.get('hiddenTiles');
  if (hidden.includes(origin)) prefs.set('hiddenTiles', hidden.filter((o) => o !== origin));
}

function topSites(history, bookmarks, limit = 8, hidden = []) {
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

  const have = new Set([...items.map((item) => item.origin), ...hidden]);
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

  // See address.js: one rule, shared with the suggestion list.
  const kind = classifyAddress(text);
  if (kind === 'url') return text;
  if (kind === 'local') return `http://${text}`;
  if (kind === 'host') return `https://${text}`;

  return searchTemplate.replace('%s', encodeURIComponent(text));
}

/* ------------------------------------------------------------------ */
/* Smoke test - exercises the full lifecycle headlessly                */
/* ------------------------------------------------------------------ */

function runSmokeTest({ tabs, governor, shell, prefs, bookmarks, runCommand, history, context, credentials, vault }) {
  const { runSmoke } = require('./smoke');
  runSmoke({ tabs, governor, shell, app, cfg, prefs, menuModel, toggleDevTools, openInternalPage, bookmarks,
            senderPage: (t, sender) => senderPage(t, shell, sender),
            // The command dispatcher itself, so the suite exercises find and
            // the context menu the way a keystroke does rather than by calling
            // into their parts.
            runCommand: (command, payload) => runCommand(command, payload),
            history, context, credentials, vault }).then((code) => {
    app.exit(code);
  }).catch((err) => {
    console.error('[smoke] failed:', err.stack || err.message);
    app.exit(1);
  });
}

module.exports = { normaliseUrl, menuModel, openInternalPage, senderPage };
