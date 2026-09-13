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

/** How the numbers on this host should be described. */
function accountingMode() {
  return detectPss() ? 'pss' : 'rss';
}

module.exports = { footprintMB, readProcessMemory, accountingMode, detectPss };
