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
 */

const { Tier } = require('../config');

/**
 * Collection speed to assume before a tab has been observed collecting, in
 * bytes per second. V8 mark-compact throughput on a desktop core is of this
 * order; it is only a starting value and is replaced by measurement.
 */
const DEFAULT_GC_SPEED = 80 * 1024 * 1024;

/** Allocation rate below which a tab is treated as not allocating at all. */
const MIN_ALLOC_RATE = 64 * 1024; // bytes/sec

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
    if (!this.cfg.heapLimit.enabled) return false;
    if (!tab.isLive || !tab.cdp) return false;
    if (tab.visible) return false;              // never stall the foreground tab
    if (tab.tier === Tier.FROZEN) return false; // frozen: no allocation, no point
    if (tab.boosted) return false;
    // Private bytes, not the PSS footprint. PSS for one process falls as more
    // processes come to share the binary, so thresholding on it meant the same
    // tab qualified or not depending on how many other tabs were open - and with
    // per-site renderers every tab sat below the threshold, so this pass never
    // ran at all and the whole rule was dead code.
    return (tab.privateMB || 0) >= this.cfg.heapLimit.minPrivateMB;
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
        tab.allocRateBytesPerSec = tab.allocRateBytesPerSec
          ? tab.allocRateBytesPerSec * 0.7 + rate * 0.3
          : rate;
      }
    }

    tab.lastHeapBytes = heapBytes;
    tab.lastHeapAt = now;

    // Live memory is only knowable just after a collection; until this tab has
    // been collected once, its current heap is the best available upper bound.
    if (tab.liveHeapBytes == null) tab.liveHeapBytes = heapBytes;
  }

  /**
   * Record what a collection achieved, giving us L exactly and s by observation.
   */
  recordCollection(tab, beforeBytes, afterBytes, durationMs) {
    tab.liveHeapBytes = afterBytes;
    tab.lastHeapBytes = afterBytes;

    const freed = beforeBytes - afterBytes;
    if (freed > 0 && durationMs > 0) {
      // Collection speed as bytes handled per second. Using bytes freed rather
      // than bytes traversed understates s for a mostly-live heap, which biases
      // the limit upward - the safe direction, since it means collecting less
      // often rather than more.
      const speed = (freed * 1000) / durationMs;
      tab.gcSpeedBytesPerSec = tab.gcSpeedBytesPerSec
        ? tab.gcSpeedBytesPerSec * 0.7 + speed * 0.3
        : speed;
    }

    tab.heapBacklogCollected = true;
    this.collections += 1;
    if (freed > 0) this.reclaimedMB += freed / (1024 * 1024);
  }

  /**
   * Whether this tab is still holding the garbage it produced while loading.
   *
   * This is a separate question from the heap limit, and it is the one that
   * actually pays on a normal browsing session. The square-root rule governs the
   * *steady state*: it hands a tab headroom in proportion to how fast it
   * allocates, and collects when the tab grows into that headroom. A hidden tab
   * that has finished loading and sits idle allocates nothing, so it is given
   * ~0.3MB of headroom, never grows into it, and is correctly never collected -
   * there is no garbage to collect.
   *
   * But parsing and executing a page *does* produce a large one-time backlog,
   * and V8 is in no hurry to collect it once the page goes quiet. That backlog
   * is what the -6.8MB measurement on a DOM-heavy page was actually reclaiming.
   * So it gets its own one-shot trigger, fired once per load rather than on a
   * limit, and reset whenever the tab navigates.
   */
  hasLoadBacklog(tab) {
    return !tab.heapBacklogCollected;
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

  /** Human-readable state, for the task manager. */
  describe(tab) {
    const limit = this.limitFor(tab);
    if (!limit) return null;
    return {
      heapMB: Math.round((tab.heapTotalBytes || 0) / (1024 * 1024)),
      limitMB: Math.round(limit / (1024 * 1024)),
      liveMB: Math.round((tab.liveHeapBytes || 0) / (1024 * 1024))
    };
  }

  stats() {
    return { collections: this.collections, heapReclaimedMB: Math.round(this.reclaimedMB) };
  }
}

module.exports = { HeapLimiter, DEFAULT_GC_SPEED };
