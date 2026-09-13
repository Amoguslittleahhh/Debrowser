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

/** How the numbers on this host should be described. */
function accountingMode() {
  return detectPss() ? 'pss' : 'rss';
}

module.exports = {
  footprintMB, readProcessMemory, accountingMode, detectPss, pageMergingStatus
};
