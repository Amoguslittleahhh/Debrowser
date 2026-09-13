'use strict';

/**
 * Shared harness for the experiments in this directory.
 *
 * Each experiment is a small Electron app that isolates one variable and
 * prints a number. They exist because every interesting decision in the
 * governor came from one of them contradicting an assumption - so they are
 * kept runnable and re-runnable rather than summarised and thrown away.
 */

const path = require('path');
const { app, BaseWindow, WebContentsView } = require('electron');

const ROOT = path.join(__dirname, '..');
const PAGES = path.join(ROOT, 'test', 'pages');

/** URL for one of the repo's test fixture pages, e.g. pageUrl('heavy'). */
const pageUrl = (name) => `file://${path.join(PAGES, `${name.replace(/\.html$/, '')}.html`)}`;

const PROBE_PRELOAD = path.join(ROOT, 'src', 'preload', 'probe-preload.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read one argument, e.g. arg('mode', 'freeze'). */
function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

/** Resident memory of one process, in MB. */
function rss(pid) {
  const proc = app.getAppMetrics().find((p) => p.pid === pid);
  return proc ? Math.round(proc.memory.workingSetSize / 1024) : 0;
}

/** CPU percentage for one process. */
function cpu(pid) {
  const proc = app.getAppMetrics().find((p) => p.pid === pid);
  return proc?.cpu?.percentCPUUsage ?? 0;
}

/**
 * Read memory only after repeated sampling.
 *
 * A single `getAppMetrics` call catches whatever the allocator happens to be
 * doing at that instant. Every figure these experiments report is taken this
 * way, which is what makes a 3MB difference meaningful rather than noise.
 */
async function settledRss(pid, samples = 8, gapMs = 250) {
  let value = 0;
  for (let i = 0; i < samples; i++) {
    value = rss(pid);
    await sleep(gapMs);
  }
  return value;
}

/** Total resident memory across every process in this app. */
function totalRss() {
  return Math.round(
    app.getAppMetrics().reduce((sum, p) => sum + (p.memory?.workingSetSize || 0) / 1024, 0)
  );
}

/**
 * Create a window and load a page into a view, mirroring how the browser
 * itself hosts tabs (a BaseWindow with WebContentsViews, not a BrowserWindow).
 *
 * @param {object} opts
 * @param {boolean} opts.preload    - attach the real activity probe
 * @param {boolean} opts.show       - start the view visible
 * @param {boolean} opts.spellcheck - Electron's spellchecker (a per-WebContents
 *                                    option rather than a command-line switch,
 *                                    so experiment 08 varies it through here)
 */
async function openPage(win, url, { preload = false, show = true, spellcheck = true } = {}) {
  const webPreferences = {
    contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck
  };
  if (preload) webPreferences.preload = PROBE_PRELOAD;

  const view = new WebContentsView({ webPreferences });
  win.contentView.addChildView(view);
  const { width, height } = win.getContentBounds();
  view.setBounds({ x: 0, y: 0, width, height });

  const crashes = [];
  view.webContents.on('render-process-gone', (_e, details) => {
    crashes.push(details);
    console.log(`  CRASH ${url.split('/').pop()}: ${JSON.stringify(details)}`);
  });

  await view.webContents.loadURL(url);
  view.setVisible(show);
  return { view, wc: view.webContents, crashes };
}

/**
 * Send a CDP command with a hard ceiling on how long it may take.
 *
 * Necessary because these experiments deliberately provoke renderer crashes,
 * and a command sent to a dead renderer never settles - which would hang the
 * experiment at exactly the moment it had found its answer. Returns null on
 * timeout or error rather than throwing.
 */
async function cdpSend(wc, method, params = {}, timeoutMs = 2000) {
  if (!wc || wc.isDestroyed()) return null;
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([wc.debugger.sendCommand(method, params), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function makeWindow() {
  return new BaseWindow({ width: 900, height: 600, show: true });
}

/**
 * Run an experiment body, print a heading, and exit with a status the shell
 * can act on. Any throw is reported rather than left as an unhandled rejection.
 */
function run(title, body) {
  app.whenReady().then(async () => {
    console.log(`\n=== ${title} ===\n`);
    const code = (await body()) || 0;
    console.log('');
    app.exit(code);
  }).catch((err) => {
    console.error(`experiment failed: ${err.stack || err.message}`);
    app.exit(2);
  });
}

/** Format a signed delta for a results line. */
const delta = (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}`;

module.exports = {
  app, BaseWindow, WebContentsView,
  ROOT, PAGES, PROBE_PRELOAD,
  pageUrl, sleep, arg, rss, cpu, settledRss, totalRss,
  openPage, makeWindow, cdpSend, run, delta
};
