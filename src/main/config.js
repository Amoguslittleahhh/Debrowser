'use strict';

/**
 * Tunables for the resource governor.
 *
 * The design goal is asymmetric: reclaiming resources must never be allowed to
 * cost the user a dropped frame, but it should happen aggressively the moment
 * it is provably free (tab hidden, page idle, animation finished). Every
 * timing below is therefore a *floor* on how long we wait before taking
 * something away, and never a cap on how fast we give it back.
 */

const MB = 1024 * 1024;

/** Lifecycle tiers, ordered from most to least resourced. */
const Tier = {
  ACTIVE: 'active',      // visible; unthrottled, never touched
  WARM: 'warm',          // hidden but recent; timers throttled, memory intact
  COLD: 'cold',          // hidden a while; eligible for discard, no renderer action
  FROZEN: 'frozen',      // hidden and idle; CPU quiesced to ~0, RAM retained
  DISCARDED: 'discarded' // renderer torn down; ~0 RAM, restores from session state
};

/** Ascending order used for "demote by one step" / comparisons. */
const TIER_ORDER = [Tier.ACTIVE, Tier.WARM, Tier.COLD, Tier.FROZEN, Tier.DISCARDED];

const tierRank = (tier) => TIER_ORDER.indexOf(tier);

/** Global memory pressure bands, derived from usage against the budget. */
const Pressure = {
  NONE: 'none',
  MODERATE: 'moderate',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/** Animation demand reported by the in-page probe. */
const Demand = {
  IDLE: 'idle',     // nothing animating
  LIGHT: 'light',   // occasional repaint, a spinner, a hover transition
  HEAVY: 'heavy'    // sustained rAF loop, video, canvas/WebGL, scroll momentum
};

const BASE = {
  /**
   * Soft ceiling for the sum of all Debrowser processes. The governor keeps
   * total resident memory under this by demoting the least valuable tabs.
   * It is a target, not a hard limit: protected tabs are never sacrificed.
   */
  memoryBudgetMB: 1400,

  /**
   * Per-tab resident floor. A tab holding less than roughly this much is left
   * alone entirely - it is already as small as a working page gets, so there
   * is nothing to reclaim from it that it would not immediately re-allocate.
   */
  tabFloorMB: 45,

  /** How often the governor re-evaluates every tab. */
  tickMs: 2000,

  /**
   * Hard ceiling on how many tabs may hold a renderer process at once.
   *
   * This is the most important number in the file for anyone who opens tabs in
   * bursts. The memory budget alone cannot help them: on a 16GB machine the
   * budget is ~6GB, so thirty tabs never come close to it and thirty renderers
   * stay resident at ~120MB each. A cap bounds the footprint by *tab count*
   * instead, which is the thing that actually varies.
   *
   * Beyond the cap the least-recently-used tabs are discarded, so the N tabs
   * you are actually moving between stay instant and the long tail costs
   * nothing.
   *
   * **Off (0) by default.** A cap limits how many tabs can be open and usable
   * at once, which is the wrong default for someone who deliberately keeps many
   * tabs: the goal is to make each tab cheap, not to ration them. It is kept as
   * an opt-in ceiling for small machines and for anyone who would rather spend
   * reload latency than memory - set `--max-live-tabs=8`, or use the economy
   * profile.
   */
  maxLiveTabs: 0,

  /**
   * Idle ladder: how long a tab must be hidden before each demotion. A tab
   * becomes WARM the moment it is hidden, so that step needs no threshold.
   */
  coldAfterMs: 45_000,
  freezeAfterMs: 5 * 60_000,

  /**
   * How long a hidden tab may sit before it is discarded on time alone,
   * independent of memory pressure.
   *
   * An earlier version had no such timer, on the reasoning that destroying a
   * quiet tab nothing is competing with only buys a reload later. That is true
   * in isolation and wrong in aggregate: it meant a browser left open all day
   * accumulated resident tabs indefinitely, and the user never asked for that
   * memory to be held - they just never closed the tab.
   */
  discardAfterMs: 15 * 60_000,

  /**
   * Background CPU, as a percentage, above which a hidden tab is worth
   * freezing. Freezing costs a few megabytes - it stops the renderer tasks
   * that would otherwise keep reclaiming memory on their own - so it is
   * reserved for tabs that are genuinely still working while out of sight.
   * A quiet tab is already using no CPU; freezing it would buy nothing.
   */
  freezeCpuThreshold: 0.8,

  /**
   * Grace period after a tab is last seen by the user. Nothing may be
   * discarded inside this window even under critical pressure - users flip
   * back to a tab they just left, and a reload there is the most visible
   * failure this browser can have.
   */
  minLifetimeMs: 60_000,

  /** Pressure band thresholds as a fraction of the budget. */
  pressure: {
    moderate: 0.70,
    high: 0.85,
    critical: 1.00
  },

  /**
   * Under pressure the idle ladder is compressed by these multipliers, so a
   * loaded machine reclaims sooner without changing any policy elsewhere.
   */
  pressureAccel: {
    [Pressure.NONE]: 1.0,
    [Pressure.MODERATE]: 0.6,
    [Pressure.HIGH]: 0.3,
    [Pressure.CRITICAL]: 0.1
  },

  /** Discarding is only unlocked once memory is genuinely contended. */
  discardFromPressure: Pressure.HIGH,

  boost: {
    /**
     * Quiet period before a boosted tab drops back to baseline. Long enough to
     * ride through the gap between two animation bursts (a CSS transition
     * chain, a scroll fling settling) so we do not flap the scheduler.
     */
    decayMs: 1200,
    /**
     * Further quiet period after decay before the tab is treated as settled.
     * Long enough that a page finishing one animation and starting another is
     * not counted as having stopped.
     */
    settleAfterMs: 2500,
    /** Nice values applied to renderer processes. See boost.js for caveats. */
    niceForeground: 0,
    niceBoosted: -5,
    niceBackground: 10
  },

  /**
   * Chromium's own renderer process ceiling. Off by default.
   *
   * When Chromium hits it, it reuses one process for different sites, which
   * weakens site isolation. `maxLiveTabs` bounds the renderer count already,
   * by discarding a tab rather than by collapsing unrelated origins, so this is
   * left to anyone who explicitly wants the trade.
   */
  rendererProcessLimit: 0,

  /**
   * Share one renderer across all tabs of the same site.
   *
   * On by default, because it is the single largest memory lever available and
   * the cost is narrow: site isolation - the security boundary between
   * *different* sites - is untouched; what is given up is crash isolation
   * between tabs of the *same* site. Twelve tabs on one site become one process
   * instead of twelve.
   */
  processPerSite: true,

  /**
   * Chromium keeps a spare renderer warm to make the next navigation feel
   * instant. Off by default: it costs a whole process (~30-40MB) to save
   * ~100ms, which is the wrong trade when memory is the constraint.
   */
  spareRenderer: false,

  /**
   * Bias V8 towards smaller heaps and smaller generated code rather than peak
   * throughput (`--js-flags=--optimize-for-size`).
   *
   * Measured at a 13% reduction in per-tab footprint. Exposed as a setting
   * because it is the one lever here that trades a little JIT quality for
   * memory, so it should be possible to turn off and measure.
   */
  optimizeForSize: true,

  /**
   * Maximum tabs allowed to load simultaneously.
   *
   * Peak memory happens during load, not after it - a loading page holds its
   * parser, its network buffers and its pre-compaction heap all at once. Ten
   * tabs opened together therefore spike far higher than the same ten settled.
   * Admitting them a few at a time flattens that spike without making any
   * single tab slower to finish.
   */
  maxConcurrentLoads: 3
};

/**
 * Profiles are deltas on BASE. `economy` trades a little navigation latency
 * and crash isolation for substantially less RAM across many tabs;
 * `performance` keeps tabs resident far longer on machines with headroom.
 */
const PROFILES = {
  balanced: {},

  economy: {
    memoryBudgetMB: 700,
    tabFloorMB: 35,
    maxLiveTabs: 4,
    coldAfterMs: 20_000,
    freezeAfterMs: 90_000,
    discardAfterMs: 3 * 60_000,
    minLifetimeMs: 45_000,
    discardFromPressure: Pressure.MODERATE,
    maxConcurrentLoads: 2,
    processPerSite: true,
    spareRenderer: false
  },

  performance: {
    memoryBudgetMB: 3000,
    tabFloorMB: 80,
    maxLiveTabs: 24,
    coldAfterMs: 3 * 60_000,
    freezeAfterMs: 20 * 60_000,
    discardAfterMs: 2 * 60 * 60_000,
    minLifetimeMs: 5 * 60_000,
    discardFromPressure: Pressure.CRITICAL,
    maxConcurrentLoads: 6,
    // Crash isolation per tab, at the cost of a process per tab.
    processPerSite: false,
    spareRenderer: true
  }
};

function loadConfig(profileName = 'balanced', overrides = {}) {
  const profile = PROFILES[profileName] || PROFILES.balanced;
  const cfg = {
    ...BASE,
    ...profile,
    ...overrides,
    profile: PROFILES[profileName] ? profileName : 'balanced',
    pressure: { ...BASE.pressure, ...(profile.pressure || {}) },
    pressureAccel: { ...BASE.pressureAccel, ...(profile.pressureAccel || {}) },
    boost: { ...BASE.boost, ...(profile.boost || {}) }
  };
  return cfg;
}

module.exports = { Tier, TIER_ORDER, tierRank, Pressure, Demand, PROFILES, loadConfig, MB };
