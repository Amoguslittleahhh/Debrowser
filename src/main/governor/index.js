'use strict';

/**
 * The resource governor.
 *
 * Runs a single periodic pass that decides, for every tab, how much memory and
 * CPU it should be holding right now. Two independent forces drive it:
 *
 *   1. An **idle ladder**. The longer a tab has been out of sight, the further
 *      down the tier ladder it goes, and the more of its resources it gives
 *      up. This runs regardless of pressure: a tab nobody is looking at should
 *      not be burning CPU on timers just because there happens to be RAM
 *      spare.
 *
 *   2. A **budget**. Total resident memory is held under a target by demoting
 *      the least valuable tabs further than the ladder alone would. This is
 *      what keeps the browser inside its footprint when a few heavy pages
 *      would otherwise blow past it.
 *
 * Against both of those sit the protections, which is the "without affecting
 * smoothness or quality of life" half, and which always win:
 *
 *   - The visible tab is never frozen, discarded, or deprioritised. Ever.
 *   - Nothing that stalls a renderer runs while anything is animating.
 *   - A tab playing audio is never frozen or discarded.
 *   - A tab holding text the user typed is never discarded.
 *   - A tab the user left moments ago is never discarded, at any pressure.
 *   - A tab already at its floor is left alone: reclaiming from it would cost
 *     CPU to recover memory the page will immediately allocate again.
 */

const { Tier, Pressure, tierRank, TIER_ORDER } = require('../config');
const { Metrics } = require('./metrics');
const { BoostController } = require('./boost');
const { applyTier, refreshPriority } = require('./tiers');
const { HeapLimiter } = require('./heap-limit');

/** Refresh per-tab heap/CPU every N ticks; each needs a CDP round trip. */
const HEAP_SAMPLE_EVERY = 3;

class Governor {
  /**
   * @param {object} deps - { app, cfg, tabManager, ipcHub, log, onUpdate }
   */
  constructor({ app, cfg, tabManager, ipcHub, log = () => {}, onUpdate = () => {} }) {
    this.app = app;
    this.cfg = cfg;
    this.tabs = tabManager;
    this.ipcHub = ipcHub;
    this.log = log;
    this.onUpdate = onUpdate;

    this.metrics = new Metrics(app, () => this.tabs.all());
    this.boost = new BoostController(cfg, log);
    this.heapLimiter = new HeapLimiter(cfg, log);

    this.timer = null;
    this.tickCount = 0;
    this.pressure = Pressure.NONE;
    this.running = false;
    this.stats = { discards: 0, freezes: 0, settles: 0, reclaimedMB: 0 };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log(`governor tick failed: ${err.stack || err.message}`));
    }, this.cfg.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log(`governor started: budget ${this.cfg.memoryBudgetMB}MB, profile ${this.cfg.profile}`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ---------------------------------------------------------------- */

  async tick() {
    if (this.running) return; // a slow CDP call must not overlap passes
    this.running = true;
    try {
      this.tickCount += 1;

      this.metrics.sample();
      if (this.tickCount % HEAP_SAMPLE_EVERY === 0) await this.samplePerTabMetrics();
      this.metrics.attribute();

      this.pressure = this.computePressure();

      const active = this.tabs.activeTab();
      this.boost.update(active, this.tabs.all());

      await this.runPostAnimationSettle();
      await this.runHeapLimits();
      await this.runIdleLadder();
      await this.enforceLiveTabCap();
      await this.enforceBudget();

      this.onUpdate(this.snapshot());
    } finally {
      this.running = false;
    }
  }

  /**
   * Per-tab heap and CPU, for tabs that share a renderer with another tab.
   *
   * Only those tabs: where a tab owns its process outright, the process figures
   * *are* the tab's figures and asking the page is pure cost - enabling the
   * Performance domain instantiates instrumentation inside the renderer, and
   * sampling every tab measured at ~8MB per tab, a governor spending more
   * memory measuring than it saves.
   *
   * Frozen tabs are skipped as well. Their CPU is zero by construction, and
   * asking would re-attach a debugger session that was deliberately detached.
   */
  async samplePerTabMetrics() {
    const now = Date.now();
    for (const tab of this.tabs.all()) {
      if (!tab.isLive || !tab.cdp) continue;
      if (!tab.sharesProcess) continue;
      if (tab.tier === Tier.FROZEN) continue;
      if (tab.boosted) continue; // never add CDP traffic to an animating tab

      const metrics = await tab.cdp.pageMetrics();
      if (!metrics) continue;

      if (metrics.jsHeapBytes != null) tab.jsHeapMB = metrics.jsHeapBytes / (1024 * 1024);

      // Differentiate cumulative task time into a percentage of one core.
      if (metrics.taskDurationSec != null) {
        if (tab.lastTaskSec != null && tab.lastTaskAt) {
          const elapsedSec = (now - tab.lastTaskAt) / 1000;
          if (elapsedSec > 0) {
            const busySec = Math.max(0, metrics.taskDurationSec - tab.lastTaskSec);
            tab.taskCpu = (busySec / elapsedSec) * 100;
          }
        }
        tab.lastTaskSec = metrics.taskDurationSec;
        tab.lastTaskAt = now;
      }
    }
  }

  computePressure() {
    const used = this.metrics.totalMB;
    const ratio = used / this.cfg.memoryBudgetMB;
    const t = this.cfg.pressure;
    if (ratio >= t.critical) return Pressure.CRITICAL;
    if (ratio >= t.high) return Pressure.HIGH;
    if (ratio >= t.moderate) return Pressure.MODERATE;
    return Pressure.NONE;
  }

  /* ---------------------------------------------------------------- */
  /* Post-animation settle                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Handle tabs whose animation has just ended.
   *
   * CPU is already back: the boost controller dropped the tab's priority and
   * released the other renderers the moment the animation decayed. What this
   * pass deliberately does *not* do is force the page to give memory back.
   *
   * That was the original design - decay the boost, wait for the page to
   * settle, then collect - and it is still not done here, for a reason that
   * survived the correction to how memory is measured: this tab is the *visible*
   * one. A collection stalls the renderer, and stalling the tab the user is
   * looking at immediately after an animation is exactly the jank this browser
   * exists to avoid. Heap limits apply to hidden tabs only (runHeapLimits), and
   * this tab becomes eligible the moment it is hidden.
   */
  async runPostAnimationSettle() {
    for (const tab of this.boost.dueSettles(this.tabs.all())) {
      this.stats.settles += 1;
      this.log(`tab ${tab.id}: settled after animation`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Per-tab heap limits (square-root rule)                            */
  /* ---------------------------------------------------------------- */

  /**
   * Collect the garbage of any hidden tab whose heap has passed the limit the
   * square-root rule sets for it. See governor/heap-limit.js.
   *
   * Two gates before anything is measured, let alone collected: a tab must be
   * big enough for a collection to out-earn the debugger session it costs, and
   * nothing may be animating anywhere - a collection stalls a renderer, and
   * stalling one while the user watches a transition is how a memory saver
   * becomes a janky browser.
   */
  async runHeapLimits() {
    if (!this.cfg.heapLimit.enabled) return;
    if (this.boost.quiesceRequested) return;

    const now = Date.now();
    for (const tab of this.tabs.all()) {
      if (!this.heapLimiter.worthMeasuring(tab)) continue;
      if (this.shouldSkip(tab)) continue;

      const metrics = await tab.cdp.pageMetrics();
      if (!metrics || metrics.jsHeapBytes == null) continue;
      this.heapLimiter.observe(tab, metrics.jsHeapBytes, now, metrics.jsHeapTotalBytes);

      // Either the one-time backlog from loading, or steady-state growth past
      // the limit the rule sets. See hasLoadBacklog for why both exist.
      const backlog = this.heapLimiter.hasLoadBacklog(tab);
      if (!backlog && !this.heapLimiter.isOverLimit(tab)) continue;

      // Measured on the committed size, which is what a collection actually
      // returns to the OS.
      const before = metrics.jsHeapTotalBytes ?? metrics.jsHeapBytes;
      const result = await tab.cdp.collectGarbage();
      if (!result) continue;

      // Re-read to learn L exactly, which is only knowable just after a
      // collection, and to measure what this one actually achieved.
      const after = await tab.cdp.pageMetrics();
      const afterBytes = after?.jsHeapTotalBytes ?? after?.jsHeapBytes ?? before;
      // L is the live set after collecting, which is the used figure.
      if (after?.jsHeapBytes != null) tab.liveHeapBytes = after.jsHeapBytes;
      tab.heapTotalBytes = afterBytes;
      this.heapLimiter.recordCollection(tab, before, afterBytes, result.ms);

      this.log(`tab ${tab.id}: heap ${fmtMB(before)} -> ${fmtMB(afterBytes)} ` +
               `(${backlog ? 'load backlog' : 'over limit'}, ` +
               `limit now ${fmtMB(this.heapLimiter.limitFor(tab))}, ${result.ms}ms)`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Idle ladder                                                       */
  /* ---------------------------------------------------------------- */

  async runIdleLadder() {
    const now = Date.now();
    const accel = this.cfg.pressureAccel[this.pressure] ?? 1;

    for (const tab of this.tabs.all()) {
      if (tab.visible) {
        if (tab.tier !== Tier.ACTIVE) await applyTier(tab, Tier.ACTIVE, this.ctx());
        else refreshPriority(tab, this.cfg);
        continue;
      }

      if (this.shouldSkip(tab)) continue;

      const idle = tab.idleMs(now);
      let target = Tier.WARM;
      if (idle >= this.cfg.coldAfterMs * accel) target = Tier.COLD;

      // Freezing is a CPU optimisation, and it is *not* a memory one - it has
      // a measurable memory cost. A backgrounded renderer that is left alone
      // keeps reclaiming on its own (a heavy tab measured 117MB -> 107MB over
      // a minute); freezing stops the tasks that do that work, so a frozen tab
      // settles ~5MB higher than the same tab left running quietly.
      //
      // So a tab is frozen only when it is actually still burning CPU in the
      // background - a polling timer, an animation nobody is watching, a busy
      // worker. There the trade is overwhelmingly worth it: real CPU to zero
      // for a few megabytes. Freezing a page that is already quiet buys no CPU
      // (it is using none) and costs that memory for nothing.
      if (idle >= this.cfg.freezeAfterMs * accel && tab.cpu >= this.cfg.freezeCpuThreshold) {
        target = Tier.FROZEN;
      }

      // Discard on time alone, independent of pressure. A tab nobody has
      // looked at for a quarter of an hour is holding ~100MB on the chance
      // it gets revisited; the reload when it does is cheaper than carrying
      // that indefinitely, and it is the only reclaim that returns the whole
      // renderer rather than a fraction of a heap.
      if (idle >= this.cfg.discardAfterMs * accel) target = Tier.DISCARDED;
      // Discarding on a timer alone is deliberately not done here. An idle
      // frozen tab costs no CPU and has already been collected; destroying
      // it buys the remainder only at the price of a reload later. That trade
      // is only worth making under real memory pressure, which is the
      // budget's job below.

      target = this.clampToProtections(tab, target);
      if (tierRank(target) > tierRank(tab.tier)) {
        await applyTier(tab, target, this.ctx());
        if (target === Tier.FROZEN) this.stats.freezes += 1;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Live renderer cap                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Hold the number of tabs with a live renderer at or below `maxLiveTabs`,
   * discarding least-recently-used first.
   *
   * This exists because the memory budget cannot serve someone who opens tabs
   * in bursts. The budget is sized to the machine, so on 16GB it sits near
   * 6GB - and thirty tabs at ~100MB each never reach it. Thirty renderers stay
   * resident, the user watches their memory climb, and every policy in this
   * file correctly concludes there is nothing to do.
   *
   * A count-based cap bounds the footprint by the thing that actually varies.
   * Because candidates are ordered least-recently-used, the tabs the user is
   * moving between stay live and instant while the long tail costs nothing -
   * so this is allowed to override the grace period that otherwise protects
   * recently-left tabs. It never overrides audio, unsubmitted input or a
   * pinned tab.
   */
  async enforceLiveTabCap() {
    const cap = this.cfg.maxLiveTabs;
    if (!cap) return;
    if (this.boost.quiesceRequested) return; // never reclaim mid-animation

    const liveCount = this.tabs.all().filter((tab) => tab.isLive).length;
    let excess = liveCount - cap;
    if (excess <= 0) return;

    const candidates = this.tabs.all()
      .filter((tab) => tab.isLive && !tab.visible && !this.shouldSkip(tab))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt); // least recent first

    for (const tab of candidates) {
      if (excess <= 0) break;
      const target = this.clampToProtections(tab, Tier.DISCARDED, { ignoreGrace: true });
      if (target !== Tier.DISCARDED) continue; // protected; leave it resident

      const before = tab.rssMB;
      if (await applyTier(tab, Tier.DISCARDED, this.ctx())) {
        this.stats.discards += 1;
        this.stats.reclaimedMB += before;
        excess -= 1;
      }
    }

    if (excess > 0) {
      // Everything left is protected. Correct, but worth saying once: it means
      // the cap is not being met and the user's memory will sit above target.
      this.log(`live-tab cap: ${excess} tab(s) over cap and all protected`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Budget enforcement                                                */
  /* ---------------------------------------------------------------- */

  async enforceBudget() {
    if (this.pressure === Pressure.NONE) return;
    if (this.boost.quiesceRequested) return; // never reclaim mid-animation

    const discardAllowed = tierRank(this.pressure) !== undefined &&
      PRESSURE_RANK[this.pressure] >= PRESSURE_RANK[this.cfg.discardFromPressure];

    let overBy = this.metrics.totalMB - this.cfg.memoryBudgetMB * this.cfg.pressure.moderate;
    if (overBy <= 0) return;

    for (const tab of this.rankVictims()) {
      if (overBy <= 0) break;

      const next = this.nextTierDown(tab, discardAllowed);
      if (!next) continue;

      const before = tab.rssMB;
      const changed = await applyTier(tab, next, this.ctx());
      if (!changed) continue;

      if (next === Tier.DISCARDED) {
        this.stats.discards += 1;
        overBy -= before;              // the whole renderer is gone
        this.stats.reclaimedMB += before;
      } else {
        if (next === Tier.FROZEN) this.stats.freezes += 1;
        // A cold/frozen trim typically returns a meaningful fraction of the
        // page's heap. Estimate conservatively so we do not over-reclaim on
        // the strength of an optimistic guess; the next tick measures reality.
        const estimate = Math.max(0, (before - this.cfg.tabFloorMB) * 0.35);
        overBy -= estimate;
        this.stats.reclaimedMB += estimate;
      }
    }
  }

  /**
   * Order tabs worst-first: the most memory held for the least recent use.
   *
   * Multiplying by idle time rather than sorting by it means a 400MB tab left
   * five minutes ago is reclaimed before a 40MB tab left an hour ago - which
   * is the right call, because it ends the pressure in one action instead of
   * ten, and one interruption is cheaper for the user than ten.
   */
  rankVictims() {
    const now = Date.now();
    return this.tabs.all()
      .filter((tab) => !tab.visible && tab.isLive && !this.shouldSkip(tab) && !this.isAtFloor(tab))
      .map((tab) => {
        const idleMinutes = tab.idleMs(now) / 60_000;
        return { tab, score: tab.rssMB * Math.log1p(idleMinutes) };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.tab);
  }

  /** One step further down, respecting every protection. */
  nextTierDown(tab, discardAllowed) {
    const ceiling = this.clampToProtections(tab, Tier.DISCARDED, { discardAllowed });
    const currentRank = tierRank(tab.tier);
    const ceilingRank = tierRank(ceiling);
    if (ceilingRank <= currentRank) return null;

    let next = TIER_ORDER[currentRank + 1];
    // Under memory pressure, stepping through FROZEN is counterproductive:
    // it costs memory rather than saving any (see runIdleLadder). When this
    // tab may be discarded outright, go straight there.
    if (next === Tier.FROZEN && ceiling === Tier.DISCARDED) next = Tier.DISCARDED;
    return next;
  }

  /* ---------------------------------------------------------------- */
  /* Protections                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Cap how far a tab may be demoted. Returns the lowest tier permitted for
   * this tab right now, which may be higher than the tier requested.
   */
  clampToProtections(tab, requested, { discardAllowed = true, ignoreGrace = false } = {}) {
    let floor = requested;

    const cap = (tier) => {
      if (tierRank(tier) < tierRank(floor)) floor = tier;
    };

    // Audio is the most noticeable thing a browser can take away.
    if (tab.audible) cap(Tier.WARM);

    // Unsubmitted input survives a freeze perfectly; it does not survive a
    // discard. The memory cost of holding it is not a close call.
    if (tab.hasDirtyInput) cap(Tier.FROZEN);

    // A tab the user just left is one they are likely about to return to.
    //
    // Two carve-outs. A tab that has never been visible has nothing on screen
    // to return to, so the grace period does not apply - otherwise opening
    // twenty background links would make twenty renderers untouchable for a
    // minute. And `ignoreGrace` lets the live-tab cap through, because there
    // the candidates are already ordered least-recently-used: the tab being
    // discarded is the Nth least recent, never one just left.
    if (tab.everVisible && !ignoreGrace && tab.idleMs() < this.cfg.minLifetimeMs) {
      cap(Tier.FROZEN);
    }

    if (tab.pinned) cap(this.pressure === Pressure.CRITICAL ? Tier.FROZEN : Tier.COLD);

    if (!discardAllowed) cap(Tier.FROZEN);

    return floor;
  }

  /** Tabs that should be left entirely alone this tick. */
  shouldSkip(tab) {
    if (!tab.isLive) return true;
    if (tab.loading) return true;                       // never interrupt a load
    if (tab.crashed) return true;
    if (tab.boosted) return true;
    if (tab.wc.isDevToolsOpened?.()) return true;       // the user is inspecting it
    return false;
  }

  /**
   * A tab at or below its floor has nothing worth taking. Trimming it would
   * spend CPU to reclaim memory the page needs and will immediately allocate
   * again - the classic way a memory saver makes a browser slower overall.
   */
  isAtFloor(tab) {
    return tab.rssMB > 0 && tab.rssMB <= this.cfg.tabFloorMB;
  }

  ctx() {
    return { cfg: this.cfg, ipcHub: this.ipcHub, log: this.log };
  }

  /* ---------------------------------------------------------------- */

  /**
   * Discard a tab because the user asked, from the task manager.
   *
   * Still goes through the protections: an explicit request is not a reason
   * to throw away text someone typed. If a protection blocks the discard the
   * tab is frozen instead, which satisfies the intent - the tab stops costing
   * CPU and most of its memory - without the data loss.
   */
  async enforceManualDiscard(tab) {
    if (!tab || tab.visible || !tab.isLive) return false;
    const target = this.clampToProtections(tab, Tier.DISCARDED);
    const changed = await applyTier(tab, target, this.ctx());
    if (changed && target === Tier.DISCARDED) this.stats.discards += 1;
    return changed;
  }

  /** Called by the tab manager the moment the user switches tabs. */
  async onTabActivated(tab) {
    if (!tab) return;
    // Promote immediately rather than waiting for the next tick: the user is
    // looking at this tab now.
    await applyTier(tab, Tier.ACTIVE, this.ctx());
  }

  snapshot() {
    const m = this.metrics.snapshot();
    return {
      ...m,
      budgetMB: this.cfg.memoryBudgetMB,
      maxLiveTabs: this.cfg.maxLiveTabs,
      liveTabs: this.tabs.all().filter((tab) => tab.isLive).length,
      pressure: this.pressure,
      profile: this.cfg.profile,
      boostedTabId: this.boost.boostedTabId,
      stats: {
        ...this.stats,
        reclaimedMB: Math.round(this.stats.reclaimedMB),
        ...this.heapLimiter.stats()
      },
      tabs: this.tabs.all().map((t) => t.toJSON())
    };
  }
}

const fmtMB = (bytes) => `${Math.round((bytes || 0) / (1024 * 1024))}MB`;

const PRESSURE_RANK = {
  [Pressure.NONE]: 0,
  [Pressure.MODERATE]: 1,
  [Pressure.HIGH]: 2,
  [Pressure.CRITICAL]: 3
};

module.exports = { Governor, PRESSURE_RANK };
