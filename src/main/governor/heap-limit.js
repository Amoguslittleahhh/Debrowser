'use strict';

/**
 * Per-tab heap limits, after the square-root rule of Kirisame, Shenoy and
 * Panchekha, "Optimal Heap Limits for Reducing Browser Memory Use"
 * (OOPSLA 2022, arXiv:2204.10455).
 *
 * The problem the paper solves is the one this governor kept getting wrong. A
 * heap limit trades memory against garbage-collection time, and the obvious
 * rules - a fixed limit, or a multiple of live size - are *not compositional*:
 * with several heaps, the same multiplier produces an allocation of memory
 * across those heaps that does not minimise total GC time. Their result is that
 * the optimal limit for each heap is
 *
 *     M = L + sqrt(L * g / (c * s))
 *
 * where L is live memory, g the allocation rate, s the collection speed, and c
 * a single constant shared by every heap. Every term but c is local, so each
 * tab computes its own limit and the allocation across tabs still comes out
 * optimal - "coordination without communication". Memory goes preferentially to
 * tabs that are big, allocating fast, or slow to collect, but as the *square
 * root* rather than in proportion, which is what makes the total optimal.
 *
 * Their prototype (MemBalancer) patches V8 and reports ~16% less memory at
 * constant GC time on real pages.
 *
 * What is different here, and why this is an approximation rather than that
 * result: we cannot set a V8 heap limit from outside the renderer. There is no
 * such control in Electron's API or the DevTools protocol. So the rule is used
 * the other way round - as the *trigger* for a collection we request ourselves.
 * A heap limit and "collect when the heap passes this size" are the same policy
 * seen from two sides; what we lose is that V8 would have scheduled its own
 * collection more cheaply than we can ask for one.
 *
 * That asking price is the reason this is gated rather than applied everywhere.
 * Requesting a collection needs a debugger session, which costs about 2.4MB of
 * proportional set size in the renderer. Measured net effect of collecting one
 * hidden tab:
 *
 *     light page      +7.1 MB    the session costs more than the GC reclaims
 *     DOM-heavy page  -6.8 MB    clear win
 *
 * So the rule decides *when*, and a cheap screen on a tab's *private* memory
 * decides *who* is even worth measuring - the measurement is the expensive
 * part, and private bytes are free to read from the OS. Private rather than PSS
 * because PSS for one process falls as more processes come to share the binary,
 * so a PSS threshold would qualify the same tab or not depending on how many
 * other tabs happened to be open.
 *
 * One known imprecision, left in deliberately. L in the paper is the *live* set,
 * which we can only read immediately after a collection (`JSHeapUsedSize`), but
 * M bounds the heap's *committed* size (`JSHeapTotalSize`) because that is what
 * costs memory and what we can compare against on every tick. V8 keeps committed
 * well above live, so for a hidden tab - where `backgroundWeight` tightens the
 * limit further - the comparison is frequently true from the moment the page
 * settles, and the rule degenerates from "collect when the heap has grown" to
 * "collect on the collection interval". That is the behaviour the interval floor
 * exists to bound, and it is also why the rule is off by default: the amount it
 * has to reclaim in this browser does not justify sharpening this. Fixing it
 * properly means tracking committed-above-live as its own term, which the paper
 * does not model.
 */

const { isStopped, MB } = require('../config');

/**
 * Collection speed to assume before a tab has been observed collecting, in
 * bytes per second. V8 mark-compact throughput on a desktop core is of this
 * order; it is only a starting value and is replaced by measurement.
 */
const DEFAULT_GC_SPEED = 80 * MB;

/** Allocation rate below which a tab is treated as not allocating at all. */
const MIN_ALLOC_RATE = 64 * 1024; // bytes/sec

/**
 * Smoothing weight for the per-tab estimates. A single interval catches whatever
 * the page happened to be doing, so both `g` and `s` are averaged.
 */
const EMA_ALPHA = 0.3;

/** Exponential moving average, seeded by the first sample. */
const ema = (prev, sample, alpha = EMA_ALPHA) =>
  (prev == null ? sample : prev + alpha * (sample - prev));

class HeapLimiter {
  /**
   * @param {object} cfg
   * @param {(...args:any[]) => void} log
   */
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.collections = 0;
    this.reclaimedMB = 0;
  }

  /**
   * The square-root rule: the heap size at which this tab should be collected.
   *
   * @param {object} tab
   * @returns {number|null} limit in bytes, or null if not yet measurable
   */
  limitFor(tab) {
    const live = tab.liveHeapBytes;              // L
    if (!live || live <= 0) return null;

    const alloc = Math.max(tab.allocRateBytesPerSec || 0, MIN_ALLOC_RATE); // g
    const speed = tab.gcSpeedBytesPerSec || DEFAULT_GC_SPEED;              // s

    // c is shared across tabs, which is what makes the allocation optimal. The
    // paper notes it may be *weighted* per tab as long as the weighting is the
    // same function everywhere: a tab whose GC time matters less should get a
    // proportionally larger c, and so a tighter limit. A background tab's pause
    // is invisible, so that is exactly where to spend GC time instead of memory.
    const c = this.cfg.heapLimit.c * this.weightFor(tab);

    return live + Math.sqrt((live * alloc) / (c * speed));
  }

  /**
   * Multiplier on c. Higher means a tighter heap limit, so more collections and
   * less memory.
   */
  weightFor(tab) {
    if (tab.visible) return 1;
    // Hidden: its collection pauses cost the user nothing.
    return this.cfg.heapLimit.backgroundWeight;
  }

  /**
   * Is this tab worth instrumenting at all?
   *
   * Deliberately decided from a *free* signal the OS already gave us, before
   * spending a debugger session to learn the heap. A
   * tab too small for a collection to pay for the session is never measured, so
   * the policy cannot cost more than it saves on a browser full of light pages.
   */
  worthMeasuring(tab) {
    // `heapLimit.enabled` is checked by the caller, which skips the whole pass.
    if (!tab.isLive || !tab.cdp) return false;
    if (tab.visible) return false;              // never stall the foreground tab
    if (isStopped(tab.tier)) return false;       // stopped: no allocation, no point
    if (tab.boosted) return false;

    // Private bytes, not the PSS footprint. PSS for one process falls as more
    // processes come to share the binary, so thresholding on it meant the same
    // tab qualified or not depending on how many other tabs were open - and with
    // per-site renderers every tab sat below the threshold, so this pass never
    // ran at all and the whole rule was dead code.
    //
    // A null reading means the platform cannot report private bytes at all
    // (anything but Linux). Without a cheap screen there is no way to tell a
    // tab worth instrumenting from one where the session costs more than the
    // collection returns, so decline rather than guess.
    if (tab.privateMB == null) return false;
    return tab.privateMB >= this.cfg.heapLimit.minPrivateMB;
  }

  /**
   * Fold a fresh heap reading into a tab's L, g and s estimates.
   *
   * @param {object} tab
   * @param {number} heapBytes  JSHeapUsedSize now
   * @param {number} now        timestamp
   */
  observe(tab, heapBytes, now, totalBytes = null) {
    if (totalBytes != null) tab.heapTotalBytes = totalBytes;
    const prevHeap = tab.lastHeapBytes;
    const prevAt = tab.lastHeapAt;

    if (prevHeap != null && prevAt && now > prevAt) {
      const grew = heapBytes - prevHeap;
      if (grew > 0) {
        // Allocation rate. Smoothed, because a single interval catches whatever
        // the page happened to be doing.
        const rate = (grew * 1000) / (now - prevAt);
        tab.allocRateBytesPerSec = ema(tab.allocRateBytesPerSec, rate);
      }
    }

    tab.lastHeapBytes = heapBytes;
    tab.lastHeapAt = now;

    // Live memory is only knowable just after a collection; until this tab has
    // been collected once, its current heap is the best available upper bound.
    if (tab.liveHeapBytes == null) tab.liveHeapBytes = heapBytes;
  }

  /**
   * Record what a collection achieved: L exactly, and s by observation.
   *
   * This is the only writer of a tab's heap estimates, alongside `observe`.
   * An earlier version had the governor assign `liveHeapBytes` itself and then
   * call this, which promptly overwrote it - so the assignment was dead and `L`
   * ended up holding the committed size rather than the live set, contradicting
   * both call sites' comments. One owner per invariant avoids that.
   *
   * @param {object} tab
   * @param {{beforeTotal:number, afterTotal:number, afterUsed:number|null, durationMs:number}} result
   */
  recordCollection(tab, { beforeTotal, afterTotal, afterUsed, durationMs }) {
    // L is the live set measured immediately after collecting - the *used*
    // figure, not the committed one.
    if (afterUsed != null) tab.liveHeapBytes = afterUsed;
    tab.heapTotalBytes = afterTotal;
    tab.lastHeapBytes = afterUsed ?? afterTotal;

    const freed = beforeTotal - afterTotal;
    if (freed > 0 && durationMs > 0) {
      // Collection speed as bytes handled per second. Using bytes freed rather
      // than bytes traversed understates s for a mostly-live heap, which biases
      // the limit upward - the safe direction, since it means collecting less
      // often rather than more.
      tab.gcSpeedBytesPerSec = ema(tab.gcSpeedBytesPerSec, (freed * 1000) / durationMs);
    }

    tab.heapBacklogCollected = true;
    this.collections += 1;
    if (freed > 0) this.reclaimedMB += freed / MB;
  }

  /**
   * Whether this tab's heap has passed its limit.
   *
   * Compared against the heap's *total* (committed) size, not its used size.
   * That is what a heap limit bounds - M in the rule is a ceiling on how large
   * the heap may grow before being collected, while L is the live set inside it.
   * An earlier version compared the used size, which is the one number a
   * collection barely changes: a settled page can report 1MB used against 20MB
   * committed, so the limit was never exceeded and the rule never acted.
   */
  isOverLimit(tab) {
    const limit = this.limitFor(tab);
    if (!limit) return false;
    const size = tab.heapTotalBytes || tab.lastHeapBytes || 0;
    return size > limit;
  }

  stats() {
    return { heapCollections: this.collections, heapReclaimedMB: Math.round(this.reclaimedMB) };
  }
}

module.exports = { HeapLimiter, DEFAULT_GC_SPEED };
