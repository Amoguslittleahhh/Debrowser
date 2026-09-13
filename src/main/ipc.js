'use strict';

/**
 * IPC between the browser process, page probes, and the browser chrome UI.
 *
 * Pages are untrusted, so the probe channel accepts only a small, validated
 * shape and identifies the sender by its WebContents id rather than by
 * anything the message claims about itself.
 */

const { ipcMain } = require('electron');

const VALID_DEMANDS = new Set(['idle', 'light', 'heavy']);

class IpcHub {
  /**
   * @param {() => Iterable<object>} getTabs
   * @param {(...args:any[]) => void} log
   */
  constructor(getTabs, log = () => {}) {
    this.getTabs = getTabs;
    this.log = log;
    this.nextRequestId = 1;
    /** @type {Map<number, {resolve:Function, timer:NodeJS.Timeout}>} */
    this.pending = new Map();
    this.wire();
  }

  wire() {
    ipcMain.on('debrowser:probe', (event, payload) => {
      const tab = this.tabForWebContents(event.sender.id);
      if (!tab) return;
      if (!payload || typeof payload !== 'object') return;

      // Reports are recorded from any tab, not just the visible one. The probe
      // only transmits on *change*, so discarding a report here would leave the
      // page believing the browser already knows a state it never received -
      // and the tab would then sit unboosted while visibly animating. Only the
      // active tab's demand is ever acted on; that filtering belongs in the
      // boost controller, not in the transport.
      const demand = VALID_DEMANDS.has(payload.demand) ? payload.demand : 'idle';
      tab.reportedDemand = demand;
      tab.reportedAnimations = Number(payload.animations) || 0;
      tab.reportedMedia = Boolean(payload.media);
      tab.lastProbeAt = Date.now();

      // An animation starting is the one signal worth acting on before the
      // next tick: engaging boost late is a visible stutter at the start of
      // every transition.
      if (demand === 'heavy') tab.lastHeavyAt = Date.now();
    });

    ipcMain.on('debrowser:capture-result', (_event, requestId, state) => {
      const entry = this.pending.get(requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      entry.resolve(state);
    });
  }

  /**
   * Ask a page for its scroll position and unsubmitted input.
   *
   * Always resolves, never rejects: a page blocked in its own script must not
   * be able to stall a reclaim. On timeout the caller simply gets `null` and
   * proceeds with navigation history alone.
   */
  request(webContents, timeoutMs = 400) {
    return new Promise((resolve) => {
      if (!webContents || webContents.isDestroyed()) return resolve(null);

      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.log(`page state capture timed out after ${timeoutMs}ms`);
        resolve(null);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(requestId, { resolve, timer });

      try {
        webContents.send('debrowser:capture', requestId);
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(null);
      }
    });
  }

  tabForWebContents(webContentsId) {
    for (const tab of this.getTabs()) {
      if (tab.wc && !tab.wc.isDestroyed() && tab.wc.id === webContentsId) return tab;
    }
    return null;
  }
}

module.exports = { IpcHub };
