'use strict';

/**
 * Platform abstraction for everything the governor does that is OS-specific.
 *
 * The policy in governor/ is written once and must behave the same on a 4GB
 * Windows laptop, an Apple-silicon Mac and a Linux desktop. The differences -
 * how you reprioritise a process, which Chromium features are worth toggling,
 * how much memory it is reasonable to claim - are all confined to this file.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { MB } = require('./config');
const { compressionStatus } = require('./memory');

const PLATFORM = process.platform; // 'linux' | 'darwin' | 'win32'
const isLinux = PLATFORM === 'linux';
const isMac = PLATFORM === 'darwin';
const isWindows = PLATFORM === 'win32';

/* ------------------------------------------------------------------ */
/* Process priority                                                     */
/* ------------------------------------------------------------------ */

/**
 * Node's `os.setPriority` is implemented on all three platforms, but the
 * underlying semantics differ and matter:
 *
 *  - Linux/macOS: it sets the nice value. Lowering nice below 0 requires
 *    privileges we will not have as a normal desktop app, so a request to
 *    *raise* priority usually fails. That is fine, and is why the boost
 *    strategy is built the other way round: background renderers are niced
 *    *up*, which needs no privileges, so the foreground tab wins the CPU by
 *    everyone else standing down. Asking for the raise anyway costs nothing
 *    and does help when the app happens to run privileged.
 *
 *  - Windows: it maps to priority classes, and lowering a process to
 *    BELOW_NORMAL/IDLE is permitted without elevation, so the same "background
 *    tabs stand down" strategy works directly.
 *
 * Node's priority scale is -20 (highest) to 19 (lowest) on every platform,
 * with Windows values bucketed into classes, so callers can pass nice-style
 * numbers everywhere.
 */
function setProcessPriority(pid, priority) {
  if (!pid) return false;
  // Escape hatch for locked-down environments that forbid priority changes,
  // and for isolating the governor's effects when benchmarking.
  if (process.env.DEBROWSER_DISABLE_PRIORITY === '1') return false;
  try {
    os.setPriority(pid, clampPriority(priority));
    return true;
  } catch {
    // EPERM (asking for a raise unprivileged) or ESRCH (process already gone).
    // Both are entirely expected; the caller treats priority as advisory.
    return false;
  }
}

function getProcessPriority(pid) {
  try {
    return os.getPriority(pid);
  } catch {
    return null;
  }
}

function clampPriority(priority) {
  if (!Number.isFinite(priority)) return 0;
  return Math.max(-20, Math.min(19, Math.round(priority)));
}

/**
 * Whether asking for an above-normal priority can succeed here. Used only to
 * decide whether to bother logging a failure, never to change policy.
 */
function canRaisePriority() {
  if (isWindows) return true;
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/* ------------------------------------------------------------------ */
/* Trimming a background renderer into the OS compressor                */
/* ------------------------------------------------------------------ */

/**
 * Ask the OS to reclaim a renderer's cold pages, holding them compressed.
 *
 * A hidden tab keeps its whole working set for as long as it lives. Usually the
 * governor answers that by discarding the renderer, but a tab holding
 * unsubmitted input or live in-page state cannot be discarded without losing it,
 * so those sit at FROZEN holding everything. This is the lever that works on
 * them: the process stays alive and its state is untouched, while its cold pages
 * move into zram (or, on other platforms, whatever compressor exists) and fault
 * back on resume.
 *
 * Measured at roughly 29-49% of a renderer's private memory returned to the
 * system, rising with size, for a 4-12ms resume - see docs/MEASUREMENTS.md,
 * M4b/M4c. The percentage is net of the compressor's own allocation, which runs
 * about 2:1, so a per-process reading alone overstates it by roughly double.
 *
 * **Linux only, deliberately.** Windows would hand pages to MemCompression via
 * `SetProcessWorkingSetSizeEx(h, -1, -1)` and needs no elevation to do it, which
 * makes it the better platform for this on paper. It is not implemented because
 * it could not be executed on the machine this was written on, and shipping a
 * plausible-looking call nobody has run is worse than an honest refusal: a wrong
 * number gets checked, working-looking code does not. macOS has no public API to
 * force its compressor at all. Both report `available: false` with a reason.
 */

const TRIM_BINARY = path.join(__dirname, '..', '..', 'tools', 'mem-trim');
const TRIM_TIMEOUT_MS = 2000;

class TrimHelper {
  constructor(log = () => {}) {
    this.log = log;
    this.child = null;
    this.pending = null;      // { resolve, timer } - one request at a time
    this.queue = [];
    this.restarts = 0;
    this.stopped = false;
    /**
     * Replies owed by the helper for requests we have already given up on.
     *
     * The protocol has no request ids, and it does not need them as long as
     * this is tracked: the helper answers in order, one line per command. But a
     * timed-out request is not cancelled - the helper is still working on it and
     * will eventually print its reply - so without this the late answer to a
     * trim of pid A would be handed to the caller waiting on pid B, reporting
     * bytes that were never advised for it. Each timeout adds one owed reply and
     * the next line from the helper is dropped against it.
     */
    this.owed = 0;
    /** null until the helper has been asked; then true/false. */
    this.canTrim = null;
    this.reason = null;
  }

  /**
   * Start the helper, once. It is deliberately long-lived: spawning a process
   * per trim would cost more than the trim it performs saves, and tier
   * transitions are frequent.
   */
  start() {
    if (this.child || this.reason || this.stopped) return Boolean(this.child);
    if (!isLinux) { this.reason = `not implemented on ${PLATFORM}`; return false; }
    if (!fs.existsSync(TRIM_BINARY)) {
      this.reason = 'tools/mem-trim not built (npm run build:memtrim)';
      return false;
    }
    try {
      this.child = spawn(TRIM_BINARY, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      this.reason = `could not start helper: ${err.message}`;
      return false;
    }

    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        // The late reply to something nobody is waiting for any more.
        if (this.owed > 0) { this.owed -= 1; continue; }
        this.settle(line.trim());
      }
    });
    // A helper that dies takes trim with it rather than the browser: every
    // caller treats an unavailable trim as "do nothing", never as an error.
    this.child.on('exit', () => {
      this.child = null;
      this.owed = 0;                 // a dead helper owes nothing
      this.settle(null);
      if (this.stopped) return;      // we asked it to go
      if (this.restarts++ === 0) {
        this.log('mem-trim helper exited; restarting once');
        this.start();
      } else {
        this.reason = 'helper exited repeatedly';
      }
    });
    // The helper must never be the reason the browser will not exit, and must
    // never be unreferenced while a reply is in flight - unreferencing stdout
    // permanently means the event loop can exit before the answer arrives, and
    // the request simply never resolves. So the handles are referenced only
    // while a request is outstanding; see `hold` and `release`.
    this.child.unref();
    this.release();
    return true;
  }

  /**
   * Shut the helper down. Called on quit; safe to call when not running.
   *
   * The flag is the point: killing the child fires the `exit` handler, whose
   * job is to bring a crashed helper back. Without it, shutting down spawned a
   * fresh helper process on the way out of the browser.
   */
  stop() {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
      child.kill();
    } catch { /* already gone */ }
  }

  /** Keep the event loop alive while waiting for a reply. */
  hold() {
    if (!this.child) return;
    this.child.stdout.ref();
    this.child.stdin.ref();
  }

  /** Stop holding it once nothing is outstanding. */
  release() {
    if (!this.child || this.pending || this.queue.length) return;
    this.child.stdout.unref();
    this.child.stdin.unref();
  }

  settle(line) {
    const waiting = this.pending;
    this.pending = null;
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.resolve(line);
    }
    const next = this.queue.shift();
    if (next) this.send(next.command, next.resolve);
    else this.release();
  }

  send(command, resolve) {
    if (!this.start()) return resolve(null);
    if (this.pending) {
      this.queue.push({ command, resolve });
      return undefined;
    }
    const timer = setTimeout(() => {
      // A wedged helper must never stall a tier transition. The request is not
      // cancelled - the helper is inside a syscall and will answer eventually -
      // so the answer is booked as owed and dropped when it arrives, rather than
      // being handed to whoever asks next.
      this.log(`mem-trim timed out on "${command}"`);
      this.owed += 1;
      this.settle(null);
    }, TRIM_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.pending = { resolve, timer };
    this.hold();
    try {
      this.child.stdin.write(`${command}\n`);
    } catch {
      this.settle(null);
    }
    return undefined;
  }

  request(command) {
    return new Promise((resolve) => this.send(command, resolve));
  }

  /** Bytes advised, or null if the trim did not happen. */
  async trim(pid) {
    if (!pid) return null;
    const line = await this.request(`trim ${pid}`);
    if (!line) return null;
    const ok = /^ok \d+ (\d+)$/.exec(line);
    if (ok) return Number(ok[1]);
    const err = /^err \d+ (\d+)$/.exec(line);
    if (err) this.log(`mem-trim refused pid ${pid}: errno ${err[1]}`);
    return null;
  }

  /** Whether trimming can work here at all, asked once. */
  async probe() {
    if (this.canTrim !== null) return this.canTrim;
    if (!this.start()) { this.canTrim = false; return false; }
    const line = await this.request('caps');
    const m = line && /^caps \w+ ([01])$/.exec(line);
    this.canTrim = Boolean(m && m[1] === '1');
    if (!this.canTrim) {
      // The overwhelmingly likely cause on a desktop, and the one with a fix.
      this.reason = 'needs CAP_SYS_NICE: sudo setcap cap_sys_nice+ep tools/mem-trim';
    }
    return this.canTrim;
  }
}

let helper = null;
const trimHelper = (log) => (helper || (helper = new TrimHelper(log)));

/**
 * Trim one process. Resolves to bytes advised, or null when trimming did not
 * happen for any reason - unavailable platform, missing capability, dead helper.
 * Never rejects: a failed trim is a missed optimisation, not an error.
 */
function trimProcessMemory(pid, log) {
  return trimHelper(log).trim(pid);
}

/**
 * Undo a trim. A no-op on Linux, where MADV_PAGEOUT is one-shot and the pages
 * fault back on their own - kept so the promotion path reads the same on every
 * platform, and because the macOS approach (marking the process background)
 * would genuinely need undoing or a restored tab stays throttled and janky.
 */
function untrimProcessMemory() {
  return true;
}

/** Release the trim helper. Called from `before-quit`. */
function stopTrimHelper() {
  if (helper) helper.stop();
}

/**
 * Whether trimming works here, and if not, why.
 *
 * Shaped like `pageMergingStatus()` in memory.js and for the same reason: the
 * failure modes are indistinguishable from the outside. "No helper built",
 * "helper built but lacks CAP_SYS_NICE" and "works fine but there is no swap to
 * page into" all look identical as a flat zero, and a user who cannot tell which
 * one they have cannot fix it.
 */
async function trimCapability(log) {
  const h = trimHelper(log);
  const permitted = await h.probe();

  // Two independent conditions, and the second is the one that bites. The
  // helper's self-test only proves the syscall is *permitted*: MADV_PAGEOUT
  // succeeds with no swap configured and reclaims nothing, because the kernel
  // has nowhere to put dirty anonymous pages. Reporting "available" on that
  // basis means the governor hibernates ten tabs for zero return before its
  // self-disable notices. Ask where the pages would actually go.
  const compression = compressionStatus();

  let reason = null;
  if (!permitted) reason = h.reason || `not implemented on ${PLATFORM}`;
  else if (!compression.available) {
    reason = 'no swap or zram configured - the kernel has nowhere to compress into';
  }

  return {
    available: permitted && compression.available,
    // Reported separately so the two halves can be told apart from outside -
    // the same reason `pageMergingStatus()` splits `processMergeable` from
    // `ksmRunning`. A caller checking only the compressor would call this
    // capability correct on a machine that has zram and no CAP_SYS_NICE.
    permitted,
    mechanism: permitted ? `process_madvise(MADV_PAGEOUT) -> ${compression.compressor || 'nothing'}` : null,
    reason,
    compression
  };
}

/* ------------------------------------------------------------------ */
/* Memory sizing                                                        */
/* ------------------------------------------------------------------ */

/**
 * Pick a default memory budget from the machine's actual RAM.
 *
 * A fixed megabyte figure is wrong on both ends: it strands memory on a 32GB
 * workstation and thrashes on a 4GB netbook. Instead we take a share of total
 * RAM, with the share itself falling on smaller machines (where the OS and
 * other apps need a proportionally larger slice), then clamp to a range where
 * a browser is still pleasant to use.
 */
function recommendedBudgetMB() {
  const totalMB = Math.round(os.totalmem() / MB);

  let share;
  if (totalMB <= 4096) share = 0.28;       // 4GB and under: stay well clear of swap
  else if (totalMB <= 8192) share = 0.34;
  else if (totalMB <= 16384) share = 0.40;
  else share = 0.45;                        // plenty of headroom; use it

  const budget = Math.round(totalMB * share);
  return Math.max(512, Math.min(budget, 6144));
}

/**
 * How many tabs should be allowed to hold a renderer at once on this machine.
 *
 * Each renderer carries a fixed overhead - V8 isolate, Blink globals, IPC
 * plumbing - of roughly 25-40MB before it renders anything, so on a small
 * machine the number of live renderers dominates everything else the governor
 * can do. Unlike a Chromium process limit this is enforced by discarding the
 * least-recently-used tab, which costs a reload rather than costing site
 * isolation.
 */
function recommendedLiveTabs() {
  const totalMB = Math.round(os.totalmem() / MB);
  if (totalMB <= 4096) return 4;
  if (totalMB <= 8192) return 6;
  if (totalMB <= 16384) return 8;
  return 12;
}

/** Free physical memory as a fraction of total. Used for host-level pressure. */
function systemMemoryPressure() {
  const total = os.totalmem();
  const free = os.freemem();
  if (!total) return 0;
  return 1 - free / total;
}

/**
 * True when we are root on Linux without `--no-sandbox` on the command line -
 * the configuration where Chromium aborts at startup rather than running
 * unsandboxed by accident. Only containers and CI hit this; a normal desktop
 * install never should, and the sandbox must stay on there.
 */
function runningRootUnsandboxed() {
  if (!isLinux) return false;
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  return !process.argv.includes('--no-sandbox');
}

function systemInfo() {
  return {
    platform: PLATFORM,
    arch: process.arch,
    cores: os.cpus()?.length || 0,
    totalMemoryMB: Math.round(os.totalmem() / MB),
    freeMemoryMB: Math.round(os.freemem() / MB)
  };
}

/* ------------------------------------------------------------------ */
/* Chromium command-line flags                                          */
/* ------------------------------------------------------------------ */

/**
 * Build the Chromium switch list.
 *
 * Every entry here is deliberate. The temptation with an Electron app is to
 * paste in the usual "make it fast" flag soup, but several of those flags
 * (`--disable-renderer-backgrounding`, `--disable-background-timer-throttling`)
 * do the exact opposite of what this browser is for: they keep background tabs
 * burning CPU. We want Chromium's own throttling fully switched *on*, and then
 * we go further than it does.
 */
function chromiumSwitches(cfg) {
  const switches = [];
  const features = [];
  const disabledFeatures = [];

  // --- Memory ------------------------------------------------------------

  // Deliberately only set when explicitly configured, and not derived from
  // host RAM as an earlier version did.
  //
  // When Chromium hits this limit it starts reusing a single process for
  // *different* sites, which weakens site isolation - the security boundary
  // that keeps one origin from reading another's memory. The governor's
  // `maxLiveTabs` cap already bounds the renderer count, and does it by
  // discarding tabs rather than by collapsing unrelated origins together, so
  // the limit buys nothing here and costs something real.
  if (cfg.rendererProcessLimit > 0) {
    switches.push(['renderer-process-limit', String(cfg.rendererProcessLimit)]);
  }

  if (cfg.siteIsolation === false) {
    // Security-relevant: see `siteIsolation` in config.js. Cross-site subframes
    // stop getting their own processes, and Chromium no longer guarantees that
    // two sites never share an address space.
    disabledFeatures.push('site-per-process', 'IsolateOrigins');
    switches.push(['disable-site-isolation-trials']);
  }

  if (cfg.processPerSite) {
    // One renderer per site rather than per tab. Twelve tabs on the same
    // site collapse into one process instead of twelve, which is the single
    // largest saving available for heavy tab users. The cost is crash
    // isolation, so it is opt-in via the economy profile.
    switches.push(['process-per-site']);
  }

  if (!cfg.spareRenderer) {
    // Chromium keeps a warm spare renderer to make the next navigation feel
    // instant. It costs a real process (~30-40MB) to save ~100ms, which is
    // the wrong trade when memory is the constraint.
    disabledFeatures.push('SpareRendererForProcessPerSite');
  }

  // Bias V8 towards smaller heaps and smaller generated code rather than peak
  // throughput. This is the one per-tab memory flag that measured a real win:
  // on six tabs of a DOM-heavy page it took each tab from 37.9MB to 33.0MB of
  // proportional set size, a 13% reduction, for a modest JIT cost.
  //
  // Two flags that did *not* survive measurement, and are deliberately absent:
  //
  //   --max-semi-space-size   an earlier version set this, reasoning that V8's
  //                           scavenger semi-spaces are sized for throughput.
  //                           Measured at 2MB, 16MB and unset: no difference
  //                           beyond noise. It was an assumption, not a finding.
  //   --enable-low-end-device-mode
  //                           saves exactly what --optimize-for-size saves and
  //                           does not stack with it (33.5MB combined, against
  //                           33.0MB for optimize-for-size alone), while also
  //                           shrinking image caches and disabling features the
  //                           user would notice. Same benefit, real cost.
  if (cfg.optimizeForSize) switches.push(['js-flags', '--optimize-for-size']);

  // --- Per-platform ------------------------------------------------------

  // Note on feature flags: this list is deliberately short. Force-enabling
  // Chromium features that are already on by default buys nothing and can do
  // real damage - an earlier version of this file enabled
  // `CanvasOopRasterization`, which segfaulted the renderer of any page with a
  // canvas whenever the machine fell back to software rasterization. Nothing
  // goes in here unless it is both verifiable and load-bearing.

  if (isLinux) {
    // Prefer the Wayland/X11 backend the session actually provides rather
    // than forcing X11 through XWayland, which costs an extra copy per frame.
    if (!process.env.DEBROWSER_NO_OZONE_AUTO && process.env.XDG_SESSION_TYPE === 'wayland') {
      switches.push(['ozone-platform-hint', 'auto']);
      switches.push(['enable-wayland-ime']);
    }
    // Note: `--no-sandbox` cannot be added here. Chromium reads it during
    // pre-sandbox startup, which happens before any of this code runs, so it
    // has to be on the process command line itself. Containers and CI images
    // running as root need it on the argv; see `runningRootUnsandboxed`.
  }

  if (features.length) switches.push(['enable-features', features.join(',')]);
  if (disabledFeatures.length) switches.push(['disable-features', disabledFeatures.join(',')]);

  return switches;
}

module.exports = {
  PLATFORM,
  isLinux,
  isMac,
  isWindows,
  setProcessPriority,
  getProcessPriority,
  trimProcessMemory,
  untrimProcessMemory,
  trimCapability,
  stopTrimHelper,
  canRaisePriority,
  clampPriority,
  runningRootUnsandboxed,
  recommendedBudgetMB,
  recommendedLiveTabs,
  systemMemoryPressure,
  systemInfo,
  chromiumSwitches
};
