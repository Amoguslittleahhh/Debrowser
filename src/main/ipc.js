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
      // Gates the restore thumbnail; see Tab#captureThumbnail. Reported by the
      // probe rather than only by the page-state snapshot, because the snapshot
      // is taken on demotion - after the user has already switched away, and so
      // after the screenshot would already have been taken.
      tab.hasSensitiveFields = Boolean(payload.sensitive);
      // Defence in depth against the race this signal exists to close. A page
      // can grow a credential field after it was photographed - a single-page
      // app routing to a sign-in form, a late-rendering login modal - and the
      // picture on disk is then of exactly the page that must not have one. So
      // the report does not merely gate future captures; it revokes past ones.
      if (tab.hasSensitiveFields) tab.discardThumbnail();
      tab.lastProbeAt = Date.now();

      // An animation starting is the one signal worth acting on before the
      // next tick: engaging boost late is a visible stutter at the start of
      // every transition.
      if (demand === 'heavy') tab.lastHeavyAt = Date.now();
    });

    ipcMain.on('debrowser:capture-result', (event, requestId, state) => {
      const entry = this.pending.get(requestId);
      if (!entry) return;

      // The reply has to come from the renderer that was asked.
      //
      // Request ids are a counter, so they are guessable, and this resolved on
      // the id alone - which let any renderer answer another tab's capture. The
      // forged reply is not inert: `applySuspendedPageState` writes the fields
      // back with `el.innerHTML = field.value` into whatever document the real
      // tab restores, so one compromised page could put markup into a different
      // origin's DOM. Every other channel in this file already checks the
      // sender; this one said it did and did not.
      if (event.sender.id !== entry.senderId) {
        this.log(`ignored a capture reply for ${requestId} from the wrong renderer`);
        return;
      }

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

      // The id alone is not proof of who is answering. Recorded with the
      // renderer it was sent to, so the reply can be checked against it.
      this.pending.set(requestId, { resolve, timer, senderId: webContents.id });

      try {
        webContents.send('debrowser:capture', requestId);
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(null);
      }
    });
  }

  /**
   * A page offering a sign-in it has just submitted.
   *
   * The origin is taken from the tab's own URL, never from the payload. A page
   * that claimed someone else's origin would otherwise get a credential saved
   * under it - and then offered back on the real site.
   */
  wireCredentialOffer(onOffer) {
    ipcMain.on('debrowser:credential-offer', (event, payload) => {
      const tab = this.tabForWebContents(event.sender.id);
      if (!tab || tab.internal) return;
      if (!payload || typeof payload !== 'object') return;
      if (typeof payload.password !== 'string' || !payload.password) return;

      // One below each limit, not exactly it: the store's validators are
      // `< 512` and `< 1024`, so truncating *to* the limit produced a value the
      // user had already agreed to save and the store then silently refused.
      const username = typeof payload.username === 'string' ? payload.username.slice(0, 511) : '';
      onOffer(tab, { username, password: payload.password.slice(0, 1023) });
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
