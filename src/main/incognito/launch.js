'use strict';

/**
 * Starting incognito, from the normal browser.
 *
 * Incognito is a separate process (see mode.js for why), so opening it is a
 * spawn of this same executable with `--incognito`. If one is already running,
 * the new one loses the profile lock at once and the running one opens a tab
 * instead - so this does not need to know whether incognito is up.
 *
 * It is started through the operating system's kill switch where there is one:
 *
 *   Linux    native/helpers/netns-launch, which starts Tor outside and the browser
 *            inside a network namespace with nowhere to go. If the kernel
 *            refuses the namespace, the launcher says so and the browser runs
 *            behind its own settings and the tripwire.
 *   Windows  the installer's hard link, Debrowser-Incognito.exe, which a
 *            firewall rule blocks from everything but loopback.
 *   macOS    nothing to go through; the tripwire is what there is.
 *
 * Detached and with no pipes: the two processes are independent. Closing the
 * normal browser must not take a private session with it, and a pipe back to a
 * parent that has exited is a write error waiting to happen in the child.
 */

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const platform = require('../platform');
const mode = require('./mode');
const { bundleDir, launcherTemplate, exe } = require('./tor');

/**
 * Switches the child inherits because this process could only start with them:
 * `--no-sandbox` for a root container, `--disable-gpu` for a headless one.
 * Nothing else is passed down, so the parent cannot weaken incognito by being
 * started with something unusual.
 */
const INHERITED = ['--no-sandbox', '--disable-gpu'];

/** The Windows copy of this executable that the firewall rule names, if installed. */
function windowsIncognitoExe() {
  if (process.platform !== 'win32') return null;
  const candidate = path.join(path.dirname(process.execPath), 'Debrowser-Incognito.exe');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * The command that starts the private browser: [program, args].
 * @param {string[]} [torExtra] - extra torrc lines (bridges), for the Linux launcher
 */
function command(torExtra = [], extraArgs = []) {
  const args = [];
  // A development run is `electron <app dir>`; an installed build is the app.
  if (!app.isPackaged) args.push(app.getAppPath());
  args.push('--incognito', ...extraArgs);
  for (const flag of INHERITED) if (process.argv.includes(flag)) args.push(flag);

  if (process.platform === 'linux') {
    const helper = platform.helperPath('netns-launch');
    const tor = path.join(bundleDir(), exe('tor'));
    if (fs.existsSync(helper) && fs.existsSync(tor)) {
      const root = mode.profileRoot();
      mode.ensureRoot(root);
      // The launcher reads this, fills in the run's directory and pid, and
      // deletes it. Random, so two quick launches cannot read each other's.
      const template = path.join(root, `torrc-${crypto.randomBytes(8).toString('hex')}`);
      fs.writeFileSync(template, launcherTemplate(torExtra), { mode: 0o600 });
      return [helper, [root, tor, template, '--', process.execPath, ...args], { root }];
    }
  }
  return [windowsIncognitoExe() || process.execPath, args];
}

/**
 * @param {Function} log
 * @param {string[]} torExtra - bridge lines for the launcher's torrc
 * @param {{keepTorState?: boolean, userData?: string, warm?: boolean, onExit?: Function}} [state]
 */
/** The private browser's environment: this one's, less what must not cross. */
function childEnv(from = process.env) {
  const env = { ...from };
  // Never inherited: it turns the binary into a plain Node interpreter.
  delete env.ELECTRON_RUN_AS_NODE;
  // Only the launcher may say what it did; a stale value from the normal
  // browser's own environment must not claim a kill switch that is not there.
  delete env.DEBROWSER_KILL_SWITCH;
  delete env.DEBROWSER_TOR_DIR;
  delete env.DEBROWSER_TOR_PID;
  delete env.DEBROWSER_TOR_SEED;
  delete env.FONTCONFIG_FILE;
  // Set by Electron in this process for its own window, and fatal inherited:
  // a private browser started with it had its zygote - the process every page
  // is forked from - exit before saying hello, and Chromium ended there
  // (SIGTRAP, 100ms in). Measured on Linux, inside the kill switch's namespace
  // and outside it alike; it was every private window, from every menu.
  delete env.CHROME_DESKTOP;
  return env;
}

function launchIncognito(log = () => {}, torExtra = [], state = {}) {
  const env = childEnv();

  try {
    // Fonts, on Linux: the private browser's font configuration has to be in
    // its environment before it starts, not set by it afterwards - Chromium
    // forks the processes pages run in before any of its own code runs, and
    // they keep the environment they were born with. Measured: set from
    // inside, two fonts were hidden and four stayed readable. See fonts.js.
    if (state.userData) require('./fonts').restrict(state.userData, env);
    // Warm: connect Tor now, show nothing until the user asks for the window,
    // and go if this browser goes first. See main.js, WARM.
    const extra = state.warm ? ['--warm', `--warm-parent=${process.pid}`] : [];
    const [program, args, launcher] = command(torExtra, extra);
    // Under the launcher Tor starts before the private browser exists, so its
    // kept state is unsealed here - this process has the keystore - into a
    // private directory the launcher moves into place.
    if (launcher && state.keepTorState) {
      const seed = path.join(launcher.root, `seed-${crypto.randomBytes(8).toString('hex')}`);
      fs.mkdirSync(seed, { mode: 0o700 });
      if (require('./torstate').restore(state.userData, seed, log) > 0) env.DEBROWSER_TOR_SEED = seed;
      else fs.rmSync(seed, { recursive: true, force: true });
    }
    // What it says as it starts goes to a file of this user's alone, read only
    // if it fails - for the one line that says why - and then deleted. Before,
    // it went nowhere, and a private window that died left nothing to go on.
    const errFile = path.join(os.tmpdir(), `debrowser-private-${crypto.randomBytes(6).toString('hex')}.log`);
    let errFd = 'ignore';
    try { errFd = fs.openSync(errFile, 'w', 0o600); } catch { errFd = 'ignore'; }
    const child = spawn(program, args, { detached: true, stdio: ['ignore', 'ignore', errFd], env });
    if (typeof errFd === 'number') fs.closeSync(errFd);
    child.on('error', (err) => log('incognito', `could not start: ${err.message}`));
    if (state.onExit) child.on('exit', state.onExit);
    // A private browser that ends with an error never showed anything, so the
    // one that asked for it has to say so - with how long it ran, which says
    // whether it ever had a window, and why, where it said. Killed by a signal
    // counts: a crash is exactly that, and was the case that said nothing.
    const started = Date.now();
    child.on('exit', (code, signal) => {
      const why = failureReason(errFile);
      fs.rm(errFile, { force: true }, () => {});
      if ((code || signal) && state.onFail) state.onFail(code || signal, Date.now() - started, why);
    });
    child.unref();
    return true;
  } catch (err) {
    log('incognito', `could not start: ${err.message}`);
    return false;
  }
}

/**
 * The line that says why a private browser stopped, from what it wrote as it
 * did: Chromium's FATAL, a check that failed, a library that would not load -
 * at most two lines, trimmed, and nothing else of what it wrote.
 */
function failureReason(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  // Match before stripping: Chromium puts the severity inside the bracket.
  const lines = text.split('\n')
    .filter((l) => /FATAL|Check failed|sandbox|error while loading|cannot open|Segmentation|Trace\/breakpoint|netns-launch:/i.test(l))
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim());
  return lines.slice(-2).map((l) => l.slice(0, 220)).join('\n');
}

module.exports = { launchIncognito, command, failureReason, childEnv };
