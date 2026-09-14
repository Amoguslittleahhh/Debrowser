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

/** Exponential smoothing factor for per-process samples. */
const EMA_ALPHA = 0.35;

/** Overhead attributed to a renderer regardless of page content. */
const RENDERER_BASE_MB = 12;

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
    this.totalMB = 0;
    this.browserOverheadMB = 0;
    this.lastSampleAt = 0;
  }

  /**
   * Sample every Electron process and attribute the result to tabs.
   * Cheap enough to run on every governor tick: `getAppMetrics` is a single
   * synchronous call into the browser process, not a per-process walk.
   */
  sample() {
    const raw = this.app.getAppMetrics();
    const seen = new Set();
    let total = 0;
    let overhead = 0;

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
      const footprint = detail ? detail.pssMB : rssMB;
      const priv = detail ? detail.privateMB : null;
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
    }

    // Drop processes that have exited so stale memory never inflates the total.
    for (const pid of this.byPid.keys()) {
      if (!seen.has(pid)) this.byPid.delete(pid);
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
    this.lastSampleAt = Date.now();
    return this.totalMB;
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
      accounting: accountingMode(),
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
