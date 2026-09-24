'use strict';

/**
 * What a private window tells sites about the machine it runs on.
 *
 * Tor hides the address; everything a page can read from inside the browser
 * is a second way to recognise the same person across sites and sessions.
 * This makes the readable surfaces say one of a few common things, the same
 * way on every surface a site can read them from.
 *
 * Measured first (docs/MEASUREMENTS.md, "Incognito, M6"), because the
 * mechanisms reach different places:
 *
 *   - `app.userAgentFallback` is what shared and service workers report;
 *     `session.setUserAgent` alone reaches only pages and dedicated workers.
 *     Both are set, to the same string.
 *   - Client-hint brands cannot be changed for shared or service workers. So
 *     the user agent says what the engine really is - Chrome, this major
 *     version, this OS - with the `Electron/…` and app tokens removed, rather
 *     than claiming to be Google Chrome on a page while its service worker
 *     says Chromium. A claim that contradicts itself is worse than none.
 *   - The DevTools protocol's timezone, locale and core-count overrides reach
 *     the page and its dedicated workers, and - the timezone being the
 *     renderer's - the shared and service workers that run beside them.
 *   - The screen is reported as the letterboxed page size (see `letterbox`),
 *     as Tor Browser does, so a window's size says less than the monitor's.
 *
 * Fails closed. A tab loads nothing until its overrides are confirmed, and if
 * the debugger session carrying them is taken away and cannot be restored,
 * the tab stops and says why instead of carrying on without them.
 */

/** The values every private window reports. */
/**
 * `languages` differs by OS because the mechanism does, and cannot be made
 * the same: Linux and macOS build the list from the locale variables, which
 * give Chrome's own `en-US,en`; Windows takes it from `--lang` alone, which
 * gives `en-US` (measured on the CI runner). The user agent already says which
 * OS this is, so what matters is that every private window on one OS says the
 * same - and the Accept-Language header is set to match.
 */
const PROFILE = Object.freeze({
  timezone: 'UTC',
  locale: 'en-US',
  languages: process.platform === 'win32' ? 'en-US' : 'en-US,en',
  cores: 4
});

/** Letterbox steps: the page is sized down to a multiple of these. */
const STEP_W = 200;
const STEP_H = 100;

/** Chrome's own reduced user-agent string for this OS and engine version. */
function userAgent(platform = process.platform, chrome = process.versions.chrome) {
  const major = String(chrome).split('.')[0];
  const os = platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * The page's rectangle, shrunk to whole steps and centred in the space it was
 * given. A window 1283 wide shows a page 1200 wide; resizing it by a few pixels
 * changes nothing a site can read. Space smaller than one step is left alone.
 */
function letterbox(rect) {
  const width = rect.width >= STEP_W ? Math.floor(rect.width / STEP_W) * STEP_W : rect.width;
  const height = rect.height >= STEP_H ? Math.floor(rect.height / STEP_H) * STEP_H : rect.height;
  return {
    x: rect.x + Math.floor((rect.width - width) / 2),
    y: rect.y + Math.floor((rect.height - height) / 2),
    width,
    height
  };
}

/** Process-wide: before any session exists. */
function prepareApp(app) {
  app.userAgentFallback = userAgent();
}

/** Per session: the user agent and Accept-Language every request carries. */
function configureSession(ses) {
  ses.setUserAgent(userAgent(), PROFILE.languages);
}

/**
 * Other protections that ride on the same debugger session - the upload
 * sanitiser's file-picker interception - and so have to be put back with the
 * overrides whenever it is replaced. Each resolves false when it could not be.
 */
const coverHooks = [];
function onCovered(fn) {
  coverHooks.push(fn);
}

/** Tabs whose overrides are owed on every re-attach, and the screen each reports. */
const screens = new WeakMap();
const watched = new WeakSet();
const released = new WeakSet();

/**
 * Apply every override to a tab's page. Resolves true only when each one was
 * accepted - a single refusal is a failure, because a tab with its timezone
 * hidden and its screen showing is not a tab that is covered.
 */
async function apply(tab) {
  const cdp = tab.cdp;
  if (!cdp || !tab.wc || tab.wc.isDestroyed()) return false;
  const screen = screens.get(tab.wc) || { width: 0, height: 0 };
  const results = await Promise.all([
    cdp.send('Emulation.setTimezoneOverride', { timezoneId: PROFILE.timezone }),
    cdp.send('Emulation.setLocaleOverride', { locale: PROFILE.locale }),
    cdp.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: PROFILE.cores }),
    screenOverride(cdp, screen),
    ...coverHooks.map((fn) => Promise.resolve(fn(tab)).then((ok) => (ok === false ? null : true), () => null))
  ]);
  return results.every((r) => r !== null);
}

/**
 * The screen as the page's own letterboxed size. `width: 0, height: 0` leaves
 * the viewport alone - only what `screen.*` reports changes.
 */
function screenOverride(cdp, { width, height }) {
  if (!width || !height) return Promise.resolve({});
  return cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 0, height: 0, deviceScaleFactor: 0, mobile: false,
    screenWidth: width, screenHeight: height
  });
}

/** Stop the tab and say why. A page with no overrides does not get to run. */
function block(tab, why) {
  if (!tab.wc || tab.wc.isDestroyed()) return;
  tab.wc.stop();
  const html = '<!doctype html><meta charset="utf-8"><title>Stopped</title>' +
    '<body style="font:15px system-ui;margin:3em;max-width:36em;color:#ddd;background:#1b1b19">' +
    '<h1 style="font-size:20px">This tab was stopped</h1>' +
    `<p>${why}</p><p>Nothing more loads in it. Close it and open a new tab.</p>`;
  tab.wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
}

/**
 * Cover a freshly realised tab, then run `load`. The overrides go on a blank
 * page first: attached to a view that has never navigated, the target is
 * swapped out from under the debugger (measured in M0). If the debugger is
 * later taken away - the user's DevTools can do it - the overrides are put
 * back at once, and the tab is stopped if they cannot be.
 */
async function shield(tab, load) {
  const wc = tab.wc;
  await wc.loadURL('about:blank').catch(() => {});
  if (!(await apply(tab))) {
    block(tab, 'Its protection against being recognised could not be switched on, so it did not load the page.');
    return false;
  }
  if (!watched.has(wc)) {
    watched.add(wc);
    wc.debugger.on('detach', () => {
      if (released.has(wc) || wc.isDestroyed()) return;
      apply(tab).then((ok) => {
        if (!ok) block(tab, 'Its protection against being recognised was switched off, and could not be switched back on.');
      });
    });
  }
  load();
  return true;
}

/** The tab is going away on purpose: its debugger detaching is not an attack. */
function release(wc) {
  if (wc) released.add(wc);
}

/** The page was resized; the screen it reports follows. */
function setScreen(tab, { width, height }) {
  if (!tab.wc || tab.wc.isDestroyed()) return;
  const last = screens.get(tab.wc);
  if (last && last.width === width && last.height === height) return;
  screens.set(tab.wc, { width, height });
  if (tab.cdp && tab.cdp.attached) screenOverride(tab.cdp, { width, height });
}

/**
 * The browser's language, fixed rather than taken from the OS. Electron builds
 * `navigator.languages` from the locale variables, not from `--lang`: with the
 * OS in German it said "de" whatever the switch said. These four give exactly
 * Chrome's own default, `en-US,en` - measured; LANGUAGE unset gave
 * "en-US,en,en", a list no real browser sends. Linux and macOS only: Windows
 * takes its languages from the OS, which `--lang` covers, and the self-audit
 * checks.
 */
function prepareEnvironment(env = process.env) {
  env.LANG = 'en_US.UTF-8';
  env.LC_ALL = 'en_US.UTF-8';
  env.LC_MESSAGES = 'en_US.UTF-8';
  env.LANGUAGE = 'en_US';
}

/**
 * The command-line half. `use-webgpu-adapter=swiftshader` points WebGPU at the
 * software adapter, which this Chromium refuses without an unsafe flag - so
 * no adapter at all, and nothing about the graphics card to read, while the
 * page itself still draws on the GPU. There is no switch that removes WebGPU
 * outright (the binary has none). This machine has no GPU to prove it on, so
 * the self-audit asks for an adapter on the user's machine and says so if it
 * gets one.
 */
function switches() {
  return [['lang', PROFILE.locale], ['use-webgpu-adapter', 'swiftshader']];
}

/** What the self-check compares against: what a private window should say. */
function expected() {
  return {
    userAgent: userAgent(),
    major: String(process.versions.chrome).split('.')[0],
    timezone: PROFILE.timezone,
    locale: PROFILE.locale,
    languages: PROFILE.languages,
    // A shared worker reports only the app's locale, not the language list:
    // Electron's, not Chrome's, behaviour - measured, and not changeable (the
    // DevTools protocol's override wipes the client-hint brands and still
    // misses the dedicated worker). The same in every private window, so it
    // tells a site nothing about which one.
    sharedWorkerLanguages: PROFILE.locale,
    cores: PROFILE.cores
  };
}

/**
 * Run the self-check once, in a view nobody sees, on a private session of its
 * own, covered the way a tab is. Resolves to `{checks, problems}`, or to
 * `{error}` when the check itself could not run - which is reported, not
 * treated as a pass.
 */
async function audit(ses, pageUrl, log = () => {}) {
  const { WebContentsView } = require('electron');
  const { CdpSession } = require('../cdp');
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, webgl: false } });
  const wc = view.webContents;
  const tab = { wc, cdp: new CdpSession(wc, log) };
  const size = { width: 1200, height: 700 };
  view.setBounds({ x: 0, y: 0, ...size });
  setScreen(tab, size);
  try {
    const url = `${pageUrl}#${encodeURIComponent(JSON.stringify(expected()))}`;
    if (!(await shield(tab, () => wc.loadURL(url).catch(() => {})))) return { error: 'the overrides could not be applied' };
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const result = await wc.executeJavaScript('window.__audit || null').catch(() => null);
      if (result) return result;
    }
    return { error: 'the check did not finish' };
  } finally {
    release(wc);
    tab.cdp.detach();
    if (!wc.isDestroyed()) wc.close();
  }
}

module.exports = {
  PROFILE, STEP_W, STEP_H, userAgent, letterbox, prepareApp, prepareEnvironment, configureSession,
  apply, shield, block, release, setScreen, switches, expected, audit, onCovered
};
