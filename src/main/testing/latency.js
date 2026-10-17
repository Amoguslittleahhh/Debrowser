'use strict';

/**
 * Latency guard rails for reclaim.
 *
 * Every memory lever in this browser is a trade against responsiveness, and
 * until now only one side of that trade was measured. The governor reports
 * megabytes reclaimed to two decimal places and says nothing at all about what
 * the user waited for, which makes it very easy to ship a change that looks
 * like a win and feels like a regression.
 *
 * The asymmetry matters most for discard. Freezing and unfreezing cost a CDP
 * round trip; discarding costs a page load, and that is the only reclaim here
 * the user can perceive. So the numbers this file collects are what decide how
 * aggressive the reclaim policy is allowed to be - not the other way round.
 *
 * Three series, each answering a different question:
 *
 *   restore     activating a tab whose renderer was destroyed, until it is on
 *               screen. The headline cost of discarding.
 *   switch      activating a tab that still had its renderer. The floor - what
 *               a tab switch costs when nothing was reclaimed - and the thing
 *               `restore` should be compared against, since a user notices the
 *               difference between them rather than the absolute figure.
 *   content     activation until the restored page has finished loading. Longer
 *               than `restore` by design: a placeholder can put something on
 *               screen long before the page is ready.
 *
 * Percentiles rather than a mean, because a mean hides exactly the failure this
 * is meant to catch. Twenty fast restores and one that took four seconds is not
 * a good experience, and averages to a good number.
 */

/**
 * How many samples each series keeps. Small on purpose: this is a live guard
 * rail read from the task manager, not a profiler. A few dozen samples is
 * enough for a stable p50 and an indicative p95, and it bounds the memory a
 * memory-management feature spends on measuring itself.
 */
const CAPACITY = 64;

class LatencyTracker {
  constructor(capacity = CAPACITY) {
    this.capacity = capacity;
    /** @type {Map<string, number[]>} */
    this.series = new Map();
  }

  /**
   * Begin timing. Returns the stop function, which is a no-op after the first
   * call, so a caller with several exit paths can invoke it on all of them
   * without double-counting.
   *
   * @param {string} name
   * @returns {(alternateName?: string) => number|null} ms elapsed, or null if
   *   already stopped. The optional name lets a caller decide which series a
   *   sample belongs to only once it knows - an activation does not know
   *   whether it is a restore or a switch until it has looked at the tab.
   */
  start(name) {
    const began = process.hrtime.bigint();
    let stopped = false;
    return (alternateName) => {
      if (stopped) return null;
      stopped = true;
      const ms = Number(process.hrtime.bigint() - began) / 1e6;
      this.record(alternateName || name, ms);
      return ms;
    };
  }

  record(name, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    let samples = this.series.get(name);
    if (!samples) {
      samples = [];
      this.series.set(name, samples);
    }
    samples.push(ms);
    if (samples.length > this.capacity) samples.shift();
  }

  /**
   * @param {string} name
   * @returns {{n:number, p50:number, p95:number, max:number}|null}
   */
  percentiles(name) {
    const samples = this.series.get(name);
    if (!samples || !samples.length) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      n: sorted.length,
      p50: round(quantile(sorted, 0.5)),
      p95: round(quantile(sorted, 0.95)),
      max: round(sorted[sorted.length - 1])
    };
  }

  /** Every series, shaped for the task manager and the smoke suite. */
  stats() {
    const out = {};
    for (const name of this.series.keys()) out[name] = this.percentiles(name);
    return out;
  }

  reset() {
    this.series.clear();
  }
}

/**
 * Nearest-rank quantile on an already-sorted array.
 *
 * Deliberately not interpolated. With a few dozen samples an interpolated p95
 * invents a value between two real measurements, and the whole point of this
 * series is to report a duration something actually took.
 */
function quantile(sorted, q) {
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const round = (ms) => Math.round(ms * 10) / 10;

module.exports = { LatencyTracker };
