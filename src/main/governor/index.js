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

const { Tier, Pressure, tierRank, TIER_ORDER, isStopped, MB } = require('../config');
const { Metrics } = require('./metrics');
const { BoostController } = require('./boost');
const { applyTier, refreshPriority } = require('./tiers');
const { HeapLimiter } = require('./heap-limit');
const { readProcessMemory } = require('../memory');
const platform = require('../platform');

/** Refresh per-tab heap/CPU every N ticks; each needs a CDP round trip. */
const HEAP_SAMPLE_EVERY = 3;

/**
 * Shortest gap between two forced collections on the same tab.
 *
 * A collection lowers the live set, which lowers the limit derived from it,
 * while the committed total V8 has not handed back stays where it was - so
 * without a floor the tab is immediately "over limit" again and gets collected
 * on every qualifying tick, forever.
 */
const HEAP_COLLECT_FLOOR_MS = 60_000;

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
    this.stats = {
      discards: 0, freezes: 0, settles: 0, reclaimedMB: 0,
      hibernations: 0, hibernateReclaimedMB: 0, hibernateNetMB: 0
    };

    /**
     * Whether the OS can trim a renderer here at all, resolved once at start.
     * Null until answered, which reads as "no" - a tier that silently does
     * nothing is worse than one that has not started yet.
     */
    this.trimAvailable = false;
    this.trimReason = 'not probed';
    this.hibernationSamples = [];
    this.hibernationDisabled = false;

    /**
     * Renderers whose hibernation has already been measured this tick.
     *
     * A trim acts on a *process* and the ladder walks *tabs*, so under
     * `process-per-site` a renderer with four tabs reaches HIBERNATED four
     * times. Trimming it once is `platform.trimProcessMemory`'s business;
     * *measuring* it once is this one's - without it, one process trimmed once
     * books four samples, three of them near zero, dragging the self-disable
     * median down towards switching a working tier off.
     */
    this.measuredPids = new Set();

    // Nothing in it changes for the governor's lifetime, and `applyTier` is
    // called per tab per tick.
    this.tierCtx = { cfg, ipcHub, log };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log(`governor tick failed: ${err.stack || err.message}`));
    }, this.cfg.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log(`governor started: budget ${this.cfg.memoryBudgetMB}MB, profile ${this.cfg.profile}`);
    this.probeTrim();
  }

  /**
   * Ask once whether this machine can hand a renderer's pages to a compressor.
   *
   * Asynchronous and deliberately not awaited: it spawns a helper and has it
   * trim itself, which takes a few milliseconds, and until it answers
   * `trimAvailable` stays false so nothing hibernates. Starting a tick late is
   * the right failure - the alternative is blocking startup on a capability
   * that is absent on most machines anyway.
   */
  probeTrim() {
    if (!this.cfg.hibernate.enabled) {
      this.trimReason = 'disabled by configuration';
      return;
    }
    platform.trimCapability(this.log).then((cap) => {
      this.trimAvailable = cap.available;
      this.trimReason = cap.reason;
      this.log(cap.available
        ? `hibernation available via ${cap.mechanism}`
        : `hibernation unavailable: ${cap.reason}`);
    }).catch((err) => {
      this.trimAvailable = false;
      this.trimReason = err.message;
    });
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
      this.measuredPids.clear();

      this.metrics.sample();
      if (this.tickCount % HEAP_SAMPLE_EVERY === 0) await this.samplePerTabMetrics();
      this.metrics.attribute();

      this.pressure = this.computePressure();

      const active = this.tabs.activeTab();
      this.boost.update(active, this.tabs.all());

      await this.runPostAnimationSettle();
      await this.runIdleLadder();
      // After the ladder deliberately: a tab the ladder is about to freeze or
      // discard should not first have a debugger session attached and a
      // collection forced, paying ~2.4MB to reclaim memory that is about to be
      // thrown away wholesale.
      await this.runHeapLimits();
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
    const heapEnabled = this.cfg.heapLimit.enabled;

    for (const tab of this.tabs.all()) {
      if (!tab.isLive || !tab.cdp) continue;
      if (isStopped(tab.tier)) continue;   // stopped: cannot answer, and re-attaching undoes the point
      if (tab.boosted) continue; // never add CDP traffic to an animating tab

      // Two consumers want this reading, and it costs a CDP round trip, so it
      // is taken once here for both: attribution needs a per-tab heap only when
      // tabs share a process, and the heap limiter needs one for any tab it
      // might collect. An earlier version had the limiter fetch its own, which
      // meant two identical Performance.getMetrics calls to the same renderer
      // in one tick - in the pass whose own comment says to minimise exactly
      // that traffic.
      const forAttribution = tab.sharesProcess;
      const forHeapLimit = heapEnabled && this.heapLimiter.worthMeasuring(tab);
      if (!forAttribution && !forHeapLimit) continue;

      const metrics = await tab.cdp.pageMetrics();
      if (!metrics) continue;

      if (forHeapLimit && metrics.jsHeapBytes != null) {
        this.heapLimiter.observe(tab, metrics.jsHeapBytes, now, metrics.jsHeapTotalBytes);
      }

      if (metrics.jsHeapBytes != null) tab.jsHeapMB = metrics.jsHeapBytes / MB;

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
   * A decision pass only: the readings it acts on were taken by
   * `samplePerTabMetrics`, which already pays for a round trip to these tabs.
   * That also ties this to the same cadence, which the rest of the file treats
   * as the acceptable rate for per-tab CDP traffic.
   *
   * Two things are never done here: collecting the visible tab, whose stall the
   * user would feel, and collecting while anything is animating anywhere.
   */
  async runHeapLimits() {
    if (!this.cfg.heapLimit.enabled) return;
    if (this.boost.quiesceRequested) return;

    for (const tab of this.tabs.all()) {
      if (!this.heapLimiter.worthMeasuring(tab)) continue;
      if (this.shouldSkip(tab)) continue;
      if (tab.heapTotalBytes == null) continue; // not sampled yet

      // Either the one-time backlog from loading, or steady-state growth past
      // the limit the rule sets. A page's parse and execute produce a large
      // one-off backlog that V8 is in no hurry to collect once the tab goes
      // quiet, and that is not the same event as growing into a heap limit.
      const backlog = !tab.heapBacklogCollected;
      if (!backlog && !this.heapLimiter.isOverLimit(tab)) continue;

      // The interval floor the heap limiter's own header promises, which was
      // never actually applied here.
      //
      // Collecting drops `liveHeapBytes` to the live set, so the limit derived
      // from it drops too - while `heapTotalBytes` stays at the committed size
      // V8 has not handed back. `isOverLimit` is therefore true again
      // immediately, and every qualifying hidden tab was collected forever on
      // a roughly six-second cycle. A forced collection is not free; doing it
      // in a loop costs more than the heap it is chasing.
      const sinceLast = Date.now() - (tab.lastHeapCollectionAt || 0);
      if (!backlog && sinceLast < HEAP_COLLECT_FLOOR_MS) continue;
      tab.lastHeapCollectionAt = Date.now();

      const beforeTotal = tab.heapTotalBytes;
      const result = await tab.cdp.collectGarbage();
      if (!result) continue;

      // Re-read so L is the live set measured just after collecting. The
      // limiter owns every heap field on the tab; nothing is assigned here.
      //
      // Guarded, because `collectGarbage` is awaited with a five-second ceiling
      // and a renderer can die inside that window - the tab closed, or the
      // process OOM-killed - which nulls `tab.cdp` in teardown. Unguarded, this
      // threw a TypeError straight out of the tick, and the tick is where
      // `enforceLiveTabCap` and `enforceBudget` run: the browser quietly
      // stopped reclaiming at the exact moment memory pressure killed a
      // renderer. tiers.js already guards the identical pattern.
      if (!tab.cdp) continue;
      const after = await tab.cdp.pageMetrics();
      this.heapLimiter.recordCollection(tab, {
        beforeTotal,
        afterTotal: after?.jsHeapTotalBytes ?? beforeTotal,
        afterUsed: after?.jsHeapBytes ?? null,
        durationMs: result.ms
      });

      this.log(`tab ${tab.id}: heap ${fmtMB(beforeTotal)} -> ${fmtMB(tab.heapTotalBytes)} ` +
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

      // Before the skip, not after. `shouldSkip` returns early for a tab with
      // no renderer, and this is the only place outside `activate` that clears
      // a speculation - so a tab that was speculated on and never became live
      // (queued behind the admission limit and then closed, or OOM-killed) left
      // `speculatingId` set for the rest of the session, silently disabling
      // every future speculative restore with nothing in the log to say why.
      if (tab.speculativeUntil && now > tab.speculativeUntil && !tab.everVisible && !tab.isLive) {
        this.tabs.clearSpeculation(tab);
      }

      if (this.shouldSkip(tab)) continue;

      // A renderer built on a guess the user never acted on. Taken back at
      // once rather than left to the ordinary ladder, because the whole point
      // of bounding speculation is that a pointer swept across the tab strip
      // cannot quietly leave a trail of resident tabs behind it. A tab the
      // user did go on to open has had `speculativeUntil` cleared by the
      // activation and never reaches this.
      if (tab.speculativeUntil && now > tab.speculativeUntil && !tab.everVisible) {
        await applyTier(tab, Tier.DISCARDED, this.ctx());
        this.tabs.clearSpeculation(tab);
        continue;
      }

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

      // Hibernate: freeze, then hand the cold pages to the OS compressor. A
      // separate rule from freezing above, and deliberately so - that one is
      // about CPU and fires only on tabs still burning it, this one is about
      // memory and fires on quiet tabs the other deliberately leaves alone.
      //
      // Measured at 29-49% of a renderer's private memory returned, for a
      // 4-12ms resume. Nothing is lost: the process stays alive and its state
      // is untouched, which is what makes it the only lever that works on tabs
      // the protections refuse to discard.
      if (this.shouldHibernate(tab, idle, accel)) target = Tier.HIBERNATED;

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
        // Whole-process, because that is the unit a trim acts in. The tab's own
        // `privateMB` is its *share* of the renderer under the attribution in
        // metrics.js, so comparing it against a post-trim process reading
        // subtracted a fraction from a whole and reported a reclaim several
        // times the truth on any shared renderer. Taken from the reading this
        // tick already made rather than re-reading /proc: both predate the
        // freeze `applyTier` is about to perform, so they describe the same
        // thing, and one of them is free.
        const before = target === Tier.HIBERNATED
          ? this.metrics.byPid.get(tab.pid)?.privateMB ?? null
          : null;

        // And what the machine had spare before the trim, which is the reading
        // the tier is actually judged on. Taken here, immediately before the
        // trim, so the window it brackets is milliseconds wide and whatever
        // else the machine is doing has as little time as possible to move it.
        const availBefore = target === Tier.HIBERNATED && before != null
          ? (await platform.availableMemory(this.log))?.availBytes ?? null
          : null;

        // Where the tab actually landed, not where it was asked to go:
        // freezing and trimming can each be refused, and a tier the tab is not
        // in must not be counted as one it reached.
        const reached = await applyTier(tab, target, this.ctx());
        if (reached === Tier.FROZEN) this.stats.freezes += 1;
        // Read once: `Tab#pid` asks the renderer rather than returning a field,
        // because a cached one goes stale the moment a tab navigates across
        // sites - so a pair of reads is a pair of native calls.
        const pid = tab.pid;
        if (reached === Tier.HIBERNATED && pid && !this.measuredPids.has(pid)) {
          this.measuredPids.add(pid);
          // Not awaited: the measurement is bookkeeping, and a tick that waited
          // on a helper round trip for it would be a tick the ladder is not
          // running. Failures inside it are logged, never thrown at the tick.
          this.recordHibernation(tab, before, availBefore)
            .catch((err) => this.log(`hibernation measurement failed: ${err.message}`));
        }
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
      if (await applyTier(tab, Tier.DISCARDED, this.ctx()) === Tier.DISCARDED) {
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
      const reached = await applyTier(tab, next, this.ctx());
      if (reached !== next) continue;

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
    // Under memory pressure, stepping through the stopped tiers is the wrong
    // move when this tab may be discarded outright: FROZEN costs memory rather
    // than saving any, and HIBERNATED returns about half a renderer where
    // discarding returns all of it. Both are worth having on the *idle* ladder,
    // where nothing is contended and losing no state is the point; under real
    // pressure the full reclaim is what is needed, so go straight there.
    if (isStopped(next) && ceiling === Tier.DISCARDED) next = Tier.DISCARDED;
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

    // The browser's own pages are governed like any other tab.
    //
    // They used to be pinned at ACTIVE, on the reasoning that every tier below
    // it is wrong for them: freezing one stops the page servicing the controls
    // the user is operating, and discarding one throws away a half-filled form.
    //
    // In a real session that made three of the six live renderers Settings, the
    // downloads page and a new tab page - about 95MB held permanently - while
    // the actual websites beside them sat discarded at zero. A browser whose
    // own pages are the expensive ones has the rule backwards.
    //
    // What the exemption was really protecting is unsubmitted text, and that is
    // `hasDirtyInput`'s job. These pages carry the command bridge rather than
    // `probe-preload.js`, so nothing was watching them - so they report it
    // themselves now, from the one kind of field that can lose anything: a
    // search box, or the new tab page's query. Settings needs no such rule
    // because every control on it saves the moment it changes; there is nothing
    // there to lose.
    //
    // They are cheap to bring back, which is the other half of why this is
    // safe: a local page, and one that lands in a renderer the prewarmer keeps
    // warm - 46ms measured against 79ms cold.
    // Audio is the most noticeable thing a browser can take away.
    if (tab.audible) cap(Tier.WARM);

    // Unsubmitted input survives a freeze perfectly; it does not survive a
    // discard. The memory cost of holding it is not a close call.
    //
    // HIBERNATED rather than FROZEN, which is the whole reason that tier
    // exists. Every protection below this line means "do not *destroy* this
    // tab", and hibernation destroys nothing: the process stays alive, the
    // heap and DOM are untouched, and the pages come back from the compressor
    // on a fault - the same guarantee the OS already gives every process it
    // swaps. Capping these at FROZEN made HIBERNATED unreachable for exactly
    // the tabs it was built for, and left them holding their full working set
    // instead. The cost of being wrong is 4-12ms on resume (M4b/M4c), not lost
    // text.
    if (tab.hasDirtyInput) cap(Tier.HIBERNATED);

    // A tab the user just left is one they are likely about to return to.
    //
    // Two carve-outs. A tab that has never been visible has nothing on screen
    // to return to, so the grace period does not apply - otherwise opening
    // twenty background links would make twenty renderers untouchable for a
    // minute. And `ignoreGrace` lets the live-tab cap through, because there
    // the candidates are already ordered least-recently-used: the tab being
    // discarded is the Nth least recent, never one just left.
    if (tab.everVisible && !ignoreGrace && tab.idleMs() < this.cfg.minLifetimeMs) {
      cap(Tier.HIBERNATED);
    }

    if (tab.pinned) cap(this.pressure === Pressure.CRITICAL ? Tier.HIBERNATED : Tier.COLD);

    // A tab with developer tools open is a tab being worked on.
    //
    // WARM, not COLD: freezing the page stops the task queues the inspector is
    // driving, so a frozen tab under DevTools is an inspector attached to
    // something that will not answer. The user closes the tools and the tab
    // rejoins the ladder like any other - and the cost of getting this wrong,
    // losing a console session mid-debug, is worse than one resident renderer.
    if (tab.devToolsOpen) cap(Tier.WARM);

    if (!discardAllowed) cap(Tier.HIBERNATED);

    return floor;
  }

  /**
   * Is this tab worth hibernating right now?
   *
   * The renderer-granularity clause is the load-bearing one. Under
   * `process-per-site` several tabs share a process, and trimming a process
   * whose sibling is still live just means the sibling faults everything back
   * in - so the whole group has to be eligible or none of it is.
   */
  shouldHibernate(tab, idle, accel) {
    const cfg = this.cfg.hibernate;
    if (!cfg.enabled || this.hibernationDisabled) return false;
    if (!this.trimAvailable) return false;
    if (idle < cfg.afterMs * accel) return false;

    // A speculative page load must never be the reason a frame is dropped, and
    // neither must a syscall plus a resume stall.
    if (this.boost.quiesceRequested) return false;

    // Private bytes, free from the OS, and the figure the measured curve is in
    // terms of. Null means the platform cannot report it, which is every
    // platform that cannot trim either.
    if (tab.privateMB == null || tab.privateMB < cfg.minPrivateMB) return false;

    // This renderer's trim was refused recently. Asked here rather than left to
    // fail in `demote`, so the tab simply stays where it is instead of being
    // walked down the ladder every tick to be turned back at the last step.
    const pid = tab.pid;
    if (platform.trimBackoffMs(pid) > 0) return false;

    // Every tab sharing this renderer must also be ready to go.
    const group = this.metrics.tabsByPid().get(pid);
    if (!group) return false;
    return group.every((sibling) => sibling === tab || (
      !sibling.visible
      && !this.shouldSkip(sibling)
      && sibling.idleMs() >= cfg.afterMs * accel
      && tierRank(this.clampToProtections(sibling, Tier.HIBERNATED)) >= tierRank(Tier.HIBERNATED)
    ));
  }

  /**
   * Learn whether hibernation actually pays on this machine, and stop if it
   * does not.
   *
   * Every figure behind this tier was measured on one host with zram
   * configured. A machine where the compressor is missing or ineffective would
   * otherwise keep paying the syscall and the resume stall forever in exchange
   * for nothing, which is exactly the failure this repo deletes levers for.
   */
  async recordHibernation(tab, privateBeforeMB, availBeforeBytes) {
    this.stats.hibernations += 1;
    if (privateBeforeMB == null) return;

    // Re-read now rather than waiting for the next tick: the pages are gone by
    // the time the trim returns, and the cached figure is pre-trim. Both
    // readings are of the same process, taken the same way - a share compared
    // against a whole is not a measurement.
    const after = readProcessMemory(tab.pid);
    const leftProcess = after ? privateBeforeMB - after.privateMB : null;
    if (leftProcess != null) this.stats.hibernateReclaimedMB += Math.max(0, leftProcess);

    /*
     * What the *machine* got back, which is a different number and the only one
     * worth judging the tier on.
     *
     * Pages leaving a process do not evaporate: zram and Windows Memory
     * Compression both hold them, compressed, in physical memory - measured at
     * about 2:1 - so a process that shed 200MB may have handed the machine only
     * 100MB. The self-disable below used to read the per-process drop, which
     * means on a host where compression achieved nothing at all it would have
     * seen a large number and kept the tier switched on forever. That is this
     * project's own named worst case: "a syscall returning success is not
     * evidence it did anything", and the per-process figure is the syscall
     * agreeing with itself.
     *
     * The independent reading is what M4b was validated against by hand -
     * MemAvailable moved +149MB against a claimed 270MB - and this is that
     * check, made automatic.
     */
    let net = null;
    if (availBeforeBytes != null) {
      const mem = await platform.availableMemory(this.log);
      if (mem) net = (mem.availBytes - availBeforeBytes) / MB;
    }
    if (net != null) this.stats.hibernateNetMB += net;

    // Judged on the net figure where there is one, and on the per-process drop
    // only where the platform cannot give one. Never on both: a lever that
    // passes on either number is a lever with no gate.
    const sample = net != null ? net : leftProcess;
    if (sample == null) return;
    this.hibernationSamples.push(sample);
    this.hibernationNet = net != null;

    const cfg = this.cfg.hibernate;
    if (this.hibernationSamples.length < cfg.sampleSize) return;

    const sorted = [...this.hibernationSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median < cfg.minReclaimMB) {
      this.hibernationDisabled = true;
      this.log(`hibernation disabled: median ${this.hibernationNet ? 'net system' : 'per-process'} ` +
               `reclaim ${median.toFixed(1)}MB over ${sorted.length} tabs is below the ` +
               `${cfg.minReclaimMB}MB it costs to bother`);
    } else {
      // Proven on this host; stop sampling.
      this.hibernationSamples = [];
    }
  }

  /** Tabs that should be left entirely alone this tick. */
  shouldSkip(tab) {
    if (!tab.isLive) return true;
    if (tab.loading) return true;                       // never interrupt a load
    if (tab.crashed) return true;
    if (tab.boosted) return true;
    if (tab.devToolsOpen) return true;                  // the user is inspecting it
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
    return this.tierCtx;
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
    const reached = await applyTier(tab, target, this.ctx());
    if (reached === Tier.DISCARDED) this.stats.discards += 1;
    return reached !== null;
  }

  /** Called by the tab manager the moment the user switches tabs. */
  async onTabActivated(tab) {
    if (!tab) return;
    // Promote immediately rather than waiting for the next tick: the user is
    // looking at this tab now.
    await applyTier(tab, Tier.ACTIVE, this.ctx());
  }

  /**
   * Whether a speculative restore is affordable right now.
   *
   * Speculation is the one mechanism here that can add memory rather than
   * reclaim it, so it is refused in exactly the conditions where the governor
   * is already working to take memory back, or where the cost would land on a
   * frame the user is watching:
   *
   *   - any memory pressure at all. Under pressure the ladder is compressed
   *     and the budget is discarding tabs; realising one on a guess would be
   *     spending against the reclaim happening in the same tick.
   *   - anything animating. The boost contract defers every expensive action
   *     while a frame is being drawn, and a page load is expensive.
   *   - already at the live-renderer cap, where realising a tab means
   *     discarding a different one. A guess is not worth evicting a tab the
   *     user actually opened.
   */
  allowsSpeculation() {
    if (this.pressure !== Pressure.NONE) return false;
    if (this.boost.quiesceRequested) return false;
    if (this.cfg.maxLiveTabs > 0) {
      const live = this.tabs.all().filter((tab) => tab.isLive).length;
      if (live >= this.cfg.maxLiveTabs) return false;
    }
    return true;
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
      // What reclaim cost the user, reported beside what it saved. A snapshot
      // showing only megabytes is half the trade.
      latency: this.tabs.latency ? this.tabs.latency.stats() : {},
      hibernation: {
        available: this.trimAvailable,
        reason: this.trimAvailable ? null : this.trimReason,
        disabled: this.hibernationDisabled,
        // Whether the figures beside this were checked against the machine or
        // only against the process that shed them. The difference is the whole
        // question of whether compression paid, so it is reported rather than
        // left for the reader to assume the better of the two.
        netMeasured: this.hibernationNet === true
      },
      tabs: this.tabs.all().map((t) => t.toJSON())
    };
  }
}

const fmtMB = (bytes) => `${Math.round((bytes || 0) / MB)}MB`;

const PRESSURE_RANK = {
  [Pressure.NONE]: 0,
  [Pressure.MODERATE]: 1,
  [Pressure.HIGH]: 2,
  [Pressure.CRITICAL]: 3
};

module.exports = { Governor, PRESSURE_RANK };
