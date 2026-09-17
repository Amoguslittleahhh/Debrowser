'use strict';

/**
 * Process metrics sampling and per-tab attribution.
 *
 * Everything the governor decides rests on one awkward fact: memory is owned
 * by *processes*, but policy is applied to *tabs*, and the two do not map one
 * to one. Chromium coalesces same-site tabs into a shared renderer (and the
 * economy profile forces far more of that), so "how much RAM is this tab
 * using" has no direct answer from the OS.
 *
 * Note also that "resident memory" here means proportional set size where the
 * platform provides it, not RSS - see ../memory.js for why that distinction is
 * worth a factor of three.
 *
 * This module resolves that by measuring memory per process and then
 * splitting each process's memory across its tabs in proportion to their JS
 * heap sizes, which *are* per-tab and which we read over CDP. Totals are
 * always summed over unique PIDs, so shared processes are never counted twice
 * against the budget.
 */

const { MB } = require('../config');
const { readProcessMemory, accountingMode, pageMergingStatus,
        unreportedProcessesMB, compressionStatus } = require('../memory');
const platform = require('../platform');

/** Exponential smoothing factor for per-process samples. */
const EMA_ALPHA = 0.35;

/** Overhead attributed to a renderer regardless of page content. */
const RENDERER_BASE_MB = 12;

/**
 * How far below summed working set a proportional total must land to be
 * believed, and how many processes must be running before the question is
 * worth asking. 0.8 is the plan's "moved by less than 20% from summed working
 * set" turned into a runtime check; below four processes there is too little
 * sharing for the comparison to mean anything.
 */
const MAX_PROPORTIONAL_RATIO = 0.8;
const MIN_PIDS_FOR_SHARING = 4;

class Metrics {
  /**
   * @param {Electron.App} app
   * @param {() => Iterable<object>} getTabs - live tab collection
   */
  constructor(app, getTabs) {
    this.app = app;
    this.getTabs = getTabs;
    /** @type {Map<number, {rssMB:number, cpu:number, type:string}>} */
    this.byPid = new Map();
    /**
     * Last figure the native probe returned for each pid, on the platforms that
     * need it. Empty on Linux, where smaps_rollup is read inline.
     * @type {Map<number, {pssMB:number, privateMB:number}>}
     */
    this.probed = new Map();
    /** True while a round of probes is outstanding, so ticks do not stack. */
    this.probing = false;
    this.totalMB = 0;
    this.browserOverheadMB = 0;
    /**
     * Summed working set, kept beside the proportional total rather than
     * replaced by it.
     *
     * A proportional measure is only worth the helper it costs if it lands
     * meaningfully below this. Keeping both is what lets the browser check
     * that instead of assuming it - see `snapshot()`.
     */
    this.rssTotalMB = 0;
    /** Summed private working set, where the platform reports it. */
    this.privateTotalMB = null;
    this.lastSampleAt = 0;
  }

  /**
   * Ask the native probe for this tick's figures, for the next tick to use.
   *
   * Fire and forget on purpose. The sampler is synchronous and runs on the
   * governor's tick; awaiting a child process here would put a pipe read on the
   * critical path of every tier decision. One round at a time, so a slow helper
   * cannot accumulate a backlog of requests for pids that have since exited.
   */
  refreshProbes(raw) {
    if (accountingMode() === 'pss' || this.probing) return;
    this.probing = true;

    // Asked again until it is answered. One timed-out `caps` used to leave this
    // null for the life of the process, and the panel then explained the wrong
    // platform's measurement - a Windows share-count caveat on a Mac.
    if (!this.probeMechanism && !this.askingMechanism) {
      this.askingMechanism = true;
      platform.measureCapability()
        .then((cap) => { if (cap.available) this.probeMechanism = cap.mechanism; })
        .catch(() => { /* try again next tick */ })
        .finally(() => { this.askingMechanism = false; });
    }
    const pids = raw.map((proc) => proc.pid);
    Promise.all(pids.map(async (pid) => {
      const m = await platform.measureProcess(pid);
      if (!m) { this.probed.delete(pid); return; }
      this.probed.set(pid, { pssMB: m.pssBytes / MB, privateMB: m.privateBytes / MB });
    })).catch(() => { /* a failed probe simply leaves the fallback in place */ })
      .finally(() => { this.probing = false; });
  }

  /**
   * Sample every Electron process and attribute the result to tabs.
   * Cheap enough to run on every governor tick: `getAppMetrics` is a single
   * synchronous call into the browser process, not a per-process walk.
   */
  sample() {
    const raw = this.app.getAppMetrics();
    this.refreshProbes(raw);
    const seen = new Set();
    let total = 0;
    let overhead = 0;
    let rssTotal = 0;
    let privateTotal = 0;
    let privateKnown = 0;

    for (const proc of raw) {
      const pid = proc.pid;
      seen.add(pid);

      // `workingSetSize` is kilobytes of RSS, which counts pages shared with
      // other processes - chiefly the Chromium binary, mapped into every
      // renderer. Summing that across processes triple-counts real memory, so
      // prefer proportional set size where the platform offers it. See
      // ../memory.js.
      const rssMB = (proc.memory?.workingSetSize || 0) / 1024;
      // One read per process, not one per figure: smaps_rollup already carries
      // pss, rss and private together, and taking them from the same read also
      // means they describe the same instant.
      const detail = readProcessMemory(pid);
      // Off Linux, `detail` is null and the native probe fills the gap. Its
      // reading is from the previous tick, because the helper is a child
      // process and this sampler is synchronous - a tick may not wait on a
      // pipe. That staleness is bounded by the tick interval and is invisible
      // next to the smoothing every figure here already goes through; blocking
      // the governor for a fresher number would be the worse trade.
      const probed = this.probed.get(pid) || null;
      const footprint = detail ? detail.pssMB : (probed ? probed.pssMB : rssMB);
      const priv = detail ? detail.privateMB : (probed ? probed.privateMB : null);
      const cpu = proc.cpu?.percentCPUUsage || 0;

      const prev = this.byPid.get(pid);
      const smoothed = prev
        ? {
            rssMB: prev.rssMB + EMA_ALPHA * (footprint - prev.rssMB),
            cpu: prev.cpu + EMA_ALPHA * (cpu - prev.cpu),
            type: proc.type
          }
        : { rssMB: footprint, cpu, type: proc.type };
      // Left null where the platform cannot report it, rather than falling back
      // to the footprint. Private bytes and PSS are different quantities, and
      // the one consumer of this field screens on it *because* it is not PSS -
      // substituting one for the other would have silently reinstated the
      // threshold that made that screen useless.
      smoothed.privateMB = priv == null ? (prev?.privateMB ?? null) : priv;

      this.byPid.set(pid, smoothed);
      total += smoothed.rssMB;
      if (proc.type !== 'Tab') overhead += smoothed.rssMB;

      // Unsmoothed on purpose: this is the yardstick the proportional figure is
      // measured against, and smoothing it would let the comparison drift with
      // the thing it is checking.
      rssTotal += rssMB;
      if (smoothed.privateMB != null) {
        privateTotal += smoothed.privateMB;
        privateKnown++;
      }
    }

    // Drop processes that have exited so stale memory never inflates the total.
    // This is also the one place the browser learns that a pid is gone, so it is
    // where the platform layer is told to forget what it knows about it - pids
    // are recycled, and a new renderer must not inherit a dead one's trim
    // cooldown or its refusal backoff.
    for (const pid of this.byPid.keys()) {
      if (seen.has(pid)) continue;
      this.byPid.delete(pid);
      this.probed.delete(pid);
      platform.forgetProcess(pid);
    }

    // Electron's process list is not the whole browser: it omits Chromium's
    // zygotes, ~29MB that does not grow with tab count. Counting them is the
    // difference between a budget compared against this browser's real
    // footprint and one compared against most of it.
    const unreported = unreportedProcessesMB(seen).mb;
    total += unreported;
    overhead += unreported;

    this.totalMB = total;
    this.browserOverheadMB = overhead;
    this.rssTotalMB = rssTotal;
    this.privateTotalMB = privateKnown ? privateTotal : null;
    this.lastSampleAt = Date.now();
    return this.totalMB;
  }

  /**
   * Is the native probe actually delivering a proportional figure?
   *
   * A probe that runs, returns, and covers every process still proves nothing
   * about what it returned. The whole reason for it is that summing working
   * set counts one copy of Chromium in every renderer; if its total is not
   * meaningfully below that sum, it is reporting the same over-count under a
   * better name - and the panel would say "resident" where it used to say
   * "resident (over-counts)", which is worse than the fault it replaced.
   *
   * This check was in the plan for the helper and never written. On Windows,
   * `ShareCount` is three bits wide and saturates at seven, so a page mapped
   * into a hundred processes - every system DLL - is charged at a seventh
   * rather than a hundredth, to each of our processes in turn. That inflates
   * the total in exactly the way the helper exists to prevent, and it looks
   * like success from the inside.
   *
   * Only asked once there are enough processes for sharing to be worth
   * measuring. With one or two, PSS legitimately sits close to RSS because
   * there is little to share, and failing it there would be a false alarm.
   *
   * @returns {boolean}
   */
  probeIsProportional() {
    if (this.byPid.size < MIN_PIDS_FOR_SHARING || this.rssTotalMB <= 0) return true;
    return this.totalMB <= this.rssTotalMB * MAX_PROPORTIONAL_RATIO;
  }

  /**
   * Group live tabs by the renderer process backing them.
   * @returns {Map<number, object[]>}
   */
  tabsByPid() {
    const map = new Map();
    for (const tab of this.getTabs()) {
      const pid = tab.pid;
      if (!pid) continue;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid).push(tab);
    }
    return map;
  }

  /**
   * Attribute process memory down to individual tabs and write the result
   * onto each tab as `rssMB` / `cpu`.
   *
   * Where several tabs share a renderer, the process's memory is split in
   * proportion to each tab's JS heap, with a flat floor per tab for the
   * DOM, compositor tiles and V8 isolate overhead that a heap figure does not
   * capture. This is an estimate, and is treated as one: it decides *relative*
   * ranking between tabs, never an absolute claim shown as fact.
   */
  attribute() {
    const groups = this.tabsByPid();

    for (const [pid, tabs] of groups) {
      const proc = this.byPid.get(pid);
      if (!proc) {
        for (const tab of tabs) { tab.rssMB = 0; tab.cpu = 0; }
        continue;
      }

      if (tabs.length === 1) {
        tabs[0].rssMB = proc.rssMB;
        tabs[0].privateMB = proc.privateMB ?? null;
        tabs[0].cpu = proc.cpu;
        tabs[0].sharesProcess = false;
        continue;
      }

      // Shared renderer: split by JS heap over a per-tab base.
      const weights = tabs.map((tab) => RENDERER_BASE_MB + (tab.jsHeapMB || 0));
      const weightSum = weights.reduce((a, b) => a + b, 0) || tabs.length;

      tabs.forEach((tab, i) => {
        const share = weights[i] / weightSum;
        tab.rssMB = proc.rssMB * share;
        tab.privateMB = proc.privateMB == null ? null : proc.privateMB * share;
        tab.sharesProcess = true;
        tab.processTabCount = tabs.length;

        // CPU is *not* shared out proportionally when we can do better. A
        // proportional split says every tab in a shared renderer is equally
        // busy, which made the governor freeze quiet tabs that happened to
        // share a process with a busy one. `taskCpu` is that page's own
        // main-thread time, measured per document over CDP; fall back to the
        // split only until the first sample lands.
        tab.cpu = tab.taskCpu != null ? tab.taskCpu : proc.cpu * share;
      });
    }

    // Tabs with no live renderer (discarded) hold no resident memory.
    for (const tab of this.getTabs()) {
      if (!tab.pid) {
        tab.rssMB = 0;
        tab.privateMB = null;
        tab.cpu = 0;
        tab.sharesProcess = false;
      }
    }
  }

  /**
   * Memory that could actually be reclaimed by acting on tabs, i.e. excluding
   * the browser process, GPU process and utility processes that exist no
   * matter how few tabs are open.
   */
  reclaimableMB() {
    let sum = 0;
    for (const [, proc] of this.byPid) {
      if (proc.type === 'Tab') sum += proc.rssMB;
    }
    return sum;
  }

  snapshot() {
    return {
      // What the figures actually are, rather than what the platform can do in
      // principle.
      //
      // Every process, not merely one. A partly-probed total is a mixture -
      // proportional figures for the pids that answered, summed working set for
      // the rest - and calling that 'probe' drops the "over-counts" warning from
      // a number that is still over-counting. One slow renderer would have been
      // enough. Mixtures read as the fallback they mostly are.
      // Four states, because three of them are genuinely different and the
      // difference matters to whoever reads the number:
      //
      //   pss    the kernel's own proportional figure (Linux)
      //   probe  every process measured by the native helper
      //   mixed  some measured, the rest still summed working set - so the
      //          total still over-counts, and must still say so
      //   rss    none measured; the old summed figure throughout
      //
      // An all-or-nothing rule was tried and is wrong: one process that exits
      // between the sample and the probe, or that cannot be opened, pinned the
      // label to 'rss' and hid the fact that the helper was working perfectly
      // for everything else.
      accounting: accountingMode() === 'pss'
        ? 'pss'
        : this.probed.size === 0 ? 'rss'
        : this.probed.size < this.byPid.size ? 'mixed'
        : this.probeIsProportional() ? 'probe' : 'suspect',
      probeRatio: this.rssTotalMB > 0
        ? Math.round((this.totalMB / this.rssTotalMB) * 100) / 100
        : null,
      rssTotalMB: Math.round(this.rssTotalMB),
      privateTotalMB: this.privateTotalMB == null ? null : Math.round(this.privateTotalMB),
      probeMechanism: this.probeMechanism || null,
      pageMerging: pageMergingStatus(),
      compression: compressionStatus(),
      totalMB: Math.round(this.totalMB),
      overheadMB: Math.round(this.browserOverheadMB),
      reclaimableMB: Math.round(this.reclaimableMB()),
      processCount: this.byPid.size,
      rendererCount: [...this.byPid.values()].filter((p) => p.type === 'Tab').length
    };
  }
}

module.exports = { Metrics, MB };
