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
  HIBERNATED: 'hibernated', // frozen, and its cold pages handed to the OS compressor
  DISCARDED: 'discarded' // renderer torn down; ~0 RAM, restores from session state
};

/** Ascending order used for "demote by one step" / comparisons. */
const TIER_ORDER = [Tier.ACTIVE, Tier.WARM, Tier.COLD, Tier.FROZEN,
                    Tier.HIBERNATED, Tier.DISCARDED];

const tierRank = (tier) => TIER_ORDER.indexOf(tier);

/**
 * Is this tier one where the renderer is alive but its task queues are stopped?
 *
 * True for FROZEN and HIBERNATED, false for DISCARDED - which has no renderer at
 * all - and false for everything above.
 *
 * It exists because inserting HIBERNATED broke every `=== Tier.FROZEN` test that
 * meant "stopped" rather than "frozen specifically", and those were scattered
 * across four files. One of them guards IPC to a stopped renderer, where the
 * failure mode is a segfault rather than a wrong answer, so the distinction is
 * named once here instead of being re-derived at each site.
 */
const isStopped = (tier) => tierRank(tier) >= tierRank(Tier.FROZEN)
                         && tierRank(tier) <= tierRank(Tier.HIBERNATED);

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
   * **On by default, scaled to the machine** - see `recommendedLiveTabs` in
   * platform.js and the override in main.js that applies it. This was off for a
   * long time, on the reasoning that a cap limits how many tabs can be open and
   * usable, which is the wrong default for someone who deliberately keeps many.
   * That reasoning was right about the goal and wrong about the mechanism, in
   * two ways measurement settled.
   *
   * First, the cap does not limit tab count. It limits how many tabs hold a
   * *renderer*. Every tab stays open, keeps its history, scroll offset and
   * unsubmitted input, and restores in place; what is bounded is how many are
   * resident at once.
   *
   * Second, per-tab memory is dominated by fixed overhead, not by renderers.
   * Measured here: ~238MB of browser, GPU, utility and zygote processes before
   * a single tab exists, against ~13.2MB for each additional tab. Nothing
   * reduces that fixed cost - collapsing the GPU, network and zygote processes
   * was tried, and every variant either saved nothing or stopped the browser
   * rendering at all - so the only remaining lever on a per-tab figure is how
   * many renderers are resident.
   *
   * What made it acceptable is the restore placeholder. A discard used to show
   * a blank view for as long as the page took to load; it now shows a picture
   * of the page as the user left it, so the reload happens behind something
   * that looks like the tab. The cost of the cap became invisible, and only
   * then was it worth turning on.
   *
   * Measured, one site per tab:
   *
   *     30 tabs, no cap   624 MB   20.8 MB/tab   31 renderers
   *     30 tabs, cap 6    330 MB   11.0 MB/tab    7 renderers
   *     30 tabs, cap 4    311 MB   10.4 MB/tab    5 renderers
   *     30 tabs, cap 3    291 MB    9.7 MB/tab    4 renderers
   *     40 tabs, cap 4    304 MB    7.6 MB/tab    5 renderers
   *
   * Note the last row. Fixed overhead is amortised across whatever is open, so
   * per-tab memory *improves* as more tabs are opened - the opposite of how a
   * browser usually behaves, and the reason this figure must always be quoted
   * with its tab count beside it.
   *
   * `--max-live-tabs=0` turns the cap off entirely.
   */
  maxLiveTabs: 0,

  /**
   * Idle ladder: how long a tab must be hidden before each demotion. A tab
   * becomes WARM the moment it is hidden, so that step needs no threshold.
   *
   * COLD comes five seconds after you look away, which is soon, and is soon on
   * purpose: reaching it costs the renderer nothing at all - no freeze, no CDP
   * round trip, nothing sent to the page - it only means "this one may be
   * reclaimed if something needs the memory". Forty-five seconds of pretending
   * a tab is still warm bought nothing and made the task manager report a tab
   * as busy for most of a minute after it was abandoned.
   *
   * What stops that becoming a reload is `minLifetimeMs` below, not this: a tab
   * may be marked reclaimable long before it may actually be reclaimed.
   */
  coldAfterMs: 5_000,
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
   * Keep Chromium's site isolation on.
   *
   * **This is a security setting, not a performance one.** Site isolation puts
   * every site in its own renderer process, which is what prevents a
   * compromised or malicious page - including a third-party ad frame embedded in
   * a page you trust - from reading another site's memory. It is the main
   * mitigation for Spectre-class attacks and cross-site leaks in a browser.
   *
   * Turning it off is the single largest remaining memory lever, because most
   * real pages carry cross-site subframes that each get their own process. On a
   * page with six cross-site frames, measured per six tabs:
   *
   *     isolation on    12 renderers   378 MB
   *     isolation off    6 renderers   307 MB   (-19%, private -27%)
   *
   * That is a real saving for a real cost, and the cost is not one this browser
   * will take on a user's behalf by default. The `minimal` profile opts in.
   */
  siteIsolation: true,

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
   * Hibernation: freeze a hidden tab, then hand its cold pages to the OS
   * memory compressor.
   *
   * The tab that cannot be discarded is the one this exists for. A tab holding
   * unsubmitted input or live in-page state is capped at HIBERNATED by the
   * protections - discarding it would lose the thing being protected - and
   * without this tier it would hold its entire footprint for as long as the
   * browser runs. Freezing
   * saves nothing on its own; measured, it *costs* about 3MB. Hibernation is the
   * only lever that works on those tabs.
   *
   * Measured net reclaim, after subtracting what the compressor itself
   * allocates (docs/MEASUREMENTS.md, M4c):
   *
   *     private before   NET reclaim   resume
   *          37 MB          10.9 MB     4.0 ms
   *          83 MB          32.5 MB     3.9 ms
   *         194 MB          94.4 MB     3.0 ms
   *         303 MB         146.1 MB    12.0 ms
   *
   * Roughly 29-49% of a renderer's private memory, rising with size, for a
   * resume cost an order of magnitude inside the 150ms budget. Note the *net*:
   * pages leaving the process reappear as the compressor's own allocation at
   * about 2:1, so a per-process reading alone overstates this by roughly double.
   *
   * On by default, and inert unless the platform can actually do it - which
   * today means Linux, with `tools/mem-trim` built, CAP_SYS_NICE granted, and
   * swap or zram configured. `trimCapability()` reports which of those is
   * missing rather than leaving a silent zero. Unlike page merging, this is not
   * gated behind a warning: KSM shares identical pages *between* processes and
   * programs, which is a genuine cross-site channel, whereas paging to a
   * compressor keeps each process's data to itself.
   */
  hibernate: {
    enabled: true,

    /**
     * How long a tab must be hidden before it is worth hibernating. Shorter
     * than `discardAfterMs`, because hibernation is lossless and cheap to undo,
     * so it is the step that should happen first and often.
     */
    afterMs: 3 * 60_000,

    /**
     * Private memory below which a tab is not worth the syscall.
     *
     * A floor on pointless work rather than a real threshold: the measured
     * curve has no dead zone, and even a 37MB tab returns 10.9MB. Below roughly
     * this, the absolute return falls under ~9MB and the resume stall stops
     * being free. Read from the OS for nothing, like `heapLimit.minPrivateMB`.
     */
    minPrivateMB: 30,

    /**
     * Turn the tier off at runtime if it does not pay on this host.
     *
     * Every measured figure here comes from one machine. If a real one returns
     * less than this per hibernation, the median over the first `sampleSize`
     * attempts falls below it and the tier disables itself with one log line,
     * rather than spending syscalls and resume stalls forever on a lever that
     * does nothing.
     */
    minReclaimMB: 5,
    sampleSize: 10
  },

  /**
   * Per-tab heap limits, after the square-root rule of arXiv:2204.10455.
   * See governor/heap-limit.js for the rule and for what is approximated here.
   */
  heapLimit: {
    /**
     * **Off by default, on a negative result.** The rule is implemented and
     * correct; it simply has little to act on in this browser.
     *
     * Two measurements decided it. First, V8's heap is a small part of what a
     * renderer holds: a settled DOM-heavy page reports about 2MB of committed
     * heap against 21MB of private memory, so even a perfect collection leaves
     * 90% of the tab untouched - the rest is DOM, Blink structures and malloc,
     * which no garbage collector reaches. Second, V8 already collects a
     * backgrounded heap on its own within about ten seconds, so forcing it
     * earlier mostly just does sooner what happens anyway: across twenty tabs,
     * with and without, the settled total differed by 1MB (488 vs 487).
     *
     * Against that, acting costs a debugger session of ~2.4MB per tab touched.
     * Turn it on with `--heap-limit` if your tabs allocate heavily in the
     * background, where the rule's steady-state behaviour has something to do.
     */
    enabled: false,

    /**
     * The rule's shared constant: the marginal GC time each heap is willing to
     * spend per unit of memory saved. Lower means more generous heap limits.
     * It is the single knob that moves the whole memory/GC-time trade-off, and
     * it must be the same for every heap or the allocation between them stops
     * being optimal.
     */
    c: 2e-8,

    /**
     * Multiplier on c for hidden tabs. Above 1 means a tighter limit, so more
     * collections and less memory. The paper permits per-heap weighting as long
     * as it is applied uniformly; a background tab's GC pause is invisible, so
     * it is the right place to spend collection time instead of memory.
     */
    backgroundWeight: 4,

    /**
     * Private memory below which a tab is never instrumented at all.
     *
     * Requesting a collection needs a debugger session costing ~2.4MB, and on a
     * light page that exceeds what the collection reclaims - measured net +7.1MB
     * for a light page against -6.8MB for a DOM-heavy one. The two differ in
     * private bytes (~10MB against ~21-25MB), so the threshold sits between
     * them. Read from the OS for free, so the expensive measurement is only
     * spent where it can pay for itself.
     */
    minPrivateMB: 16
  },

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
    coldAfterMs: 5_000,
    freezeAfterMs: 90_000,
    discardAfterMs: 3 * 60_000,
    minLifetimeMs: 45_000,
    discardFromPressure: Pressure.MODERATE,
    maxConcurrentLoads: 2,
    processPerSite: true,
    spareRenderer: false
  },

  /**
   * Lowest memory this browser can go, by giving up security isolation.
   *
   * Only choose this if you understand the trade: without site isolation, a
   * malicious page or third-party frame shares an address space with other
   * sites, and the browser's main defence against cross-site data theft is
   * gone. It is here because the memory saving is real and some people will
   * want it on a constrained machine for trusted browsing - not because it is
   * a good default.
   */
  minimal: {
    memoryBudgetMB: 600,
    tabFloorMB: 30,
    maxLiveTabs: 0,
    coldAfterMs: 5_000,
    freezeAfterMs: 90_000,
    discardAfterMs: 5 * 60_000,
    minLifetimeMs: 45_000,
    discardFromPressure: Pressure.MODERATE,
    maxConcurrentLoads: 2,
    processPerSite: true,
    spareRenderer: false,
    // The two settings that make this profile what it is.
    siteIsolation: false,
    rendererProcessLimit: 4
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

/**
 * Settings whose value is an object. A plain spread would replace these
 * wholesale, so a profile or override that sets one field of `boost` would
 * silently drop the rest - and, worse, leaving one out entirely would alias
 * BASE's object, letting a later `cfg.heapLimit.enabled = true` mutate the
 * module default for every config loaded afterwards.
 */
const NESTED = ['pressure', 'pressureAccel', 'boost', 'heapLimit', 'hibernate'];

function loadConfig(profileName = 'balanced', overrides = {}) {
  const profile = PROFILES[profileName] || PROFILES.balanced;
  const cfg = {
    ...BASE,
    ...profile,
    ...overrides,
    profile: PROFILES[profileName] ? profileName : 'balanced'
  };
  for (const key of NESTED) {
    cfg[key] = { ...BASE[key], ...profile[key], ...overrides[key] };
  }
  return cfg;
}

module.exports = {
  Tier, TIER_ORDER, tierRank, isStopped, Pressure, Demand, PROFILES, loadConfig, MB
};
