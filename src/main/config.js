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
   * Idle ladder: how long a tab must be hidden before each demotion. A tab
   * becomes WARM the moment it is hidden, so that step needs no threshold.
   * There is deliberately no `discardAfterMs`: discarding is driven by memory
   * pressure, never by a timer alone, because destroying a quiet tab that
   * nothing is competing with only costs a reload later.
   */
  coldAfterMs: 45_000,
  freezeAfterMs: 5 * 60_000,

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

  /** Renderer process ceiling. Chromium reuses processes once this is hit. */
  rendererProcessLimit: 0, // 0 = let Chromium decide

  /** Share one renderer across all tabs of the same site. Big RAM win. */
  processPerSite: false,

  /** Chromium keeps a spare renderer warm; it costs RAM to save nav latency. */
  spareRenderer: true
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
    coldAfterMs: 20_000,
    freezeAfterMs: 90_000,
    minLifetimeMs: 45_000,
    discardFromPressure: Pressure.MODERATE,
    rendererProcessLimit: 6,
    processPerSite: true,
    spareRenderer: false
  },

  performance: {
    memoryBudgetMB: 3000,
    tabFloorMB: 80,
    coldAfterMs: 3 * 60_000,
    freezeAfterMs: 20 * 60_000,
    minLifetimeMs: 5 * 60_000,
    discardFromPressure: Pressure.CRITICAL,
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
