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
const { HelperProcess, HELPER_GONE } = require('./helper-process');
const { MB } = require('./config');
const { compressionStatus } = require('./memory');

const PLATFORM = process.platform; // 'linux' | 'darwin' | 'win32'
const isLinux = PLATFORM === 'linux';
const isWindows = PLATFORM === 'win32';
const isMac = PLATFORM === 'darwin';

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

/**
 * Where the trim helper lives, which is not the same place in a packaged app.
 *
 * A checkout runs it straight out of `tools/`. An installed build has the
 * JavaScript inside `app.asar`, and a binary inside an asar archive **cannot be
 * executed** - the archive is a single file the runtime reads, not a directory
 * the kernel can exec from. So the packager copies the helper to the app's
 * resources directory instead and this finds it there.
 *
 * Getting this wrong would not have crashed anything: `existsSync` would simply
 * have failed and every packaged Linux install would have reported "mem-trim
 * not built" forever, with a build instruction that does not apply to an
 * installed app. A feature silently absent in every shipped copy while the
 * source tree it was tested in works fine.
 */
function helperPath(name) {
  // `resourcesPath` exists only under Electron, and the asar check distinguishes
  // an installed build from a developer run, which is also under Electron.
  if (process.resourcesPath && __dirname.includes(`app.asar${path.sep}`)) {
    return path.join(process.resourcesPath, 'tools', name);
  }
  return path.join(__dirname, '..', '..', 'tools', name);
}

const TRIM_BINARY = helperPath(process.platform === 'win32' ? 'mem-trim.exe' : 'mem-trim');
const PROBE_BINARY = helperPath(process.platform === 'win32' ? 'mem-probe.exe' : 'mem-probe');

/**
 * Measurement has a much tighter deadline than a trim.
 *
 * A trim is a syscall that may legitimately take a while paging a large heap
 * out. A measurement is a walk of a working set, on the governor's tick, for
 * every process - so a slow one must be abandoned and the tick completed with
 * the fallback figure rather than waited on.
 */
const PROBE_TIMEOUT_MS = 400;
/**
 * What the *first* measurement may take: a process spawn, and on Windows a
 * first-run scan of an unsigned helper. Both are one-off and neither is the
 * governor's tick to pay for, but timing them out costs a whole round of
 * coverage - and a round that lands late is invisible, while a round that never
 * lands shows up as a summed total.
 */
const PROBE_COLD_TIMEOUT_MS = 5000;
const TRIM_TIMEOUT_MS = 2000;
/**
 * What the *first* trim-helper answer may take, for the same reason the probe
 * has one: the spawn and, on Windows, a first-run scan of an unsigned binary.
 * `caps` and `avail` are usually the first two things asked of this helper and
 * both are cheap once it is running, so a cold deadline costs nothing in the
 * steady state and avoids reporting a healthy helper as absent.
 */
const TRIM_COLD_TIMEOUT_MS = 5000;

/**
 * How long a pid stays "just trimmed".
 *
 * Only has to outlast one governor pass, which is what walks a renderer's tabs
 * one after another. Cleared outright when the tab is promoted, so a renderer
 * that wakes and goes cold again inside the window is still trimmed properly.
 */
const TRIM_COOLDOWN_MS = 5000;

/**
 * Backoff after a trim the kernel refused for a specific process, doubling per
 * consecutive refusal up to the cap.
 *
 * Without it a refusal costs the same every tick, forever. The tab holds at
 * FROZEN, the ladder targets HIBERNATED again two seconds later, and the
 * governor issues another serialised round trip to the helper for a call that
 * has already failed - a per-pid EPERM or a process that has gone away does not
 * become true again by being asked more often. The global self-disable does not
 * cover this: it measures reclaim across the browser and is deliberately blind
 * to one renderer refusing while the rest work.
 */
const TRIM_BACKOFF_MS = 30_000;
const TRIM_BACKOFF_MAX_MS = 600_000;

/**
 * A timeout escalates on its own, much shorter ladder.
 *
 * `err <pid> <errno>` is the kernel saying no, and saying it again in ten
 * minutes is the right response. A timeout is not that: the syscall may well
 * have completed just after we stopped waiting, which is why the cooldown is
 * recorded alongside it. Sharing one ladder would exile a healthy renderer that
 * is merely slow to page out for ten minutes on the strength of two slow calls.
 */
const TRIM_TIMEOUT_BACKOFF_MAX_MS = 60_000;

/** Cap on the pid maps, enforced by eviction rather than only by expiry. */
const TRIM_MAP_LIMIT = 256;

/**
 * What a command or a reply is *about*, which is all the correlation this
 * protocol needs: `trim <pid>` is answered by `ok <pid> …` or `err <pid> …`,
 * and `caps` by `caps linux <0|1>`.
 */
function replyId(line) {
  const [verb, second] = line.split(' ');
  // Two verbs answer about themselves rather than about a pid; everything else
  // names the process it is about, which is what lets a late reply to a
  // timed-out request be dropped instead of handed to the next caller.
  if (verb === 'caps' || verb === 'avail') return verb;
  return second;
}

class TrimHelper extends HelperProcess {
  constructor(log = () => {}) {
    super({
      name: 'mem-trim',
      binary: TRIM_BINARY,
      timeoutMs: TRIM_TIMEOUT_MS,
      coldTimeoutMs: TRIM_COLD_TIMEOUT_MS,
      replyId,
      // Linux and Windows have a mechanism; macOS has none that a program may
      // reach - `memorystatus_control` is private and `MADV_FREE_REUSABLE` only
      // works on your own memory - so it refuses by name rather than shipping a
      // call nobody has run.
      precondition: () => (isLinux || isWindows
        ? null
        : `not implemented on ${PLATFORM}`),
      // Two different audiences, two different remedies. Telling someone with
      // an installed build to run an npm script in a source tree they do not
      // have is the same class of wrong answer as telling them to `setcap` a
      // binary that was merely not executable.
      missingHint: (binary) => (binary.includes('resources')
        ? `helper missing from this build: ${binary}`
        : 'tools/mem-trim not built (npm run build:memtrim)'),
      log
    });

    /**
     * Pids trimmed recently, and when.
     *
     * A trim acts on a *process*, but the governor's tier ladder walks *tabs*,
     * and under `process-per-site` several tabs share one renderer - so the
     * second and later tabs of a group ask to trim a pid that was paged out
     * microseconds ago, which advises whatever the first call left behind for
     * no return. Held here rather than in the governor because "a trim acts on
     * a process" is this layer's fact, not the ladder's, and because it is the
     * only place both the trim and its undo pass through.
     */
    this.trimmedAt = new Map();
    /** Last answer to `avail`, so a failed read can say "unknown" rather than 0. */
    this.lastAvail = null;
    /**
     * Pids whose trim the kernel refused: `pid -> { until, strikes }`.
     *
     * Separate from `trimmedAt` because the two mean opposite things - one says
     * "there is nothing left to take", the other "this one cannot be asked yet"
     * - and they are cleared by different events.
     */
    this.refused = new Map();
    /** null until the helper has been asked; then true/false. */
    this.canTrim = null;
  }

  /** Bytes advised, or null if the trim did not happen. */
  async trim(pid) {
    if (!pid) return null;
    // Nothing is left to page out this soon after the last call, so answer
    // "trimmed, zero bytes" without troubling the helper. Zero rather than null
    // because the process *is* trimmed; null is reserved for refusals.
    const last = this.trimmedAt.get(pid);
    if (last != null && Date.now() - last < TRIM_COOLDOWN_MS) return 0;

    // Still serving out an earlier refusal. Refused without a round trip, which
    // is the whole point: the caller sees the same null it saw last time.
    if (this.backoffMs(pid) > 0) return null;

    const line = await this.request(`trim ${pid}`);

    // No helper at all. That failure belongs to every pid, not to whichever one
    // happened to ask, and `reason` already reports it.
    if (line === HELPER_GONE) return null;

    const ok = line && /^ok \d+ (\d+)$/.exec(line);
    if (ok) {
      this.trimmedAt.set(pid, Date.now());
      this.refused.delete(pid);          // a working pid carries no strikes
      return Number(ok[1]);
    }

    const err = line && /^err \d+ (\d+)$/.exec(line);
    if (err) {
      this.refuse(pid, `errno ${err[1]}`, TRIM_BACKOFF_MAX_MS);
      return null;
    }

    // Timed out inside the syscall on this process. Treated as a trim that
    // probably *landed*: the helper is still working, and MADV_PAGEOUT on a
    // large renderer taking longer than we waited says nothing about whether
    // the kernel accepted it. So the cooldown is recorded - asking again
    // immediately would page out what this call is still in the middle of
    // taking - and the backoff runs on the short ladder, because a slow
    // renderer must not be exiled for ten minutes for being slow.
    this.trimmedAt.set(pid, Date.now());
    this.refuse(pid, 'no reply in time', TRIM_TIMEOUT_BACKOFF_MAX_MS);
    return null;
  }

  /** Milliseconds left before `pid` may be asked again. */
  backoffMs(pid) {
    const entry = this.refused.get(pid);
    if (!entry) return 0;
    return Math.max(0, entry.until - Date.now());
  }

  /**
   * Record a refusal and push the pid's next attempt further out.
   *
   * `ceiling` is what separates a kernel refusal from a timeout. Strikes reset
   * when the kind of failure changes, so a renderer that timed out twice and
   * then hits a real EPERM starts that ladder from the bottom rather than
   * inheriting an escalation earned for something else.
   */
  refuse(pid, why, ceiling) {
    this.prune();
    const prev = this.refused.get(pid);
    const strikes = prev && prev.ceiling === ceiling ? prev.strikes + 1 : 1;
    const wait = Math.min(TRIM_BACKOFF_MS * 2 ** (strikes - 1), ceiling);
    this.refused.set(pid, { until: Date.now() + wait, strikes, ceiling });
    // Logged on every refusal, which the backoff itself keeps to a trickle:
    // once per pid at 30s, then a minute, then two, up to ten.
    this.log(`mem-trim refused pid ${pid}: ${why}; not retrying for ${Math.round(wait / 1000)}s`);
  }

  /**
   * Forget that a pid was trimmed, so the next request is honoured in full.
   * Called when a tab is promoted: the renderer is running again, its pages are
   * faulting back, and what it holds a moment later is worth taking again. The
   * refusal record deliberately survives - waking a tab does not grant the
   * permission that was missing, and clearing it here would restore the
   * every-tick retry through any tab the user happens to visit.
   */
  forget(pid) {
    this.trimmedAt.delete(pid);
  }

  /**
   * Drop everything known about a pid. Called when the process is gone: pids are
   * recycled, and a new renderer must not inherit a dead one's backoff.
   */
  forgetProcess(pid) {
    this.trimmedAt.delete(pid);
    this.refused.delete(pid);
  }

  /**
   * Bound both maps on a long session. `forgetProcess` handles the ordinary case
   * as renderers exit; this is the backstop for pids that were refused and never
   * seen again.
   *
   * Expiry alone does not bound anything - a host with no CAP_SYS_NICE refuses
   * every renderer it ever opens, and inside one backoff window none of those
   * entries is expired - so once the expired ones are gone, the oldest survivors
   * are evicted down to the limit. Evicting a live backoff early only means that
   * pid is asked once more, which is the cheap direction to be wrong in.
   */
  prune() {
    const now = Date.now();
    for (const [pid, at] of this.trimmedAt) {
      if (now - at >= TRIM_COOLDOWN_MS) this.trimmedAt.delete(pid);
    }

    if (this.refused.size < TRIM_MAP_LIMIT) return;
    for (const [pid, entry] of this.refused) {
      if (entry.until <= now) this.refused.delete(pid);
    }
    if (this.refused.size < TRIM_MAP_LIMIT) return;
    const oldestFirst = [...this.refused.entries()].sort((a, b) => a[1].until - b[1].until);
    for (const [pid] of oldestFirst.slice(0, this.refused.size - TRIM_MAP_LIMIT + 1)) {
      this.refused.delete(pid);
    }
  }

  /** Whether trimming can work here at all, asked once. */
  async probe() {
    if (this.canTrim !== null) return this.canTrim;
    if (!this.start()) { this.canTrim = false; return false; }
    const line = await this.request('caps');
    this.canTrim = false;

    // Never reached the helper, so it said nothing about capabilities. Whatever
    // went wrong already has a name - a spawn failure, a helper that exited, a
    // shutdown - and overwriting it with the permissions message below would
    // hand the user a confident remedy for a problem they do not have. That is
    // the failure this whole capability report exists to avoid: it was observed
    // telling someone to run `setcap` on a binary that was merely not
    // executable.
    if (line === HELPER_GONE) {
      this.reason = this.reason || 'helper could not be reached';
      return false;
    }

    const m = line && /^caps \w+ ([01])$/.exec(line);
    this.canTrim = Boolean(m && m[1] === '1');
    if (!this.canTrim) {
      // The helper ran and answered "no". On a desktop that is overwhelmingly
      // the missing capability, and it is the one with a fix.
      this.reason = m
        ? 'needs CAP_SYS_NICE: sudo setcap cap_sys_nice+ep tools/mem-trim'
        : `helper gave an unreadable answer: "${line}"`;
    }
    return this.canTrim;
  }
}

/**
 * What the machine has spare, and whether trimmed pages have anywhere to go.
 *
 * Asked of the helper rather than read here, because the two platforms answer
 * it with different system calls and this is the one place that already knows
 * which platform it is talking to. Linux reads MemAvailable and the swap
 * totals; Windows reads GlobalMemoryStatusEx.
 *
 * This is the figure the hibernation tier is judged on. A working set that
 * shrank by 200MB has proved nothing until the machine has 200MB more
 * available than it did - pages leaving a process reappear as the compressor's
 * own allocation, measured at about 2:1, so a per-process reading alone
 * overstates the saving by roughly double. That mistake has been made twice in
 * this project and both times it took an independent reading to catch.
 *
 * @returns {Promise<{availBytes:number, backingTotalBytes:number, backingFreeBytes:number}|null>}
 */
async function availableMemory(log) {
  const h = trimHelper(log);
  const reply = await h.request('avail');
  if (!reply || reply === HELPER_GONE) return null;
  const [, avail, total, free] = reply.split(' ').map(Number);
  if (!Number.isFinite(avail) || avail < 0) return null;
  const out = {
    availBytes: avail,
    backingTotalBytes: Number.isFinite(total) && total >= 0 ? total : 0,
    backingFreeBytes: Number.isFinite(free) && free >= 0 ? free : 0
  };
  h.lastAvail = out;
  return out;
}

let helper = null;
const trimHelper = (log) => (helper || (helper = new TrimHelper(log)));

/**
 * Trim one process. Resolves to bytes advised - possibly zero, for a process
 * trimmed moments ago - or null when trimming did not happen for any reason:
 * unavailable platform, missing capability, dead helper. Never rejects: a failed
 * trim is a missed optimisation, not an error.
 */
/**
 * Per-process memory on the platforms that do not hand it out for free.
 *
 * Linux is not served by this: smaps_rollup already carries a real Pss line,
 * read directly and more cheaply than a round trip through a helper. A second
 * path to the same number would be one more thing to keep honest.
 */
class MeasureHelper extends HelperProcess {
  constructor(log = () => {}) {
    super({
      name: 'mem-probe',
      binary: PROBE_BINARY,
      timeoutMs: PROBE_TIMEOUT_MS,
      coldTimeoutMs: PROBE_COLD_TIMEOUT_MS,
      replyId,
      precondition: () => (isLinux
        ? 'not needed on Linux - smaps_rollup reports Pss directly'
        : null),
      missingHint: (binary) => (binary.includes('resources')
        ? `helper missing from this build: ${binary}`
        : 'tools/mem-probe not built (npm run build:memprobe)'),
      log
    });
    /** null until the helper has been asked; then true/false. */
    this.canMeasure = null;
    this.mechanism = null;
    /** How measurements have failed, by kind. See `noteFailure`. */
    this.failures = new Map();
  }

  /** `{ pssBytes, privateBytes }`, or null if this pid could not be measured. */
  async measure(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (this.canMeasure === false) return null;

    const reply = await this.request(`measure ${pid}`);
    if (!reply || reply === HELPER_GONE) {
      this.noteFailure(reply === HELPER_GONE ? 'gone' : 'timeout');
      return null;
    }

    const parts = reply.split(' ');
    if (parts[0] !== 'ok') {
      // The helper says why, and until now that answer was thrown away - so a
      // browser measuring none of its renderers looked exactly like a browser
      // with no helper at all, and the panel could only say "summed". The code
      // is the operating system's own: 5 is access denied, which is what an
      // Untrusted renderer returns to the wrong access mask.
      this.noteFailure(parts[0] === 'err' ? `os ${parts[2]}` : 'unparsed');
      return null;
    }
    const pssBytes = Number(parts[2]);
    const privateBytes = Number(parts[3]);
    if (!Number.isFinite(pssBytes) || pssBytes <= 0) {
      this.noteFailure('nonsense');
      return null;
    }
    return { pssBytes, privateBytes: Number.isFinite(privateBytes) ? privateBytes : 0 };
  }

  /**
   * Tally why measurements fail, by kind rather than by pid.
   *
   * Per-pid would be a map that grows with every renderer the browser has ever
   * had; the question anyone actually asks is "why is this not being measured",
   * and the answer is the same for all thirty of them.
   */
  noteFailure(kind) {
    this.failures.set(kind, (this.failures.get(kind) || 0) + 1);
  }

  /** The failure kinds seen so far, commonest first. */
  failureSummary() {
    return [...this.failures.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([kind, count]) => ({ kind, count }));
  }

  /** `{available, mechanism, reason}`, in the shape every capability uses. */
  async capability() {
    if (this.canMeasure !== null) {
      return { available: this.canMeasure, mechanism: this.mechanism, reason: this.reason };
    }
    const reply = await this.request('caps');
    if (reply === HELPER_GONE) {
      // No helper, and a named reason for it. Permanent.
      this.canMeasure = false;
      return { available: false, mechanism: null, reason: this.reason || 'helper unavailable' };
    }
    if (!reply) {
      // A timeout is not a verdict. The helper may simply have been slow to
      // start - 400ms is a tight budget for a cold process - and latching the
      // capability off here would disable native measurement for the rest of
      // the session on the strength of one slow reply. Left unlatched so the
      // next tick asks again.
      return { available: false, mechanism: null, reason: 'helper did not answer in time' };
    }
    // `caps <mechanism> <0|1>`
    const [, mechanism, supported] = reply.split(' ');
    this.mechanism = mechanism || null;
    this.canMeasure = supported === '1';
    if (!this.canMeasure && !this.reason) {
      this.reason = `no measurement backend built for ${PLATFORM}`;
    }
    return { available: this.canMeasure, mechanism: this.mechanism, reason: this.canMeasure ? null : this.reason };
  }
}

let measureHelper = null;
function getMeasureHelper(log) {
  if (!measureHelper) measureHelper = new MeasureHelper(log);
  return measureHelper;
}

function measureProcess(pid, log) {
  return getMeasureHelper(log).measure(pid);
}

function probeBinaryPath() {
  return PROBE_BINARY;
}

function measureCapability(log) {
  return getMeasureHelper(log).capability();
}

/** Why measurements are failing, if they are. Commonest kind first. */
function measureFailures() {
  return measureHelper ? measureHelper.failureSummary() : [];
}

function stopMeasureHelper() {
  if (measureHelper) measureHelper.stop();
}

function trimProcessMemory(pid, log) {
  return trimHelper(log).trim(pid);
}

/**
 * Undo a trim. A no-op on Linux, where MADV_PAGEOUT is one-shot and the pages
 * fault back on their own - kept so the promotion path reads the same on every
 * platform, and because the macOS approach (marking the process background)
 * would genuinely need undoing or a restored tab stays throttled and janky.
 *
 * It does clear the trim cooldown, which is the one piece of state a promotion
 * genuinely invalidates on every platform.
 */
function untrimProcessMemory(pid) {
  if (helper && pid) helper.forget(pid);
  return true;
}

/**
 * How long until `pid` may be trimmed again after a refusal, in milliseconds;
 * 0 when it is free to try. Read by the governor so a renderer the kernel will
 * not trim is not walked down to HIBERNATED every tick just to be turned back.
 */
function trimBackoffMs(pid) {
  return helper && pid ? helper.backoffMs(pid) : 0;
}

/**
 * Forget everything about a process that has exited. Pids are recycled, and a
 * new renderer landing on a dead one's pid must not inherit its backoff.
 */
function forgetProcess(pid) {
  if (helper && pid) helper.forgetProcess(pid);
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

  // Windows needs no second condition, and that is a real difference rather
  // than a shortcut. Its compression store lives in physical memory, so a
  // trimmed page has somewhere to go whether or not a pagefile is configured -
  // where Linux with no swap has nowhere at all and the syscall succeeds having
  // done nothing. The pagefile figure is still reported, because it is what
  // decides whether pages that *cannot* be compressed have a home.
  if (isWindows) {
    const mem = await availableMemory(log);
    const pagefileMB = mem ? Math.round(mem.backingTotalBytes / MB) : 0;
    return {
      available: permitted,
      permitted,
      mechanism: permitted ? 'SetProcessWorkingSetSizeEx -> Windows Memory Compression' : null,
      reason: permitted ? null : (h.reason || `not implemented on ${PLATFORM}`),
      compression: {
        available: permitted,
        applicable: true,
        compressor: 'windows memory compression',
        swapMB: pagefileMB,
        zramMB: 0
      }
    };
  }

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
function chromiumSwitches(cfg, incognito = null) {
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
  //   --disk-cache-size, --media-cache-size
  //                           the theory was that Chromium sizes these from the
  //                           host's RAM and disk, so a machine with plenty of
  //                           both pays for caches it never fills - and that
  //                           bounding them would come off the fixed overhead,
  //                           which is the largest line in the budget and the
  //                           one that decides the tab count at which per-tab
  //                           memory gets good. Measured at 8MB and 4MB against
  //                           the defaults over the 14-tab suite: 243MB and
  //                           243MB of browser+GPU+utility overhead, against
  //                           242MB and 240MB unset. No win, and marginally the
  //                           wrong way, which is noise. The caveat worth
  //                           keeping: that workload fetches a handful of small
  //                           pages from a local fixture server, so it says
  //                           nothing about a browser that has been reading the
  //                           web for an hour. Worth re-measuring against a
  //                           long session before anyone concludes the idea is
  //                           dead - but not worth shipping on a hunch.
  // One `--js-flags`, whatever goes into it: Chromium keeps the last value of a
  // repeated switch, so incognito's compiler flags appended separately would
  // have silently replaced this one, or been replaced by it.
  const jsFlags = cfg.optimizeForSize ? ['--optimize-for-size'] : [];
  if (incognito) {
    const mode = require('./incognito/mode');
    jsFlags.push(...(mode.JS_LEVELS[incognito.jsLevel] || []));
    switches.push(...mode.switches(incognito));
  }
  if (jsFlags.length) switches.push(['js-flags', jsFlags.join(' ')]);

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
  measureProcess, measureCapability, measureFailures, stopMeasureHelper, probeBinaryPath,
  PLATFORM,
  isLinux,
  isMac,
  isWindows,
  setProcessPriority,
  getProcessPriority,
  trimProcessMemory,
  untrimProcessMemory,
  trimBackoffMs,
  forgetProcess,
  trimCapability,
  availableMemory,
  stopTrimHelper,
  canRaisePriority,
  clampPriority,
  runningRootUnsandboxed,
  recommendedBudgetMB,
  recommendedLiveTabs,
  systemInfo,
  chromiumSwitches,
  helperPath
};
