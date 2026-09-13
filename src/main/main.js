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

const { app, ipcMain, session } = require('electron');
const { loadConfig } = require('./config');
const platform = require('./platform');
const { TabManager } = require('./tabs/tab-manager');
const { BrowserShell } = require('./window');
const { Governor } = require('./governor');
const { IpcHub } = require('./ipc');

const path = require('path');

const SMOKE_TEST = process.argv.includes('--smoke-test');
const OFFLINE_MODE = SMOKE_TEST || process.argv.includes('--bench-test');

// Tests and benchmarks must not depend on the network: they assert on memory
// behaviour, and a slow or blocked fetch would make them vary for reasons that
// have nothing to do with the governor.
const HOME_URL = OFFLINE_MODE
  ? `file://${path.join(__dirname, '..', '..', 'test', 'pages', 'idle.html')}`
  : 'https://example.com';

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

// When the user has not pinned a budget, size it to the machine rather than
// to a number chosen on someone else's hardware.
if (overrides.memoryBudgetMB == null && cfg.profile === 'balanced') {
  cfg.memoryBudgetMB = platform.recommendedBudgetMB();
}

function log(...args) {
  if (VERBOSE) console.log('[debrowser]', ...args);
}

/* ------------------------------------------------------------------ */
/* Chromium switches - must be applied before `app` is ready           */
/* ------------------------------------------------------------------ */

for (const [name, value] of platform.chromiumSwitches(cfg)) {
  if (value === undefined) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, value);
}

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

  const onTabEvent = (tab, event, payload) => {
    switch (event) {
      case 'realised':
        if (shell) shell.attachTab(tab);
        break;
      case 'activated':
        if (shell) shell.attachTab(tab);
        break;
      case 'open-tab':
        if (tabs && payload?.url) tabs.create({ url: payload.url, activate: false, realise: false });
        break;
      case 'closed':
        if (shell) shell.detachTab(tab);
        break;
      default:
        break;
    }
    publish();
  };

  app.whenReady().then(() => {
    log('system', JSON.stringify(platform.systemInfo()));
    log('config', `profile=${cfg.profile} budget=${cfg.memoryBudgetMB}MB`);

    tabs = new TabManager({
      onEvent: onTabEvent,
      log,
      // Awaited before a tab is shown, so it is never presented while frozen.
      onPresent: async (tab) => {
        if (shell) shell.attachTab(tab);
        if (governor) await governor.onTabActivated(tab);
      }
    });
    const ipcHub = new IpcHub(() => tabs.all(), log);

    shell = new BrowserShell({
      tabManager: tabs,
      log,
      onCommand: (name) => { if (name === 'chrome-ready') publish(); }
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

    wireCommands({ tabs, shell, governor, publish, log });

    tabs.create({ url: HOME_URL });
    shell.layout();

    if (SMOKE_TEST) {
      runSmokeTest({ tabs, governor, shell });
    } else if (argv.includes('--bench-test')) {
      const { runBench } = require('./bench');
      const tabCount = Number(argValue('tabs')) || 8;
      const settleMs = Number(argValue('settle')) || 8000;
      const coldMs = Number(argValue('cold')) || undefined;
      const freezeMs = Number(argValue('freeze')) || undefined;
      runBench({ tabs, governor, app, cfg, tabCount, settleMs, coldMs, freezeMs })
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
    if (governor) governor.stop();
    if (tabs) tabs.closeAll();
  });

  // Pages must never be able to open a renderer with elevated privileges.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

/* ------------------------------------------------------------------ */
/* Commands from the browser chrome                                    */
/* ------------------------------------------------------------------ */

function wireCommands({ tabs, shell, governor, publish, log }) {
  ipcMain.on('debrowser:command', (event, command, payload) => {
    // Only our own chrome may issue commands. A page that somehow reached this
    // channel is ignored: chrome renderers have no tab backing them.
    const isChrome = !tabs.all().some((t) => t.wc && !t.wc.isDestroyed() && t.wc.id === event.sender.id);
    if (!isChrome) return;

    const active = tabs.activeTab();

    switch (command) {
      case 'new-tab':
        tabs.create({ url: payload?.url || HOME_URL });
        break;

      case 'close-tab':
        tabs.close(payload?.id ?? tabs.activeId);
        break;

      case 'activate-tab':
        tabs.activate(payload?.id).then(publish).catch((e) => log(`activate failed: ${e.message}`));
        break;

      case 'navigate': {
        const target = normaliseUrl(payload?.url);
        if (!target) break;
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

      case 'toggle-panel':
        shell.togglePanel();
        publish();
        break;

      case 'discard-tab': {
        // Manual discard from the task manager. Goes through the same tier
        // machinery as an automatic one, protections included.
        const tab = tabs.byId(payload?.id);
        if (tab && !tab.visible) {
          governor.enforceManualDiscard(tab).catch((e) => log(`manual discard failed: ${e.message}`));
        }
        break;
      }

      case 'pin-tab': {
        const tab = tabs.byId(payload?.id);
        if (tab) tab.pinned = !tab.pinned;
        break;
      }

      case 'set-budget': {
        const mb = Number(payload?.mb);
        if (Number.isFinite(mb) && mb >= 256) {
          governor.cfg.memoryBudgetMB = Math.round(mb);
          log(`budget set to ${governor.cfg.memoryBudgetMB}MB`);
        }
        break;
      }

      default:
        break;
    }

    publish();
  });
}

/**
 * Turn omnibox input into a URL.
 *
 * Anything that parses as a URL or looks like a hostname is treated as one;
 * everything else is a search. This is the only place the browser decides
 * between the two, and it errs toward navigation so that typing a bare
 * hostname never silently becomes a search query.
 */
function normaliseUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^(about|data|blob|file):/i.test(text)) return text;

  const looksLikeHost = /^[^\s/?#]+\.[^\s/?#]{2,}([/?#]|$)/.test(text);
  if (looksLikeHost) return `https://${text}`;
  if (text === 'localhost' || text.startsWith('localhost:')) return `http://${text}`;

  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

/* ------------------------------------------------------------------ */
/* Smoke test - exercises the full lifecycle headlessly                */
/* ------------------------------------------------------------------ */

function runSmokeTest({ tabs, governor, shell }) {
  const { runSmoke } = require('./smoke');
  runSmoke({ tabs, governor, shell, app, cfg }).then((code) => {
    app.exit(code);
  }).catch((err) => {
    console.error('[smoke] failed:', err.stack || err.message);
    app.exit(1);
  });
}

module.exports = { normaliseUrl };
