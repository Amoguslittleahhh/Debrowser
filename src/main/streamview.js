'use strict';

/**
 * Streaming views: the operating system's own web engine, placed over part of
 * a Debrowser window, for sites whose DRM only that engine can play.
 *
 *   Windows  WebView2 (Edge's engine)  -> PlayReady, as Edge gets it
 *   macOS    WebKit (WKWebView)        -> FairPlay, as Safari gets it
 *   Linux    none: Widevine covers it
 *
 * Chromium's Widevine is software-only here (L3), and Netflix, Disney+ and
 * Prime Video keep their HD and 4K for the hardware paths. Those paths belong
 * to Windows and macOS, certified by Microsoft and Apple; this only hosts the
 * engine that uses them. See native/streamview.
 *
 * Nothing here runs unless a streaming view is asked for, and the engine's
 * processes end with the last view.
 */

const { EventEmitter } = require('events');
const { screen } = require('electron');
const path = require('path');
const fs = require('fs');

/** The identity WebKit's FairPlay path is served under: the services turn away WebKit's own. */
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.5 Safari/605.1.15';

let native;

/** The native module, or null where there is none (Linux, or a build without it). */
function load() {
  if (native !== undefined) return native;
  native = null;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return native;
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'streamview', 'streamview.node'),
    path.join(__dirname, '..', '..', 'vendor', 'streamview', `${process.platform}-${process.arch}`, 'streamview.node')
  ].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const mod = require(file);
      mod.setEventHandler((event) => {
        if (event.type === 'presence') {
          const resolve = presenceAsks.get(event.a);
          if (resolve) { presenceAsks.delete(event.a); resolve(event.b); }
          return;
        }
        const view = views.get(event.id);
        if (view) view.receive(event);
      });
      // Only now: a module whose events cannot arrive would leave every
      // answer - the Windows Hello one included - waiting for ever.
      native = mod;
      return native;
    } catch (err) {
      console.error(`[debrowser] streamview: could not load ${file}: ${err.message}`);
    }
  }
  return native;
}

const views = new Map();
const presenceAsks = new Map();
let nextToken = 1;

/**
 * Windows Hello for `window`, asked from this process (presence.js).
 *
 * @returns {Promise<number|null>} the UserConsentVerificationResult - 0 is
 *   verified - or null where this cannot ask: no module, or the call failed
 */
function verifyPresence(window, message, timeoutMs = 5 * 60_000) {
  const mod = load();
  if (!mod || typeof mod.verifyPresence !== 'function' || !window || window.isDestroyed()) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const token = String(nextToken++);
    // Windows' own prompt waits as long as the person needs; this is only for
    // an answer that will never come. Given up on, the prompt is taken down
    // too - left up, finishing it did nothing and the next try stacked a
    // second. A "no" (a number other than 0), not "could not ask", so nothing
    // falls back to asking again.
    const timer = setTimeout(() => {
      presenceAsks.delete(token);
      try { if (typeof mod.cancelPresence === 'function') mod.cancelPresence(token); } catch { /* already gone */ }
      resolve(-1);
    }, timeoutMs);
    presenceAsks.set(token, (answer) => {
      clearTimeout(timer);
      resolve(/^\d+$/.test(answer) ? Number(answer) : null);
    });
    try {
      mod.verifyPresence(window.getNativeWindowHandle(), String(message), token);
    } catch {
      clearTimeout(timer);
      presenceAsks.delete(token);
      resolve(null);
    }
  });
}

class StreamView extends EventEmitter {
  /**
   * @param {Electron.BaseWindow} window - the view goes over its content
   * @param {{url?: string, bounds: {x:number,y:number,width:number,height:number}, userDataDir?: string}} opts
   */
  constructor(window, { url = '', bounds, userDataDir = '' }) {
    super();
    const mod = load();
    if (!mod) throw new Error('streaming views are not available on this system');
    this.pending = new Map();
    this.ready = false;
    this.window = window;
    this.id = mod.create(window.getNativeWindowHandle(), {
      url, userDataDir, ...this.physical(bounds),
      userAgent: process.platform === 'darwin' ? SAFARI_UA : ''
    });
    views.set(this.id, this);
  }

  receive({ type, a, b }) {
    if (type === 'ready') { this.ready = true; this.emit('ready', { userAgent: a }); return; }
    if (type === 'script') {
      const resolve = this.pending.get(a);
      if (resolve) { this.pending.delete(a); resolve(b); }
      return;
    }
    this.emit(type, a, b);
  }

  navigate(url) { if (native && this.id) native.navigate(this.id, url); }

  /**
   * Bounds as the engine takes them. Electron speaks in scaled units (DIPs);
   * WebView2 places itself in the parent window's physical pixels, so at 150%
   * a view given DIPs covered two-thirds of what it was meant to. WebKit on
   * macOS works in points, as Electron does.
   */
  physical({ x, y, width, height }) {
    const scale = process.platform === 'win32' && this.window && !this.window.isDestroyed()
      ? screen.getDisplayMatching(this.window.getBounds()).scaleFactor : 1;
    return { x: Math.round(x * scale), y: Math.round(y * scale),
      width: Math.round(width * scale), height: Math.round(height * scale) };
  }

  setBounds(bounds) {
    if (!native || !this.id) return;
    const { x, y, width, height } = this.physical(bounds);
    native.setBounds(this.id, x, y, width, height);
  }

  /** The engine's inspector (Windows), or inspectable from Safari (macOS). */
  openDevTools() { if (native && this.id && native.openDevTools) native.openDevTools(this.id); }

  setVisible(visible) { if (native && this.id) native.setVisible(this.id, Boolean(visible)); }

  /** Runs a script in the page; resolves with its value parsed from JSON (promises are not awaited). */
  executeScript(script) {
    return new Promise((resolve) => {
      if (!native || !this.id) { resolve(null); return; }
      const token = String(nextToken++);
      this.pending.set(token, (json) => {
        try { resolve(JSON.parse(json)); } catch { resolve(json); }
      });
      native.executeScript(this.id, token, script);
    });
  }

  destroy() {
    if (!this.id) return;
    views.delete(this.id);
    if (native) native.destroy(this.id);
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    this.id = 0;
  }
}

module.exports = { StreamView, available: () => Boolean(load()), verifyPresence, SAFARI_UA };
