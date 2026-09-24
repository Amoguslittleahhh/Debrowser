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

/**
 * Whether the operating system, not just this browser, keeps it off the
 * network - in the shape every capability here uses.
 *
 * Linux: the launcher put this process in a network namespace with nowhere to
 * go and says so in the environment; or tried and was refused, and says why.
 * Windows: the installer's firewall rule covers a copy of the executable with
 * its own name, and incognito runs as that copy. macOS: no per-app control
 * exists without root or a signed network extension, so the tripwire is what
 * there is.
 */
function killSwitch() {
  const said = process.env.DEBROWSER_KILL_SWITCH || '';
  if (said === 'namespace') {
    return { available: true, mechanism: 'network namespace (loopback only)', reason: null };
  }
  if (said.startsWith('unavailable:')) {
    const raw = said.slice('unavailable:'.length);
    const reason = raw.startsWith('unshare-')
      ? `this system does not allow programs to make their own network namespace (${raw.slice(8)})`
      : raw;
    return { available: false, mechanism: null, reason };
  }
  if (process.platform === 'win32') return windowsFirewall();
  if (process.platform === 'darwin') {
    return { available: false, mechanism: null, reason: 'macOS offers no per-app network control without root' };
  }
  return { available: false, mechanism: null, reason: 'not started through the kill-switch launcher' };
}

/**
 * Whether the installer's firewall rule is there and covers this executable.
 *
 * Asked of Windows rather than assumed from the executable's name: the rule
 * needed one UAC prompt at install, which can be refused, and a hard link
 * without its rule is just a second name for an unprotected program.
 */
function windowsFirewall() {
  const RULE = 'Debrowser private window';
  if (!/incognito/i.test(path.basename(process.execPath))) {
    return { available: false, mechanism: null, reason: 'not running as the firewalled executable (installed builds only)' };
  }
  // The firewall's own COM interface rather than `netsh`, whose output is
  // translated: on a German Windows "Enabled" is "Aktiviert", and a check that
  // parsed English labels would report every rule missing. Action 0 is block,
  // direction 2 is outbound.
  const { spawnSync } = require('child_process');
  const script = '(New-Object -ComObject HNetCfg.FwPolicy2).Rules | ' +
    `Where-Object { $_.Name -eq '${RULE}' } | ` +
    'Select-Object Enabled, Action, Direction, ApplicationName | ConvertTo-Json -Compress';
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  let rules = [];
  try {
    const parsed = JSON.parse(out.stdout || 'null');
    rules = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch { /* no rule, or PowerShell unavailable: reported as missing */ }
  const covers = rules.some((r) => r.Enabled === true && r.Action === 0 && r.Direction === 2 &&
    String(r.ApplicationName || '').toLowerCase() === process.execPath.toLowerCase());
  if (covers) return { available: true, mechanism: 'Windows Firewall rule for this executable', reason: null };
  return { available: false, mechanism: null, reason: 'the firewall rule is missing - reinstall and accept the prompt' };
}

/**
 * How many SOCKS ports Tor listens on.
 *
 * Tor never puts streams that arrived on different SOCKS ports on the same
 * circuit ("By default, streams received on different SocksPorts ... are
 * always isolated from one another" - tor(1)). So each private tab is given a
 * port of its own, and two tabs share a circuit only when more are open than
 * there are ports; then the port handed out longest ago is reused. Port 0 is
 * the fallback every context the browser did not set up itself uses; port 1
 * carries site icons, which would otherwise tie tabs together.
 */
const POOL_SIZE = 24;

/** The first port of a free-looking range for Tor's SOCKS listeners. */
function pickPort() {
  return 30000 + require('crypto').randomInt(0, 29000 - POOL_SIZE);
}

const poolFrom = (base) => Array.from({ length: POOL_SIZE }, (_, i) => base + i);

/** Which slot of the pool each session is bound to. Weak: sessions come and go. */
const slots = new WeakMap();
/** Set while a session is being created for a known slot; read by `session-created`. */
let creating = null;

/**
 * Make a session bound to one slot of the pool.
 *
 * `session-created` fires synchronously inside `fromPartition`, and that is
 * where the proxy is applied - so the slot is known at that moment rather than
 * set afterwards, when the session's first request might already be using the
 * fallback port and sharing a circuit it should not.
 */
function sessionWithSlot(electronSession, partition, slot) {
  creating = slot;
  try {
    return electronSession.fromPartition(partition);
  } finally {
    creating = null;
  }
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
  const base = pickPort();
  ctx.poolPorts = poolFrom(base);
  ctx.proxyPort = base;
  ctx.proxyRules = `socks5://127.0.0.1:${base}`;
  for (const ses of sessions) configureSession(ses, ctx, slots.get(ses) ?? 0);
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
    // This run's own directory. The Linux launcher makes it before the
    // browser starts, so Tor can be running in it already.
    if (name === `s-${process.pid}`) continue;
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    } catch { /* a file the OS still holds; the next start will get it */ }
  }
}

/**
 * This run's files, gone. Best-effort: the reaper and sweep() catch the rest.
 *
 * The root is swept as well, because `userData` is the root (the profile lock
 * has to be shared between incognito processes) and anything written there
 * rather than under this run's directory would otherwise outlive the window.
 * The leak test found exactly that on Windows: the credential store's key.
 */
function wipe(ctx) {
  try {
    fs.rmSync(ctx.sessionDir, { recursive: true, force: true });
  } catch { /* open files on Windows; the reaper gets them */ }
  sweep(ctx.root);
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
  // The same for the language every kind of worker reports. See fingerprint.js.
  require('./fingerprint').prepareEnvironment();
  require('./fingerprint').prepareApp(app);

  // The proxy is Tor, on a port picked here: it has to be on the command line
  // before the app is ready, which is before anything could ask the OS for a
  // free one. A collision is rare and handled - Tor reports it and main picks
  // again. The test suite supplies its own stand-in instead, on its own port.
  const requested = Number(argValue('incognito-proxy-port'));
  const external = Number.isInteger(requested) && requested > 0 && requested < 65536;
  const port = external ? requested : pickPort();
  const poolPorts = poolFrom(port);

  return {
    root,
    sessionDir,
    killSwitch: killSwitch(),
    normalUserData,
    /** A proxy supplied from outside (the leak test's stand-in), so no Tor is started. */
    externalProxy: external,
    /** Tor's SOCKS ports; the first is also the command-line fallback. */
    poolPorts,
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
    ['force-webrtc-ip-handling-policy', 'disable_non_proxied_udp'],
    // Chromium's own floor today; said here so a future default cannot lower it.
    ['ssl-version-min', 'tls1.2'],
    ...require('./fingerprint').switches()
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
function configureSession(ses, ctx, slot = creating ?? slots.get(ses) ?? 0) {
  slots.set(ses, slot);
  const port = ctx.poolPorts ? ctx.poolPorts[slot] : ctx.proxyPort;
  ses.setProxy({ proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: BYPASS_RULES }).catch(() => {});
  // `setSpellCheckerEnabled(false)` alone does not stop it - measured, the
  // download still went out. An empty language list does: there is then no
  // dictionary to fetch. Both, so the spellchecker is off as well as starved.
  try { ses.setSpellCheckerLanguages([]); } catch { /* macOS uses the system checker */ }
  try { ses.setSpellCheckerEnabled(false); } catch { /* not on this platform */ }
  // No local network, and HTTPS or an explanation. See policy.js.
  require('./policy').install(ses);
  // The same user agent and languages everywhere. See fingerprint.js.
  require('./fingerprint').configureSession(ses);
}

module.exports = {
  INCOGNITO, JS_LEVELS, DEFAULT_JS_LEVEL, RESOLVER_RULES, BYPASS_RULES,
  profileRoot, isPrivateDir, ensureRoot, sweep, wipe, startReaper, prepare, switches, configureSession,
  movePort, pickPort, killSwitch, POOL_SIZE, sessionWithSlot, slotOf: (ses) => slots.get(ses)
};
