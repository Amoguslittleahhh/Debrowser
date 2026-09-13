'use strict';

/**
 * Thin wrapper over `webContents.debugger`.
 *
 * Electron's public API exposes page lifecycle control only partially:
 * `setBackgroundThrottling` throttles timers, but nothing in the public
 * surface can freeze a page outright. That exists in the DevTools protocol, so
 * the governor drives it from here.
 *
 * On the two CDP *memory* levers, both of which were got wrong at least once:
 *
 *   `Memory.forciblyPurgeJavaScriptMemory` is absent for good. On a page
 *   holding ~117MB it reclaimed 0MB on top of a preceding collection, and it
 *   tore down the renderer's isolated worlds - killing the activity probe in
 *   every trimmed tab and turning any later IPC to that renderer into a
 *   segfault, a tab that died the moment the user clicked back to it.
 *
 *   `HeapProfiler.collectGarbage` is present, but gated. It was removed once on
 *   the strength of an RSS measurement showing a flat net loss (+9MB per tab),
 *   and that measurement was wrong - RSS cannot see a 2.4MB instrumentation
 *   cost through shared-page noise. In proportional set size the call is
 *   page-dependent: net -6.8MB on a DOM-heavy page, net +7.1MB on a light one.
 *   So it pays, on the right tabs, and governor/heap-limit.js decides which
 *   using the square-root heap limit rule. Chromium still reclaims backgrounded
 *   renderers on its own, so this supplements that rather than replacing it.
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
   * Per-page heap size and cumulative CPU time.
   *
   * Both matter because a process figure cannot be divided up honestly. When
   * several tabs share a renderer - the default, since one renderer per *site*
   * is the largest memory saving available - asking the OS how much memory or
   * CPU "that tab" used has no answer. These two metrics are per-document, so
   * they give the governor something real to work from:
   *
   *   JSHeapUsedSize  splits the process's memory between its tabs by weight
   *   TaskDuration    cumulative seconds of main-thread work for this page;
   *                   differenced over wall time it yields that page's own CPU
   *
   * Without the second one, a single busy tab in a shared renderer makes every
   * tab in that renderer look equally busy, and the governor starts freezing
   * pages that were doing nothing at all.
   */
  async pageMetrics() {
    if (!(await this.enable('Performance'))) return null;
    const res = await this.send('Performance.getMetrics');
    if (!res || !Array.isArray(res.metrics)) return null;
    const value = (name) => res.metrics.find((m) => m.name === name)?.value;
    return {
      // Used is the live set (L in the heap-limit rule); total is how much the
      // heap has actually committed. The difference is the slack a collection
      // can hand back, and it is often most of what a renderer is holding: a
      // page can show 1MB used against 20MB+ of committed pages.
      jsHeapBytes: value('JSHeapUsedSize') ?? null,
      jsHeapTotalBytes: value('JSHeapTotalSize') ?? null,
      taskDurationSec: value('TaskDuration') ?? null
    };
  }

  /**
   * Ask this renderer to run a full garbage collection, reporting how long it
   * took so the caller can estimate this heap's collection speed.
   *
   * Only for tabs chosen by governor/heap-limit.js - never unconditionally. See
   * the note on this call in the file header for why.
   *
   * @returns {{ms:number}|null}
   */
  async collectGarbage() {
    const started = Date.now();
    const res = await this.send('HeapProfiler.collectGarbage', {}, 5000);
    if (res === null) return null;
    return { ms: Date.now() - started };
  }
}

module.exports = { CdpSession };
