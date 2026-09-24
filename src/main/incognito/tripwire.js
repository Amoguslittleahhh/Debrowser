'use strict';

/**
 * The egress tripwire: incognito's check, from outside Chromium, that nothing
 * went around the proxy.
 *
 * Every other protection in incognito is a setting the browser applies to
 * itself - a proxy on the command line, a proxy on every session, a resolver
 * that fails every lookup. Settings can be missed: a code path nobody thought
 * of, a Chromium background task that builds its own network context. This
 * asks the operating system which connections the browser's processes really
 * hold, several times a second, and closes the window the moment one of them
 * goes anywhere but the proxy.
 *
 * It polls, so it can miss a connection shorter than one interval. That is why
 * it is the second wall rather than the first on Linux and Windows, where the
 * OS itself refuses the connection; on macOS, which offers no per-app network
 * control without root, it is the one runtime check there is - and the Tor
 * panel says so rather than implying more.
 */

const { HelperProcess, HELPER_GONE } = require('../helper-process');
const platform = require('../platform');

const BINARY = platform.helperPath(process.platform === 'win32' ? 'net-watch.exe' : 'net-watch');

/** How often the browser's sockets are checked. */
const INTERVAL_MS = 250;
/** The slowest it will back off to if checking costs more than its budget. */
const MAX_INTERVAL_MS = 2000;
/**
 * The budget: the tripwire may cost at most this share of one core. Measured
 * from the helper's own CPU time, because a tripwire that makes browsing
 * slower is one somebody turns off.
 */
const CPU_BUDGET = 0.01;
/** How long between budget checks. */
const BUDGET_WINDOW_MS = 10_000;

/**
 * What a line is about. Called on both the command sent and the reply read,
 * and the two must agree: `check 7 …` is answered by `ok 7 …`, so both are "7".
 * An earlier version keyed only replies by id, so every check timed out
 * waiting for an answer it had in hand - and the tripwire checked nothing.
 */
const replyId = (line) => {
  const [verb, id] = line.split(' ');
  return verb === 'ok' || verb === 'check' ? id : verb;
};

class NetWatchHelper extends HelperProcess {
  constructor(log) {
    super({
      name: 'net-watch',
      binary: BINARY,
      timeoutMs: 1000,
      coldTimeoutMs: 5000,
      replyId,
      missingHint: (binary) => (binary.includes('resources')
        ? `helper missing from this build: ${binary}`
        : 'tools/net-watch not built (npm run build:netwatch)'),
      log
    });
  }
}

class Tripwire {
  /**
   * @param {object} deps
   * @param {Electron.App} deps.app
   * @param {() => number[]} deps.allowedPorts - the proxy port, the Tor control port
   * @param {(violations: string[], pids: number[]) => void} deps.onTrip
   * @param {Function} [deps.log]
   */
  constructor({ app, allowedPorts, onTrip, log = () => {} }) {
    this.app = app;
    this.allowedPorts = allowedPorts;
    this.onTrip = onTrip;
    this.log = log;
    this.helper = new NetWatchHelper(log);
    this.interval = INTERVAL_MS;
    this.timer = null;
    this.busy = false;
    this.seq = 0;
    /** Null until asked; then the capability in the shape every capability uses. */
    this.caps = null;
    /** Processes the OS would not let us look at, on the last check. */
    this.unreadable = 0;
    this.checks = 0;
    this.tripped = false;
    this.budget = { at: Date.now(), cpuUs: null, share: null };
  }

  /** `{available, mechanism, reason}`: whether it can see anything at all. */
  async capability() {
    if (this.caps) return this.caps;
    const line = await this.helper.request('caps');
    if (!line || line === HELPER_GONE) {
      this.caps = { available: false, mechanism: null, reason: this.helper.reason || 'helper did not answer' };
    } else {
      const [, os, ok, sees] = line.split(' ');
      this.caps = ok === '1'
        ? { available: true, mechanism: `${os} socket table (${sees})`, reason: null }
        : { available: false, mechanism: null, reason: `the ${os} socket table could not be read` };
    }
    return this.caps;
  }

  /** Every process Chromium runs for this browser, the browser itself included. */
  pids() {
    try {
      return this.app.getAppMetrics().map((m) => m.pid).filter((pid) => pid > 0);
    } catch {
      return [process.pid];
    }
  }

  /**
   * One look. Resolves `{ok, unreadable, violations}`; `ok` is false when the
   * helper could not answer, which is reported, never read as clean.
   */
  async check() {
    const pids = this.pids();
    const ports = this.allowedPorts().filter((p) => Number.isInteger(p) && p > 0);
    const id = String(++this.seq);
    const line = await this.helper.request(
      `check ${id} ${ports.length ? ports.join(',') : '-'} ${pids.join(',')}`);
    if (!line || line === HELPER_GONE || !line.startsWith('ok ')) {
      return { ok: false, unreadable: 0, violations: [] };
    }
    const [, , unreadable, count, ...items] = line.split(' ');
    this.unreadable = Number(unreadable) || 0;
    this.checks++;
    return { ok: true, unreadable: this.unreadable, count: Number(count) || 0, violations: items, pids };
  }

  start() {
    if (this.timer) return;
    const tick = async () => {
      if (this.busy || this.tripped) return;
      this.busy = true;
      try {
        const result = await this.check();
        if (result.ok && result.count > 0) {
          this.tripped = true;
          this.stop();
          this.onTrip(result.violations, result.pids);
          return;
        }
        await this.holdToBudget();
      } finally {
        this.busy = false;
      }
    };
    this.timer = setInterval(tick, this.interval);
    this.timer.unref();
    tick();
  }

  /**
   * Keep to the budget by measuring, not by assuming the check is cheap.
   *
   * Every ten seconds the helper's CPU time is read; over budget, the interval
   * doubles - slower to notice, never slower to browse - and the change is
   * logged so a machine where that happens is visible.
   */
  async holdToBudget() {
    const now = Date.now();
    if (now - this.budget.at < BUDGET_WINDOW_MS && this.budget.cpuUs != null) return;
    const line = await this.helper.request('usage');
    const cpuUs = line && line.startsWith('usage ') ? Number(line.split(' ')[1]) : null;
    if (cpuUs == null || !Number.isFinite(cpuUs)) return;
    if (this.budget.cpuUs != null) {
      const share = (cpuUs - this.budget.cpuUs) / 1000 / Math.max(1, now - this.budget.at);
      this.budget.share = share;
      if (share > CPU_BUDGET && this.interval < MAX_INTERVAL_MS) {
        this.interval = Math.min(MAX_INTERVAL_MS, this.interval * 2);
        this.log('tripwire', `cost ${(share * 100).toFixed(2)}% of a core; checking every ${this.interval}ms`);
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
          this.start();
        }
      }
    }
    this.budget.at = now;
    this.budget.cpuUs = cpuUs;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stops polling and ends the helper process. */
  dispose() {
    this.stop();
    this.helper.stop();
  }

  status() {
    return {
      ...(this.caps || { available: null, mechanism: null, reason: null }),
      intervalMs: this.interval,
      checks: this.checks,
      unreadable: this.unreadable,
      cpuShare: this.budget.share,
      tripped: this.tripped
    };
  }
}

module.exports = { Tripwire, INTERVAL_MS, CPU_BUDGET };
