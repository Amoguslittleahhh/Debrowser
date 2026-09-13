'use strict';

/**
 * Thin wrapper over `webContents.debugger`.
 *
 * Electron's public API exposes page lifecycle control only partially:
 * `setBackgroundThrottling` throttles timers, but nothing in the public
 * surface can freeze a page outright. That exists in the DevTools protocol, so
 * the governor drives it from here.
 *
 * Two CDP *memory* levers are deliberately absent, both removed after
 * measuring them rather than on principle:
 *
 *   `Memory.forciblyPurgeJavaScriptMemory` - the obvious choice for a
 *   memory-saving browser. On a page holding ~117MB it reclaimed 0MB on top of
 *   a preceding collection, and it tore down the renderer's isolated worlds,
 *   which killed the activity probe in every trimmed tab and turned any later
 *   IPC to that renderer into a segfault - a tab that died the moment the user
 *   clicked back to it.
 *
 *   `HeapProfiler.collectGarbage` - forcing a collection when a tab goes idle.
 *   Instantiating the heap profiler agent costs about 6MB per renderer and
 *   does not return it on detach, so on a typical page the call was a net
 *   +9MB; only a page with an unusually large collectable heap came out ahead.
 *   Across twelve tabs it cost ~90MB - more than the governor was saving.
 *   Chromium already reclaims a backgrounded renderer on its own and does it
 *   better (a heavy tab fell 117MB -> 107MB over a minute unaided, against
 *   112MB with a forced collection), so on an idle tab the correct action
 *   turned out to be no action at all.
 *
 * The memory savings in this browser therefore come from discarding tabs and
 * from the process configuration in platform.js, not from squeezing live
 * renderers. What remains here buys CPU, not memory.
 *
 * Every call is best-effort. A renderer can be mid-navigation, crashed, or
 * have DevTools attached by the user (which takes the debugger session away
 * from us). None of that should ever surface as an error in the browser, so
 * failures are swallowed and reported as `false`.
 */

/** Sentinel distinguishing a timeout from a command that legitimately returns null. */
const TIMED_OUT = Symbol('cdp-timeout');

/**
 * Ceiling for a CDP round trip. Generous enough that a busy renderer still
 * answers, short enough that a wedged one cannot stall a tab switch.
 */
const DEFAULT_TIMEOUT_MS = 2000;

class CdpSession {
  constructor(webContents, log = () => {}) {
    this.wc = webContents;
    this.log = log;
    this.attached = false;
    this.enabledDomains = new Set();
  }

  attach() {
    if (this.attached) return true;
    if (!this.wc || this.wc.isDestroyed()) return false;
    try {
      this.wc.debugger.attach('1.3');
      this.attached = true;
    } catch (err) {
      // Already attached by someone else (usually the user's DevTools window).
      this.attached = this.wc.debugger.isAttached();
      if (!this.attached) {
        this.log('cdp attach failed', err.message);
        return false;
      }
    }
    this.wc.debugger.once('detach', () => {
      this.attached = false;
      this.enabledDomains.clear();
    });
    return true;
  }

  detach() {
    if (!this.attached) return;
    try {
      this.wc.debugger.detach();
    } catch { /* already gone */ }
    this.attached = false;
    this.enabledDomains.clear();
  }

  /**
   * Send a CDP command, with a hard ceiling on how long it may take.
   *
   * Tab activation awaits an unfreeze, so a debugger call that never settles
   * would leave the user staring at a tab that refuses to open. Nothing in
   * this file is important enough to block the UI: on timeout the caller gets
   * `null` and falls back, exactly as it would for any other failure.
   */
  async send(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.attach()) return null;
    if (this.wc.isDestroyed()) return null;

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      const result = await Promise.race([this.wc.debugger.sendCommand(method, params), timeout]);
      if (result === TIMED_OUT) {
        this.log(`cdp ${method} timed out after ${timeoutMs}ms`);
        return null;
      }
      return result;
    } catch (err) {
      this.log(`cdp ${method} failed: ${err.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Enable a CDP domain once per session. */
  async enable(domain) {
    if (this.enabledDomains.has(domain)) return true;
    const ok = await this.send(`${domain}.enable`);
    if (ok !== null) {
      this.enabledDomains.add(domain);
      return true;
    }
    return false;
  }

  /**
   * Freeze the page. Chromium stops running timers, rAF, and most task
   * queues for this document: CPU falls to approximately zero while the heap,
   * the DOM, and the compositor's tiles all stay exactly as they were, so
   * resuming is instant and lossless.
   */
  async freeze() {
    // `Page.enable` is deliberately not called: the lifecycle command works
    // without it, and enabling the domain instantiates page instrumentation
    // in the renderer for no benefit. Measured, not assumed.
    const res = await this.send('Page.setWebLifecycleState', { state: 'frozen' });
    return res !== null;
  }

  /** Undo freeze(). Must be called before the page is shown again. */
  async unfreeze() {
    const res = await this.send('Page.setWebLifecycleState', { state: 'active' });
    return res !== null;
  }

  /**
   * Per-tab JS heap size. Unlike process RSS this is attributable to a single
   * page even when several tabs share a renderer process, so the governor uses
   * it to split shared-process memory fairly between its tabs.
   */
  async jsHeapBytes() {
    if (!(await this.enable('Performance'))) return null;
    const res = await this.send('Performance.getMetrics');
    if (!res || !Array.isArray(res.metrics)) return null;
    const metric = res.metrics.find((m) => m.name === 'JSHeapUsedSize');
    return metric ? metric.value : null;
  }
}

module.exports = { CdpSession };
