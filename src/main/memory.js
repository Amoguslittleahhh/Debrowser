'use strict';

/**
 * Honest per-process memory accounting.
 *
 * Everything in this project used to be measured with Electron's
 * `getAppMetrics().memory.workingSetSize`, which is resident set size. RSS
 * counts every page a process has resident, *including pages shared with other
 * processes* - and in a Chromium browser the largest single mapping is the
 * executable itself, mapped into every renderer. Summing RSS across processes
 * therefore counts that once per process.
 *
 * The scale of the error, measured on six tabs of a trivial page:
 *
 *     summed RSS   810 MB
 *     summed PSS   247 MB
 *
 * So "six tabs cost 810 MB" was wrong by a factor of three, and "a tab costs
 * 86 MB" was really "a tab costs 20 MB plus its share of one copy of Chromium".
 *
 * PSS (proportional set size) divides each shared page by the number of
 * processes mapping it, so summing PSS across processes gives a figure that
 * corresponds to actual physical memory. That is the number a memory budget
 * should be compared against, and the number to quote.
 *
 * PSS is a Linux concept, exposed through `/proc/<pid>/smaps_rollup`. On macOS
 * and Windows there is no cheap equivalent, so this falls back to RSS and says
 * so - a budget there is conservative (it over-counts) rather than wrong in the
 * dangerous direction.
 */

const fs = require('fs');
const { MB } = require('./config');

const isLinux = process.platform === 'linux';

/** Whether proportional accounting is available on this host. */
let pssAvailable = null;

function detectPss() {
  if (pssAvailable !== null) return pssAvailable;
  if (!isLinux) {
    pssAvailable = false;
    return pssAvailable;
  }
  try {
    // smaps_rollup is a single pre-aggregated summary, unlike smaps which has
    // one block per mapping and is genuinely expensive to parse.
    const text = fs.readFileSync(`/proc/${process.pid}/smaps_rollup`, 'utf8');
    pssAvailable = /^Pss:/m.test(text);
  } catch {
    pssAvailable = false;
  }
  return pssAvailable;
}

const FIELD = /^(\w+):\s+(\d+) kB$/gm;

/**
 * Read one process's memory breakdown.
 * @returns {{pssMB:number, rssMB:number, privateMB:number}|null}
 */
function readProcessMemory(pid) {
  if (!detectPss()) return null;
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
  } catch {
    // The process exited between listing and reading; the caller treats a null
    // as "no reading this tick" rather than as zero.
    return null;
  }

  const values = Object.create(null);
  FIELD.lastIndex = 0;
  let match;
  while ((match = FIELD.exec(text)) !== null) {
    values[match[1]] = Number(match[2]) / 1024;
  }

  if (values.Pss === undefined) return null;
  return {
    pssMB: values.Pss,
    rssMB: values.Rss ?? 0,
    privateMB: (values.Private_Clean ?? 0) + (values.Private_Dirty ?? 0)
  };
}

/**
 * Best available footprint for a process, in MB, with the RSS figure Electron
 * already gave us as the fallback.
 *
 * @param {number} pid
 * @param {number} rssFallbackMB
 */
function footprintMB(pid, rssFallbackMB) {
  const detail = readProcessMemory(pid);
  return detail ? detail.pssMB : rssFallbackMB;
}

/*
 * A note for callers that want more than one figure: use `readProcessMemory`
 * directly. It returns pss, rss and private from a single read, and the hot
 * path does want all of them - an earlier version had a thin per-field wrapper
 * beside this one, so the governor read and regex-parsed smaps_rollup twice per
 * process per tick, and the two figures came from different instants while
 * being reported as one sample.
 */

/* ------------------------------------------------------------------ */
/* Page merging (KSM)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Whether this process tree is eligible for kernel same-page merging, and what
 * the kernel reckons it has saved.
 *
 * Two independent conditions have to hold, and reporting them separately
 * matters because the failure modes look identical from the outside:
 *
 *   processMergeable  this process opted in, via prctl(PR_SET_MEMORY_MERGE)
 *                     before exec - see tools/ksm-launch.c. Detected by looking
 *                     for the `mg` VmFlag, since prctl cannot be called from
 *                     Node and the flag is what KSM actually keys on.
 *   ksmRunning        the kernel's scanner is enabled system-wide, which needs
 *                     root and is off by default on essentially every distro.
 *
 * `profitMB` is KSM's own accounting of what merging has saved, across the whole
 * system rather than just this browser - useful as a corroborating signal next
 * to our own PSS measurement, not as a figure to attribute to ourselves.
 */
/** Memoised: the `mg` flag is set before exec and cannot change afterwards. */
let processMergeableCache = null;

function processMergeable() {
  if (processMergeableCache !== null) return processMergeableCache;
  if (!isLinux) {
    processMergeableCache = false;
    return processMergeableCache;
  }
  try {
    // VmFlags carries `mg` on every region KSM is allowed to consider. This is
    // the full per-VMA smaps rather than smaps_rollup, which does not carry
    // VmFlags - and it is genuinely expensive to parse on a process with as
    // many mappings as a browser, which is exactly why it is read once per
    // process lifetime and not per governor tick.
    processMergeableCache =
      /^VmFlags:.*\bmg\b/m.test(fs.readFileSync(`/proc/${process.pid}/smaps`, 'utf8'));
  } catch {
    processMergeableCache = false;
  }
  return processMergeableCache;
}

function pageMergingStatus() {
  // Asked on every governor tick, so the expensive half is memoised above and
  // the cheap sysfs reads are skipped entirely when merging cannot happen -
  // which is the default configuration, where this result is discarded.
  if (!processMergeable()) {
    return { processMergeable: false, ksmRunning: false, profitMB: null, active: false };
  }

  const sysfs = (name) => {
    try {
      return Number(fs.readFileSync(`/sys/kernel/mm/ksm/${name}`, 'utf8').trim());
    } catch {
      return null;
    }
  };

  const run = sysfs('run');
  const profit = sysfs('general_profit');

  return {
    processMergeable: true,
    ksmRunning: run === 1,
    profitMB: profit == null ? null : Math.round(profit / MB),
    // Merging only actually happens when both halves are true.
    active: run === 1
  };
}

/* ------------------------------------------------------------------ */
/* Processes Electron does not report                                   */
/* ------------------------------------------------------------------ */

/**
 * Memory held by child processes that `app.getAppMetrics()` leaves out.
 *
 * Electron's process list is not the whole browser. On Linux, Chromium forks
 * two **zygote** processes - a pre-initialised template that every renderer is
 * forked from, which is why launching a renderer is fast - and neither appears
 * in `getAppMetrics()`. Measured on a minimal harness (one `about:blank` view):
 *
 *     getAppMetrics total   167 MB across 4 processes
 *     /proc descendant sweep 196 MB across 6 processes
 *     difference            two zygotes, 14.4 MB + 14.5 MB
 *
 * Roughly 29 MB, and it is *fixed* overhead: it does not grow with tab count,
 * so it lands entirely on the wrong side of a per-tab budget. Every figure this
 * project has published came through `getAppMetrics()` and is low by that much
 * - the same shape of error as counting RSS instead of PSS, and corrected here
 * for the same reason.
 *
 * Linux only, deliberately. The zygote is a Linux/Android implementation detail;
 * on Windows and macOS `getAppMetrics()` is the whole tree, so this returns 0
 * and the caller's arithmetic is unchanged.
 *
 * @param {Set<number>|number[]} knownPids - pids `getAppMetrics()` did report
 * @returns {{mb:number, processes:Array<{pid:number,type:string,pssMB:number}>}}
 */
/**
 * Discovery is memoised because it is genuinely expensive - it reads every
 * entry in /proc and parses each one's stat - and the answer is near-static:
 * the zygotes are forked once at startup and live as long as the browser. The
 * governor asks for this figure every tick, so a full scan each time would cost
 * far more than the accounting it corrects.
 *
 * The cache holds pids, not megabytes: each call still re-reads those
 * processes' current memory. It is rebuilt when a cached process has exited, or
 * every RESCAN_MS in case something new appeared.
 */
let unreportedPidCache = null;
let unreportedScannedAt = 0;
const RESCAN_MS = 30_000;

function unreportedProcessesMB(knownPids) {
  const empty = { mb: 0, processes: [] };
  if (!detectPss()) return empty;

  const known = knownPids instanceof Set ? knownPids : new Set(knownPids);
  const now = Date.now();

  const stale = unreportedPidCache === null
    || now - unreportedScannedAt > RESCAN_MS
    || unreportedPidCache.some((pid) => !fs.existsSync(`/proc/${pid}`));

  if (stale) {
    unreportedPidCache = scanTreeForUnreported(known);
    unreportedScannedAt = now;
  }

  const processes = [];
  let mb = 0;
  for (const pid of unreportedPidCache) {
    // A pid that has since been reported by getAppMetrics must not be counted
    // twice; the scan excluded the set known at scan time, not at read time.
    if (known.has(pid)) continue;
    const detail = readProcessMemory(pid);
    if (!detail) continue;
    mb += detail.pssMB;
    processes.push({ pid, type: processType(pid), pssMB: Math.round(detail.pssMB * 10) / 10 });
  }
  return { mb, processes };
}

/** The expensive half: every descendant of this process not in `known`. */
function scanTreeForUnreported(known) {
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }

  // Walk parent links to find this process's descendants. Repeated until the
  // set stops growing, because /proc is not ordered parent-before-child and a
  // grandchild can otherwise be missed on the first pass.
  const tree = new Set([process.pid]);
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const entry of entries) {
      const pid = Number(entry);
      if (!pid || tree.has(pid)) continue;
      const ppid = parentPid(pid);
      if (ppid !== null && tree.has(ppid)) {
        tree.add(pid);
        grew = true;
      }
    }
    if (!grew) break;
  }

  return [...tree].filter((pid) => pid !== process.pid && !known.has(pid));
}

/** Parent pid from /proc/<pid>/stat, skipping past the comm field's parens. */
function parentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm is the second field and may itself contain spaces or parens, so the
    // fields after it are found from the *last* ')' rather than by splitting.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(after[1]);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/** Chromium's own name for a process, from its `--type=` switch. */
function processType(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return (/--type=([a-z-]+)/.exec(cmdline) || [, 'untyped'])[1];
  } catch {
    return 'unknown';
  }
}

/** How the numbers on this host should be described. */
function accountingMode() {
  return detectPss() ? 'pss' : 'rss';
}

module.exports = {
  footprintMB, readProcessMemory, accountingMode, detectPss, pageMergingStatus,
  unreportedProcessesMB
};
