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
const { MB } = require('./config');

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
 * Renderer process ceiling scaled to the machine. Each renderer carries a
 * fixed overhead (V8 isolate, Blink globals, IPC plumbing) of roughly 25-40MB
 * before it renders anything, so on small machines capping the count saves
 * more than any per-page trimming can.
 */
function recommendedRendererLimit() {
  const totalMB = Math.round(os.totalmem() / MB);
  const cores = os.cpus()?.length || 4;
  if (totalMB <= 4096) return Math.max(3, Math.min(6, cores));
  if (totalMB <= 8192) return Math.max(6, Math.min(10, cores * 2));
  return 0; // 0 = no explicit cap; let Chromium's own heuristic run
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

  const rendererLimit = cfg.rendererProcessLimit || recommendedRendererLimit();
  if (rendererLimit > 0) {
    switches.push(['renderer-process-limit', String(rendererLimit)]);
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

  // Cap V8's young generation. The scavenger's semi-spaces are sized for
  // throughput on a machine with memory to spare; on a browser holding dozens
  // of idle tabs the untouched half of each semi-space is pure waste.
  const semiSpaceMB = cfg.memoryBudgetMB <= 900 ? 8 : 16;
  switches.push(['js-flags', `--max-semi-space-size=${semiSpaceMB}`]);

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
  canRaisePriority,
  clampPriority,
  runningRootUnsandboxed,
  recommendedBudgetMB,
  recommendedRendererLimit,
  systemMemoryPressure,
  systemInfo,
  chromiumSwitches
};
