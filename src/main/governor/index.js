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

/** Refresh per-tab JS heap every N ticks; it needs a CDP round trip each. */
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
      if (this.tickCount % HEAP_SAMPLE_EVERY === 0) await this.sampleHeaps();
      this.metrics.attribute();

      this.pressure = this.computePressure();

      const active = this.tabs.activeTab();
      this.boost.update(active, this.tabs.all());

      await this.runPostAnimationSettle();
      await this.runIdleLadder();
      await this.enforceBudget();

      this.onUpdate(this.snapshot());
    } finally {
      this.running = false;
    }
  }

  /**
   * Per-tab JS heap, used to split shared-renderer memory fairly.
   *
   * Only sampled for tabs that actually share a renderer with another tab.
   * Everywhere else the process figure *is* the tab figure and the heap adds
   * nothing - and it is not free to ask: enabling the Performance domain
   * instantiates instrumentation inside the renderer. Sampling every tab cost
   * around 8MB per tab in benchmarking, which is a governor that spends more
   * memory measuring than it saves.
   */
  async sampleHeaps() {
    for (const tab of this.tabs.all()) {
      if (!tab.isLive || !tab.cdp) continue;
      if (!tab.sharesProcess) continue;
      if (tab.boosted) continue; // never add CDP traffic to an animating tab
      const bytes = await tab.cdp.jsHeapBytes();
      if (bytes != null) tab.jsHeapMB = bytes / (1024 * 1024);
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
   * settle, then collect - and measurement killed it. Forcing a collection
   * costs about 6MB per renderer in heap-profiler instrumentation that is
   * never returned, against a few megabytes reclaimed, and it stalls the very
   * tab the user is looking at. Chromium gives the memory back on its own once
   * the tab stops being busy, and more of it. So the honest post-animation
   * behaviour is: hand back CPU immediately, and leave memory alone.
   */
  async runPostAnimationSettle() {
    for (const tab of this.boost.dueSettles(this.tabs.all())) {
      this.stats.settles += 1;
      this.log(`tab ${tab.id}: settled after animation`);
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
    const ceiling = this.clampToProtections(tab, Tier.DISCARDED, discardAllowed);
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
  clampToProtections(tab, requested, discardAllowed = true) {
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
    if (tab.idleMs() < this.cfg.minLifetimeMs) cap(Tier.FROZEN);

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
      pressure: this.pressure,
      profile: this.cfg.profile,
      boostedTabId: this.boost.boostedTabId,
      stats: { ...this.stats, reclaimedMB: Math.round(this.stats.reclaimedMB) },
      tabs: this.tabs.all().map((t) => t.toJSON())
    };
  }
}

const PRESSURE_RANK = {
  [Pressure.NONE]: 0,
  [Pressure.MODERATE]: 1,
  [Pressure.HIGH]: 2,
  [Pressure.CRITICAL]: 3
};

module.exports = { Governor, PRESSURE_RANK };
