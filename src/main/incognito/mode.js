'use strict';

/**
 * Incognito: a second browser process that nothing on this machine or on the
 * network path can read back.
 *
 * Ordinary private modes protect you from someone else at your keyboard - no
 * history, no cookies kept - and nothing more. Every request still leaves in
 * the open, so the router and the ISP see every site by its DNS lookup, its TLS
 * server name and its address. This mode is the opposite threat model: the
 * network learns nothing, and the machine keeps nothing.
 *
 * It is a separate *process*, not a separate window, because the things that
 * make it safe are process-wide in Chromium - the proxy, the resolver rules,
 * V8's compiler flags - and because two processes share no memory. The normal
 * browser launches it with `--incognito` (see launch.js) and it runs this file
 * before anything else touches the profile directory.
 *
 * This file owns the parts that must be decided before `app` is ready:
 *
 *   - where the profile lives, and that nobody else can have prepared it
 *   - every switch that routes traffic, and the rule that there is no
 *     fallback: with the proxy down, requests fail rather than going direct
 *   - which of V8's compilers are allowed to run
 *
 * The rest of the browser asks `INCOGNITO` at each feature that would write to
 * disk or talk to the network on its own, and turns it off.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const INCOGNITO = process.argv.includes('--incognito');

const argValue = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};


/**
 * V8's compilers, by how much of them runs.
 *
 * Measured on Electron 44's V8 with `%GetOptimizationStatus` on a hot function
 * (see docs/MEASUREMENTS.md): full speed reaches TurboFan; balanced stops at
 * Sparkplug, the baseline compiler, and marks the function never-optimise;
 * maximum is the interpreter alone, V8's "lite mode". Most V8 exploits land in
 * the optimising tiers, which is why balanced removes exactly those.
 *
 * Turbolev is named as well as TurboFan: this V8 has it as an alternative top
 * tier, and a flag list that only named TurboFan would leave an optimising
 * compiler reachable the day it becomes the default. `--liftoff-only` rather
 * than `--no-wasm-tier-up`, because the latter interacts with dynamic tiering
 * in ways that are not obvious from its help text, and the former says exactly
 * what is meant: WebAssembly runs on its baseline compiler and nothing else.
 */
const JS_LEVELS = {
  maximum: ['--jitless'],
  balanced: ['--no-turbofan', '--no-turbolev', '--no-maglev', '--liftoff-only'],
  full: []
};
const DEFAULT_JS_LEVEL = 'balanced';

/** The resolver rule: every lookup fails, except of the loopback address itself. */
const RESOLVER_RULES = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';

/**
 * Nothing is bypassed. Chromium's implicit rule is that loopback never goes
 * through a proxy; `<-loopback>` removes it, so a page cannot reach services
 * on this machine by going around the proxy either.
 */
const BYPASS_RULES = '<-loopback>';

/** A port for Tor's SOCKS listener, away from the ranges other software favours. */
function pickPort() {
  return 30000 + require('crypto').randomInt(0, 29000);
}

/**
 * Move to another port, for when Tor could not bind the one picked.
 *
 * The command-line proxy cannot change after startup and keeps pointing at the
 * old port, where nothing now listens - so a context that only the command
 * line reaches fails closed rather than going direct. Every session this
 * process has seen is repointed.
 */
function movePort(ctx, sessions) {
  ctx.proxyPort = pickPort();
  ctx.proxyRules = `socks5://127.0.0.1:${ctx.proxyPort}`;
  for (const ses of sessions) configureSession(ses, ctx);
  return ctx.proxyPort;
}

/** Whether a directory is ours alone: a real directory, owned by us, closed to others. */
function isPrivateDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return false;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  // Windows and macOS give each user their own temp directory; the ownership
  // and mode checks below are about the shared /tmp that Linux has.
  if (process.platform === 'win32') return true;
  return st.uid === process.getuid() && (st.mode & 0o077) === 0;
}

/**
 * Where the incognito profile lives.
 *
 * On Linux, `$XDG_RUNTIME_DIR` when it is there: a per-user directory the
 * system creates in RAM at login and removes at logout, so nothing written in
 * it ever reaches a disk. Everywhere else, the per-user temp directory.
 */
function profileRoot() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (process.platform === 'linux' && runtime && isPrivateDir(runtime)) {
    return path.join(runtime, 'debrowser-incognito');
  }
  const who = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username;
  return path.join(os.tmpdir(), `debrowser-incognito-${who}`);
}

/**
 * Make the profile directory, or refuse to start.
 *
 * On a shared /tmp a directory with this name could have been made by someone
 * else first - a symlink to somewhere of theirs, or a directory they can read.
 * Either would put this user's browsing where another account can see it, so
 * anything that is not a private directory owned by us is a refusal, never a
 * repair.
 */
function ensureRoot(root) {
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  if (!isPrivateDir(root)) {
    throw new Error(`refusing to use ${root}: it is not a private directory owned by this user`);
  }
}

/**
 * Anything a previous incognito process left behind, removed.
 *
 * Called once this process holds the profile lock, so what is here is known to
 * belong to a process that is no longer running - a crash, a kill, a power
 * cut. Chromium's own lock files are left alone; the lock is what makes the
 * rest of this safe.
 */
function sweep(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (/^Singleton/.test(name) || name === 'lockfile') continue;
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    } catch { /* a file the OS still holds; the next start will get it */ }
  }
}

/** This run's files, gone. Best-effort: the reaper and sweep() catch the rest. */
function wipe(ctx) {
  try {
    fs.rmSync(ctx.sessionDir, { recursive: true, force: true });
  } catch { /* open files on Windows; the reaper gets them */ }
}

/**
 * Delete this run's files once this process has really ended.
 *
 * Nothing inside the process can do it: Chromium writes its shutdown state -
 * `Local State`, `Network Persistent State`, session storage - after Node's own
 * `exit` handler has run. The leak test found that directory still there after
 * every clean exit. So a tiny native process (net-watch in reaper mode) waits
 * for this one to be gone and then removes the directory; it also covers a
 * crash or a kill, which no in-process handler can.
 */
function startReaper(ctx, helperBinary, log = () => {}) {
  if (!fs.existsSync(helperBinary)) {
    log('incognito', `no reaper (${helperBinary} missing); this run's files are swept at the next start`);
    return false;
  }
  try {
    const { spawn } = require('child_process');
    const child = spawn(helperBinary, ['--reap', String(process.pid), ctx.sessionDir],
      { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (err) {
    log('incognito', `reaper did not start: ${err.message}`);
    return false;
  }
}

/** The JS level the user chose in the normal profile, or the default. Read, never written. */
function readJsLevel(normalUserData) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(normalUserData, 'preferences.json'), 'utf8'));
    if (raw && Object.hasOwn(JS_LEVELS, raw.incognitoJsLevel)) return raw.incognitoJsLevel;
  } catch { /* first run, or unreadable: the default */ }
  return DEFAULT_JS_LEVEL;
}

/**
 * Everything that has to happen before the profile lock is taken.
 *
 * Returns the context the rest of startup needs, or throws with a reason the
 * caller shows before exiting. Never half-applied: the profile path is only
 * switched once it is known to be safe.
 */
function prepare(app) {
  const normalUserData = app.getPath('userData');
  const root = profileRoot();
  ensureRoot(root);
  app.setPath('userData', root);
  // Per process, so the reaper below can delete this run's files without any
  // chance of deleting a newer incognito process's.
  const sessionDir = path.join(root, `s-${process.pid}`);
  app.setPath('sessionData', sessionDir);
  // Crash dumps are copies of process memory. Chromium's crash database is
  // created under the profile whether or not anything ever crashes - the leak
  // test found it left behind - so it goes where the reaper will take it.
  app.setPath('crashDumps', path.join(sessionDir, 'Crashpad'));

  // The environment's proxy settings are for the ordinary browser. Chromium
  // falls back to them for any context the command line does not cover, and
  // measured here, a session with no proxy of its own quietly used them - so a
  // leak test that allowed "any loopback address" would have passed traffic
  // that went to a proxy other than ours. They are removed so that cannot
  // happen, and the leak test allows exactly one port.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
                     'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    delete process.env[key];
  }
  // A second layer under the per-page timezone override: every process this
  // one starts, on the platforms that honour it, reports UTC.
  process.env.TZ = 'UTC';

  // The proxy is Tor, on a port picked here: it has to be on the command line
  // before the app is ready, which is before anything could ask the OS for a
  // free one. A collision is rare and handled - Tor reports it and main picks
  // again. The test suite supplies its own stand-in instead, on its own port.
  const requested = Number(argValue('incognito-proxy-port'));
  const external = Number.isInteger(requested) && requested > 0 && requested < 65536;
  const port = external ? requested : pickPort();

  return {
    root,
    sessionDir,
    normalUserData,
    /** A proxy supplied from outside (the leak test's stand-in), so no Tor is started. */
    externalProxy: external,
    proxyPort: port,
    proxyRules: `socks5://127.0.0.1:${port}`,
    jsLevel: readJsLevel(normalUserData)
  };
}

/**
 * The switches that route every request and decide the compilers.
 *
 * Returned rather than applied so `platform.chromiumSwitches` can merge them
 * with its own: Chromium keeps only the last `--js-flags`, so two separate
 * appends would silently drop one set.
 */
function switches(ctx) {
  return [
    ['proxy-server', ctx.proxyRules],
    ['proxy-bypass-list', BYPASS_RULES],
    ['host-resolver-rules', RESOLVER_RULES],
    ['disable-quic'],
    ['force-webrtc-ip-handling-policy', 'disable_non_proxied_udp']
  ];
}

/**
 * Per-session settings, applied to every session as it is created.
 *
 * The command line already covers every network context; this repeats the
 * proxy per session because a mechanism that everything depends on should not
 * be single. Spellcheck is off because a new session downloads its dictionary
 * on its own - measured, the very first request a fresh session makes is to
 * redirector.gvt1.com, before any page asks for anything. Through Tor it would
 * still be a request to Google that no page asked for, sent from every
 * incognito session, which is a fingerprint in itself.
 */
function configureSession(ses, ctx) {
  ses.setProxy({ proxyRules: ctx.proxyRules, proxyBypassRules: BYPASS_RULES }).catch(() => {});
  // `setSpellCheckerEnabled(false)` alone does not stop it - measured, the
  // download still went out. An empty language list does: there is then no
  // dictionary to fetch. Both, so the spellchecker is off as well as starved.
  try { ses.setSpellCheckerLanguages([]); } catch { /* macOS uses the system checker */ }
  try { ses.setSpellCheckerEnabled(false); } catch { /* not on this platform */ }
  // No local network, and HTTPS or an explanation. See policy.js.
  require('./policy').install(ses);
}

module.exports = {
  INCOGNITO, JS_LEVELS, DEFAULT_JS_LEVEL, RESOLVER_RULES, BYPASS_RULES,
  profileRoot, isPrivateDir, ensureRoot, sweep, wipe, startReaper, prepare, switches, configureSession,
  movePort
};
