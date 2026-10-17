'use strict';

/**
 * Animation-aware CPU boosting.
 *
 * The rule this implements: a page that is animating gets whatever CPU it
 * needs to hold its frame rate, and the instant it stops it gives that back.
 *
 * Two things make this work rather than just sound good:
 *
 * 1. **Engage fast, release slow.** Boost is applied on the first tick that
 *    sees animation demand, because being late here is a visible stutter at
 *    the start of every transition. Release waits for a quiet period long
 *    enough to ride through the gap between two bursts - the pause between
 *    chained CSS transitions, a scroll fling settling - so we never drop the
 *    tab's priority in the middle of what the user perceives as one motion.
 *
 * 2. **Nothing expensive runs during an animation.** The reclaim work this
 *    browser does - freezing, discarding - stalls a renderer for milliseconds
 *    at a time. Doing that anywhere while the foreground tab is animating is
 *    exactly how a "memory saver" ends up feeling janky, so the governor asks
 *    here first and defers all of it until the animation has ended.
 *
 * Signal fusion: the in-page probe sees CSS/Web Animations and media, but
 * being in an isolated world it cannot see a script-driven `requestAnimationFrame`
 * loop. Renderer CPU covers that blind spot - a canvas or WebGL loop is
 * unmistakable in process CPU - so the two are combined here and the stronger
 * signal wins.
 */

const { Demand } = require('../config');
const platform = require('../platform');

/** Sustained renderer CPU that implies a script-driven animation loop. */
const CPU_HEAVY_PCT = 18;
const CPU_LIGHT_PCT = 6;

class BoostController {
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.boostedTabId = null;
    /** Tabs whose priority we raised, so we can always put them back. */
    this.yieldedPids = new Set();
    this.warnedAboutPrivileges = false;
    /** True while the only thing making the active tab heavy is its audio. */
    this.audioOnly = false;
  }

  /**
   * Fuse the probe's report with measured CPU into a single demand level.
   * @param {object} tab
   * @returns {'idle'|'light'|'heavy'}
   */
  demandFor(tab) {
    const reported = tab.reportedDemand || Demand.IDLE;
    const cpu = tab.cpu || 0;

    // Audible media is always heavy: dropping audio is more noticeable than
    // dropping frames, and it is the one signal that is reliable even when
    // the page is doing its work off the main thread.
    let fromCpu = Demand.IDLE;
    if (cpu >= CPU_HEAVY_PCT) fromCpu = Demand.HEAVY;
    else if (cpu >= CPU_LIGHT_PCT) fromCpu = Demand.LIGHT;

    const drawn = maxDemand(reported, fromCpu);
    if (!tab.audible) { this.audioOnly = false; return drawn; }

    // Audio is remembered separately from the level it produces.
    //
    // It still forces HEAVY - dropping audio is more noticeable than dropping
    // frames, and it is the one signal that stays reliable when a page does its
    // work off the main thread. But a tab that is *only* audible is not
    // animating, and `quiesceRequested` exists to defer reclaim while frames
    // are being drawn. Without this distinction a foreground tab playing music
    // refreshed the boost on every tick and stood the entire governor down -
    // budget enforcement, the live-tab cap, heap limits, hibernation and
    // speculation - for the whole of playback. That is the same session-wide
    // stand-down the stale-boost fix below was written to prevent, reached by a
    // different route.
    this.audioOnly = drawn !== Demand.HEAVY;
    return Demand.HEAVY;
  }

  /**
   * Re-evaluate boost state for the active tab. Called once per governor tick.
   * @param {object|null} activeTab
   * @param {Iterable<object>} allTabs
   */
  update(activeTab, allTabs) {
    const now = Date.now();

    if (!activeTab) {
      this.releaseAll(allTabs);
      return;
    }

    // A boost belongs to the tab the user is looking at. Everything below only
    // ever released one when the boosted tab *was* the active tab, so switching
    // away from an animating page left the boost in place permanently - and
    // with it `quiesceRequested`, which stands the governor down. Budget
    // enforcement, the live-tab cap, heap limits, hibernation and speculation
    // all stopped for the rest of the session, and closing the tab made it
    // unrecoverable because nothing was left to match against.
    if (this.boostedTabId !== null && this.boostedTabId !== activeTab.id) {
      const stale = [...allTabs].find((t) => t.id === this.boostedTabId);
      if (stale) this.release(stale, allTabs);
      else {
        // The tab is gone. Clear directly and put everyone else back.
        this.boostedTabId = null;
        this.unyieldOthers(allTabs);
      }
    }

    const demand = this.demandFor(activeTab);
    activeTab.demand = demand;

    if (demand === Demand.HEAVY) {
      activeTab.lastHeavyAt = now;
      this.engage(activeTab, allTabs);
      return;
    }

    // Not heavy right now - but only stand down once the quiet period elapses.
    const quietFor = now - (activeTab.lastHeavyAt || 0);
    if (this.boostedTabId === activeTab.id && quietFor < this.cfg.boost.decayMs) {
      return; // still inside the hysteresis window; hold the boost
    }

    if (this.boostedTabId === activeTab.id) {
      this.release(activeTab, allTabs);
    } else {
      // Unboosted foreground tab still runs at normal priority, never niced.
      this.setPriority(activeTab, this.cfg.boost.niceForeground);
    }
  }

  /**
   * Raise the animating tab above everything else.
   *
   * On an unprivileged process we cannot lower our own nice value, so the
   * meaningful half of this is the second step: every *other* renderer stands
   * down. On a contended machine that is what actually protects the frame
   * rate, and it needs no privileges on any platform.
   */
  engage(tab, allTabs) {
    if (this.boostedTabId === tab.id) return;

    this.boostedTabId = tab.id;
    tab.boosted = true;
    tab.boostedAt = Date.now();

    // Cancel any pending settle aimed at this tab; it is busy again.
    tab.pendingSettleAt = 0;

    const raised = this.setPriority(tab, this.cfg.boost.niceBoosted);
    if (!raised && !this.warnedAboutPrivileges && !platform.canRaisePriority()) {
      this.warnedAboutPrivileges = true;
      this.log('boost: cannot raise renderer priority without privileges; ' +
               'relying on background renderers yielding instead');
    }

    this.yieldOthers(tab, allTabs);
    this.log(`boost engaged for tab ${tab.id} (${tab.demand})`);
  }

  /** Stand down: baseline priority, restore the other renderers. */
  release(tab, allTabs) {
    if (this.boostedTabId !== tab.id) return;

    this.boostedTabId = null;
    tab.boosted = false;
    this.setPriority(tab, this.cfg.boost.niceForeground);
    this.unyieldOthers(allTabs);

    // The animation is over and its CPU is already handed back. Mark the tab
    // to be re-examined once it has been quiet a little longer, so the
    // governor sees a settled page rather than one mid-teardown.
    tab.pendingSettleAt = Date.now() + this.cfg.boost.settleAfterMs;

    this.log(`boost released for tab ${tab.id}`);
  }

  releaseAll(allTabs) {
    if (this.boostedTabId !== null) {
      const tab = [...allTabs].find((t) => t.id === this.boostedTabId);
      if (tab) this.release(tab, allTabs);
      else {
        this.boostedTabId = null;
        this.unyieldOthers(allTabs);
      }
    }
  }

  /**
   * Ask every other renderer to step back one priority notch while a boost is
   * in effect. Deliberately additive to whatever the governor already set, and
   * always undone in `unyieldOthers`.
   */
  yieldOthers(boostedTab, allTabs) {
    // Read once per tab. `Tab#pid` is a live getter now - it asks the renderer
    // rather than returning a field, because a cached one goes stale the moment
    // a tab navigates across sites - so four reads in this loop were four
    // native calls per tab per boost.
    const boostedPid = boostedTab.pid;
    for (const tab of allTabs) {
      const pid = tab.pid;
      if (tab.id === boostedTab.id || !pid) continue;
      if (pid === boostedPid) continue;          // same process; cannot differentiate
      if (this.yieldedPids.has(pid)) continue;
      if (platform.setProcessPriority(pid, this.cfg.boost.niceBackground)) {
        this.yieldedPids.add(pid);
      }
    }
  }

  unyieldOthers(allTabs) {
    if (!this.yieldedPids.size) return;
    const byPid = new Map();
    for (const tab of allTabs) {
      const pid = tab.pid;
      if (pid) byPid.set(pid, tab);
    }

    for (const pid of this.yieldedPids) {
      const tab = byPid.get(pid);
      // Put the process back to whatever its tab's own tier calls for; a tab
      // that has since been demoted stays niced by the governor's own rule.
      const target = tab && tab.visible ? this.cfg.boost.niceForeground : this.cfg.boost.niceBackground;
      platform.setProcessPriority(pid, target);
    }
    this.yieldedPids.clear();
  }

  setPriority(tab, priority) {
    const pid = tab.pid;
    if (!pid) return false;
    const ok = platform.setProcessPriority(pid, priority);
    if (ok) tab.priority = priority;
    return ok;
  }

  /**
   * Whether the governor should hold off on stalling work this tick.
   * True while anything is animating in front of the user.
   */
  get quiesceRequested() {
    // A boost held only because a tab is making noise is not a reason to stop
    // reclaiming memory. Nothing is being drawn, so nothing can stutter.
    return this.boostedTabId !== null && !this.audioOnly;
  }

  /** Tabs that have now been quiet long enough to count as settled. */
  dueSettles(allTabs) {
    const now = Date.now();
    const due = [];
    for (const tab of allTabs) {
      if (tab.pendingSettleAt && now >= tab.pendingSettleAt) {
        tab.pendingSettleAt = 0;
        due.push(tab);
      }
    }
    return due;
  }
}

const RANK = { [Demand.IDLE]: 0, [Demand.LIGHT]: 1, [Demand.HEAVY]: 2 };
function maxDemand(a, b) {
  return (RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b;
}

module.exports = { BoostController, maxDemand };
