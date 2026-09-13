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
 *   DISCARDED renderer destroyed. Undo cost: a reload. Reserved for genuine
 *             memory contention, never used on a schedule alone.
 *
 * Promotion always runs the inverse in the right order, and always completes
 * before the tab is shown.
 */

const { Tier, tierRank } = require('../config');
const platform = require('../platform');

/**
 * Move a tab to a tier. Idempotent: re-applying the current tier is a no-op
 * apart from refreshing process priority, which other subsystems may have
 * changed underneath us.
 *
 * @param {object} tab
 * @param {string} target
 * @param {object} ctx - { cfg, ipcHub, log }
 */
async function applyTier(tab, target, ctx) {
  const { cfg, log } = ctx;
  const current = tab.tier;
  if (current === target && target !== Tier.ACTIVE) {
    refreshPriority(tab, cfg);
    return false;
  }

  const goingUp = tierRank(target) < tierRank(current);
  const ok = goingUp
    ? await promote(tab, target, ctx)
    : await demote(tab, target, ctx);

  if (ok) {
    tab.tier = target;
    tab.tierChangedAt = Date.now();
    log(`tab ${tab.id}: ${current} -> ${target}`);
    tab.emit('updated');
  }
  return ok;
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

  // Undo freezing before anything else: a frozen page cannot run the script
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
  return true;
}

/* ------------------------------------------------------------------ */
/* Demotion                                                            */
/* ------------------------------------------------------------------ */

async function demote(tab, target, ctx) {
  const { cfg, ipcHub, log } = ctx;

  if (target === Tier.DISCARDED) {
    return discard(tab, ctx);
  }

  if (!tab.isLive) return false;

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

  if (tierRank(target) >= tierRank(Tier.FROZEN)) {
    const frozen = await tab.cdp.freeze();
    if (!frozen) {
      // Freezing is the one step that can legitimately fail (DevTools
      // attached, page in an unfreezable state such as holding a lock). Stay
      // at COLD rather than reporting a tier we are not actually in.
      log(`tab ${tab.id}: freeze refused; holding at cold`);
      tab.tier = Tier.COLD;
      return false;
    }

    // A frozen page stays frozen after the debugger goes away, so there is no
    // reason to keep a session open on it. Detaching returns the protocol
    // agents' memory and leaves nothing attached to the long tail of tabs that
    // spend most of their life in this state. Unfreezing re-attaches on demand.
    tab.cdp.detach();
  }

  return true;
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
  if (tab.tier !== Tier.FROZEN) {
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
    if (tab.cdp) await tab.cdp.freeze();
    tab.tier = Tier.FROZEN;
    return false;
  }

  tab.teardownView();
  return true;
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
