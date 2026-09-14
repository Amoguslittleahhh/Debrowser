'use strict';

/**
 * Tier transitions: the concrete actions behind each resource level.
 *
 * The ladder is deliberately graduated rather than binary. Chrome's model is
 * essentially "resident or discarded"; the useful states are in between, and
 * they differ in *what* they cost the user to undo:
 *
 *   WARM      timers throttled. Undo cost: nothing.
 *   COLD      no renderer action; marks the tab as a discard candidate. See
 *             the note in `demote` - forcing a collection here was measured
 *             and cost more than it saved.
 *   FROZEN    page's task queues stopped. CPU falls to ~0 while the heap, DOM
 *             and compositor tiles survive intact. Undo cost: one CDP round
 *             trip, imperceptible. Note this tier *costs* a few megabytes
 *             rather than saving any - it also stops the renderer tasks that
 *             reclaim memory in the background - so the governor applies it
 *             only to tabs still consuming CPU out of sight.
 *   HIBERNATED frozen, then the renderer's cold pages handed to the OS
 *             compressor. Undo cost: the pages fault back, measured at 4-12ms.
 *             Nothing is lost, which is what makes it the one reclaim available
 *             on a tab the protections refuse to destroy.
 *   DISCARDED renderer destroyed. Undo cost: a reload. Reserved for genuine
 *             memory contention, never used on a schedule alone.
 *
 * Promotion always runs the inverse in the right order, and always completes
 * before the tab is shown.
 */

const { Tier, tierRank, isStopped } = require('../config');
const platform = require('../platform');

/**
 * Move a tab to a tier. Idempotent: re-applying the current tier is a no-op
 * apart from refreshing process priority, which other subsystems may have
 * changed underneath us.
 *
 * A demotion can stop short: freezing is refused, or the trim behind
 * HIBERNATED is unavailable. So `promote` and `demote` return *the tier the tab
 * actually reached*, never a success flag, and this is the one place that
 * records a tier change. Those paths used to assign `tab.tier` themselves and
 * report failure, which left the tab in a tier nobody was told about -
 * `tierChangedAt` stale, no `updated` event, and the governor's counters keyed
 * off a transition reported as not having happened.
 *
 * @param {object} tab
 * @param {string} target
 * @param {object} ctx - { cfg, ipcHub, log }
 * @returns {Promise<string|null>} the tier now in effect, or null if unmoved
 */
async function applyTier(tab, target, ctx) {
  const { cfg, log } = ctx;
  const current = tab.tier;
  if (current === target && target !== Tier.ACTIVE) {
    refreshPriority(tab, cfg);
    return null;
  }

  const goingUp = tierRank(target) < tierRank(current);
  const reached = goingUp
    ? await promote(tab, target, ctx)
    : await demote(tab, target, ctx);

  if (!reached || reached === current) return null;

  tab.tier = reached;
  tab.tierChangedAt = Date.now();
  log(`tab ${tab.id}: ${current} -> ${reached}`);
  tab.emit('updated');
  return reached;
}

/* ------------------------------------------------------------------ */
/* Promotion                                                           */
/* ------------------------------------------------------------------ */

async function promote(tab, target, ctx) {
  const { cfg, log } = ctx;

  // A discarded tab has no renderer at all; rebuild it first.
  if (!tab.isLive) {
    tab.realise();
    // `realise` restores navigation and sets its own provisional tier.
  }

  // Undo the trim before the unfreeze. On Linux this is a no-op - paged-out
  // memory faults back on its own, measured at 4-12ms - but the ordering is
  // what a platform needing a real undo would require, and getting it wrong
  // there means a restored tab that stays throttled.
  if (tab.tier === Tier.HIBERNATED) platform.untrimProcessMemory(tab.pid);

  // Undo freezing before anything else: a stopped page cannot run the script
  // that would repaint it, so showing it first would flash stale content.
  if (tab.cdp && tierRank(tab.tier) >= tierRank(Tier.FROZEN)) {
    await tab.cdp.unfreeze();
  }

  // The foreground tab needs no instrumentation: nothing freezes, collects or
  // measures it. Detaching releases the protocol agents Chromium instantiated
  // inside that renderer, which are not free - and it guarantees the governor
  // has no channel open to the one page the user is actually looking at.
  if (target === Tier.ACTIVE && tab.cdp) {
    tab.cdp.detach();
  }

  // Note: background throttling is deliberately left to Chromium, which
  // already throttles a hidden page's timers and rAF on its own. Toggling
  // `setBackgroundThrottling` at runtime would add nothing on top of that -
  // a visible page is not throttled either way - while touching renderer
  // preferences on a page the governor may have just frozen.
  refreshPriority(tab, cfg, target);
  return target;
}

/* ------------------------------------------------------------------ */
/* Demotion                                                            */
/* ------------------------------------------------------------------ */

async function demote(tab, target, ctx) {
  const { cfg, ipcHub, log } = ctx;

  if (target === Tier.DISCARDED) {
    return discard(tab, ctx);
  }

  if (!tab.isLive) return null;

  refreshPriority(tab, cfg, target);

  // Re-snapshot scroll position and unsubmitted input on every step down,
  // while the page can still answer. A frozen page cannot reply, and by
  // discard time a tab usually is frozen, so the snapshot has to be taken
  // before that - and refreshed each step, because the page may have gone on
  // running (and the user may have typed into it) since the last one.
  //
  // This deliberately does not key off the ACTIVE -> WARM transition alone. A
  // tab opened in the background never makes that transition: it is realised
  // straight into WARM. Keying off it meant a background tab holding a filled-
  // in form was never snapshotted, so `hasDirtyInput` stayed false and the
  // protection against discarding unsubmitted input silently did not apply to
  // exactly the tabs most likely to be discarded.
  await tab.capturePageState(ipcHub);

  // COLD performs no action on the renderer, and that is deliberate rather
  // than unfinished. Forcing a collection here was measured as a net loss
  // (see CdpSession's header), and Chromium reclaims a backgrounded renderer
  // on its own, more deeply than a forced collection does. The tier exists to
  // mark a tab as having been idle long enough to be a discard candidate -
  // which is the reclaim that actually returns memory.

  // Only when the freeze step lies between where the tab is and where it is
  // going. A tab stepping from FROZEN to HIBERNATED has already been through
  // it, and freezing again would re-attach the debugger session the freeze
  // below deliberately detached - paying ~2.4MB inside the renderer, on the
  // tier whose entire purpose is to give memory back, moments before trimming.
  if (tierRank(target) >= tierRank(Tier.FROZEN) && tierRank(tab.tier) < tierRank(Tier.FROZEN)) {
    const frozen = await tab.cdp.freeze();
    if (!frozen) {
      // Freezing is the one step that can legitimately fail (DevTools
      // attached, page in an unfreezable state such as holding a lock). Stay
      // at COLD rather than reporting a tier we are not actually in.
      log(`tab ${tab.id}: freeze refused; holding at cold`);
      return Tier.COLD;
    }

    // A frozen page stays frozen after the debugger goes away, so there is no
    // reason to keep a session open on it. Detaching returns the protocol
    // agents' memory and leaves nothing attached to the long tail of tabs that
    // spend most of their life in this state. Unfreezing re-attaches on demand.
    tab.cdp.detach();
  }

  if (target === Tier.HIBERNATED) {
    // Strictly after the freeze. Trimming a page still running its own tasks
    // just means it faults everything straight back in, and the freeze is what
    // makes the pages cold enough to be worth taking.
    //
    // Deduplicating repeat trims of one renderer is `trimProcessMemory`'s job,
    // not this function's: a trim acts on a process, several tabs of a site
    // share one, and the tier ladder walks tabs. It reports 0 bytes for a
    // redundant call, which is a fine outcome here - null is the only refusal.
    const advised = await platform.trimProcessMemory(tab.pid, log);
    if (advised == null) {
      // Trimming is unavailable or was refused. The tab is frozen, which is a
      // legitimate tier, so report that rather than a state it is not in.
      log(`tab ${tab.id}: trim unavailable; holding at frozen`);
      return Tier.FROZEN;
    }
    tab.trimmedAt = Date.now();
  }

  return target;
}

/**
 * Destroy the renderer, keeping everything needed to rebuild the page.
 *
 * The capture happens *before* teardown and is bounded by a timeout: a page
 * blocked in its own script must not be able to stall the reclaim that is
 * trying to relieve memory pressure.
 */
async function discard(tab, ctx) {
  const { ipcHub, log } = ctx;

  // Refresh the snapshot only if the page can still answer. A frozen tab
  // already has one, taken when it was demoted to COLD.
  // Only an unstopped page can answer; a hibernated one is as mute as a frozen
  // one and already had its snapshot taken on the way down.
  if (!isStopped(tab.tier)) {
    try {
      await tab.capturePageState(ipcHub);
    } catch (err) {
      log(`tab ${tab.id}: page state capture failed: ${err.message}`);
    }
  }

  tab.captureNavigation();

  if (tab.hasDirtyInput) {
    // The snapshot revealed unsubmitted input after all. Freezing keeps the
    // page perfectly intact at near-zero CPU, so take that instead and lose
    // nothing; the memory stays, and that is the correct trade.
    log(`tab ${tab.id}: discard cancelled, holds unsubmitted input`);
    if (isStopped(tab.tier)) return tab.tier;       // already stopped; leave it there
    const frozen = tab.cdp ? await tab.cdp.freeze() : false;
    return frozen ? Tier.FROZEN : tab.tier;
  }

  tab.teardownView();
  return Tier.DISCARDED;
}

/* ------------------------------------------------------------------ */

/**
 * Process priority for a tier. Background renderers are niced *down*, which
 * needs no privileges on any platform, and is what actually leaves CPU
 * headroom for whatever the user is looking at.
 */
function refreshPriority(tab, cfg, tier = tab.tier) {
  if (!tab.pid) return;
  if (tab.boosted) return; // the boost controller owns this tab's priority

  const priority = tier === Tier.ACTIVE
    ? cfg.boost.niceForeground
    : cfg.boost.niceBackground;

  platform.setProcessPriority(tab.pid, priority);
  tab.priority = priority;
}

module.exports = { applyTier, refreshPriority };
