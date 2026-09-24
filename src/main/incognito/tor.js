'use strict';

/**
 * Tor, as a child of the incognito process.
 *
 * Incognito's traffic goes to one SOCKS port, and this is what listens on it.
 * Tor is started from the Expert Bundle that `tools/fetch-tor.js` downloaded
 * and verified against the Tor Project's signing key; nothing here fetches or
 * trusts anything on its own.
 *
 * Owned tightly, because a Tor that outlives the browser, or a browser that
 * carries on without Tor, are both failures:
 *
 *   - `__OwningControllerProcess` makes Tor exit if this process dies, however
 *     it dies - a crash, a kill, the tripwire.
 *   - Its data directory is inside this run's session directory, so the reaper
 *     that deletes the private profile deletes Tor's state with it.
 *   - Until Tor reports 100%, the proxy port answers nothing useful and every
 *     request fails. There is no "direct until Tor is ready".
 *
 * Progress comes from Tor's own log on stdout ("Bootstrapped 45% (...)"),
 * which needs no connection to read. The control port is used for what only
 * it can do: asking the network whether this Tor is obsolete, and asking for
 * new circuits.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

/** Where the unpacked bundle lives: beside the app when installed, vendor/ in a checkout. */
function bundleDir() {
  if (process.resourcesPath && __dirname.includes(`app.asar${path.sep}`)) {
    return path.join(process.resourcesPath, 'tor');
  }
  return path.join(__dirname, '..', '..', '..', 'vendor', 'tor', `${process.platform}-${process.arch}`);
}

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/** How long a bootstrap may sit at one percentage before it is reported as stuck. */
const STALL_MS = 45_000;

class Tor {
  /**
   * @param {object} deps
   * @param {object} deps.ctx     - incognito context (sessionDir, proxyPort)
   * @param {(status: object) => void} deps.onStatus
   * @param {Function} [deps.log]
   */
  constructor({ ctx, onStatus = () => {}, log = () => {} }) {
    this.ctx = ctx;
    this.onStatus = onStatus;
    this.log = log;
    this.dir = path.join(ctx.sessionDir, 'tor');
    this.child = null;
    this.controlPort = null;
    this.status = {
      state: 'idle',          // idle | starting | bootstrapping | ready | failed | stopped
      progress: 0,
      tag: null,
      summary: null,
      warning: null,
      version: null,
      recommended: null,      // what the network says of this version, once asked
      transport: 'direct'
    };
    this.stallTimer = null;
    this.stopping = false;
  }

  /** `{available, reason}` - whether there is a Tor to start at all. */
  capability() {
    const binary = path.join(bundleDir(), exe('tor'));
    if (!fs.existsSync(binary)) {
      return {
        available: false,
        reason: process.resourcesPath && __dirname.includes('app.asar')
          ? `Tor is missing from this build (${binary})`
          : 'Tor is not unpacked (node tools/fetch-tor.js)'
      };
    }
    return { available: true, reason: null };
  }

  set(patch) {
    Object.assign(this.status, patch);
    this.onStatus({ ...this.status });
  }

  /** The torrc. Written, not passed as arguments, so it can be read back when something goes wrong. */
  config() {
    const lines = [
      `SocksPort 127.0.0.1:${this.ctx.proxyPort}`,
      // The control port is on loopback and authenticated with a cookie only
      // this user can read; its number is chosen by Tor and read back from a
      // file, so nothing guesses at it.
      'ControlPort auto',
      `ControlPortWriteToFile ${path.join(this.dir, 'control-port')}`,
      'CookieAuthentication 1',
      `CookieAuthFile ${path.join(this.dir, 'control-cookie')}`,
      `DataDirectory ${path.join(this.dir, 'data')}`,
      `__OwningControllerProcess ${process.pid}`,
      'ClientOnly 1',
      'AvoidDiskWrites 1',
      // The GeoIP databases are not shipped: a client does not need them, and
      // they are 25 MB. Pointing at a file that does not exist is how Tor is
      // told there is none.
      `GeoIPFile ${path.join(this.dir, 'no-geoip')}`,
      `GeoIPv6File ${path.join(this.dir, 'no-geoip6')}`,
      'Log notice stdout',
      ...(this.extraConfig ? this.extraConfig() : [])
    ];
    return `${lines.join('\n')}\n`;
  }

  start() {
    const cap = this.capability();
    if (!cap.available) {
      this.set({ state: 'failed', warning: cap.reason });
      return false;
    }
    if (this.child) return true;
    this.stopping = false;

    fs.mkdirSync(path.join(this.dir, 'data'), { recursive: true, mode: 0o700 });
    const torrc = path.join(this.dir, 'torrc');
    fs.writeFileSync(torrc, this.config(), { mode: 0o600 });

    const dir = bundleDir();
    const env = { ...process.env };
    // The bundle carries its own OpenSSL and libevent beside the binary.
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = dir;
    if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = dir;

    this.set({ state: 'starting', progress: 0, tag: null, summary: 'Starting Tor', warning: null });
    try {
      this.child = spawn(path.join(dir, exe('tor')), ['-f', torrc], {
        cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
    } catch (err) {
      this.set({ state: 'failed', warning: `Tor could not start: ${err.message}` });
      return false;
    }

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        this.line(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
      }
    };
    this.child.stdout.on('data', onData);
    this.child.stderr.on('data', onData);
    this.child.on('error', (err) => this.set({ state: 'failed', warning: `Tor could not start: ${err.message}` }));
    this.child.on('exit', (code, signal) => {
      this.child = null;
      this.controlPort = null;
      clearTimeout(this.stallTimer);
      if (this.stopping) {
        this.set({ state: 'stopped' });
      } else {
        this.set({ state: 'failed', warning: this.status.warning || `Tor exited (${signal || code})` });
      }
    });
    this.armStall();
    return true;
  }

  /** One line of Tor's log. */
  line(text) {
    if (!text) return;
    const version = /Tor (\d+\.\d+\.\d+\.\d+)/.exec(text);
    if (version && !this.status.version) this.status.version = version[1];

    const boot = /Bootstrapped (\d+)% \(([^)]+)\): (.*)$/.exec(text);
    if (boot) {
      const progress = Number(boot[1]);
      this.set({
        state: progress >= 100 ? 'ready' : 'bootstrapping',
        progress,
        tag: boot[2],
        summary: boot[3],
        warning: progress >= 100 ? null : this.status.warning
      });
      if (progress >= 100) {
        clearTimeout(this.stallTimer);
        this.askVersionStatus();
      } else {
        this.armStall();
      }
      return;
    }
    if (/\[(warn|err)\]/.test(text)) {
      // Kept for the bootstrap page: "stuck at 10%" means nothing to anyone,
      // and Tor's own last complaint usually names the reason.
      const message = text.replace(/^.*\[(warn|err)\]\s*/, '');
      if (!/running Tor as root|GeoIP/i.test(message)) this.status.warning = message;
      if (/Could not bind to/.test(message)) this.set({ state: 'failed', warning: message });
    }
    this.log('tor', text);
  }

  /** Report a bootstrap that has stopped moving, rather than spinning forever. */
  armStall() {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.status.state === 'ready' || !this.child) return;
      this.set({
        warning: this.status.warning ||
          `No progress for ${Math.round(STALL_MS / 1000)} seconds at ${this.status.progress}% - ` +
          'the network may be blocking Tor'
      });
    }, STALL_MS);
    if (typeof this.stallTimer.unref === 'function') this.stallTimer.unref();
  }

  /* ---------------------------------------------------------------- */
  /* Control port                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Send commands to the control port and collect the replies.
   *
   * A connection per use rather than one kept open: these are rare - a
   * version check at bootstrap, a new identity on request - and a held
   * connection is one more socket the tripwire has to be told about for the
   * life of the session.
   */
  async control(commands) {
    const portFile = path.join(this.dir, 'control-port');
    const cookieFile = path.join(this.dir, 'control-cookie');
    const port = /PORT=127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(portFile, 'utf8'));
    if (!port) throw new Error('Tor has not written its control port');
    this.controlPort = Number(port[1]);
    const cookie = fs.readFileSync(cookieFile).toString('hex');

    return new Promise((resolve, reject) => {
      const socket = net.connect(this.controlPort, '127.0.0.1');
      const replies = [];
      let buffer = '';
      let current = [];
      const expected = commands.length + 1;          // AUTHENTICATE first
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('control port timed out')); }, 5000);
      socket.on('error', (err) => { clearTimeout(timer); reject(err); });
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          current.push(line);
          // A reply ends with "<code> " (space); "<code>-" and "<code>+" continue it.
          if (/^\d{3} /.test(line)) {
            replies.push(current);
            current = [];
            if (replies.length === expected) {
              clearTimeout(timer);
              socket.end('QUIT\r\n');
              if (!replies[0][0].startsWith('250')) reject(new Error(`Tor refused authentication: ${replies[0][0]}`));
              else resolve(replies.slice(1));
            }
          }
        }
      });
      socket.write(`AUTHENTICATE ${cookie}\r\n${commands.map((c) => `${c}\r\n`).join('')}`);
    });
  }

  /**
   * Ask the Tor network what it thinks of this Tor.
   *
   * The consensus lists which versions are recommended; `status/version/current`
   * answers "recommended", "obsolete", "new" and so on. An obsolete Tor is the
   * one case the browser cannot fix by itself - the fix is a Debrowser update -
   * so it is surfaced rather than logged.
   */
  async askVersionStatus() {
    try {
      const [reply] = await this.control(['GETINFO status/version/current']);
      const hit = /status\/version\/current=(\S+)/.exec(reply.join('\n'));
      if (hit) this.set({ recommended: hit[1] });
    } catch (err) {
      this.log('tor', `version check failed: ${err.message}`);
    }
  }

  /** New circuits for everything from here on. */
  async newIdentity() {
    const [reply] = await this.control(['SIGNAL NEWNYM']);
    return reply.some((l) => l.startsWith('250'));
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.stallTimer);
    if (this.child) {
      try { this.child.kill(); } catch { /* already gone */ }
    }
  }

  /** Restart from nothing, e.g. after the user asks to try again. */
  restart() {
    this.stop();
    const again = () => this.start();
    if (this.child) this.child.once('exit', again);
    else again();
  }
}

module.exports = { Tor, bundleDir };
