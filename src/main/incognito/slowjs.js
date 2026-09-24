'use strict';

/**
 * A quiet hint for when Balanced JavaScript is too slow for a page.
 *
 * Balanced runs without the optimising compilers, which is where most attacks
 * on the engine land and also where heavy pages get their speed. When the tab
 * in front keeps a processor core busy for more than BUSY_MS, the window says
 * once that Full speed exists and what it costs. It never switches by itself:
 * the level is process-wide, so changing it means a new private window, and
 * whatever is signed in here is lost with this one.
 */

/** "Busy": most of a core, as the governor measures a tab (percent of one core). */
const BUSY_CPU = 80;
const BUSY_MS = 10_000;

class SlowJsHint {
  constructor(jsLevel) {
    this.enabled = jsLevel !== 'full';
    this.busyFor = 0;
    this.lastAt = 0;
    this.tabId = null;
    this.shown = null;          // the tab the hint was shown for
    this.dismissed = false;
  }

  /** Called on every governor tick. Returns true when the hint just appeared. */
  observe(tab, now = Date.now()) {
    if (!this.enabled || this.dismissed || this.shown != null) return false;
    const dt = this.lastAt ? Math.min(now - this.lastAt, 5000) : 0;
    this.lastAt = now;
    if (!tab || tab.id !== this.tabId) { this.tabId = tab ? tab.id : null; this.busyFor = 0; return false; }
    this.busyFor = (tab.cpu || 0) >= BUSY_CPU ? this.busyFor + dt : 0;
    if (this.busyFor < BUSY_MS) return false;
    this.shown = tab.id;
    return true;
  }

  /** Whether to show it now: only over the tab it was about. */
  visibleFor(tab) {
    return !this.dismissed && this.shown != null && tab != null && tab.id === this.shown;
  }

  dismiss() {
    this.dismissed = true;
  }
}

module.exports = { SlowJsHint, BUSY_CPU, BUSY_MS };
