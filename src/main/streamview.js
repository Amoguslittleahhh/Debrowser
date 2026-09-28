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
      native = require(file);
      native.setEventHandler((event) => {
        const view = views.get(event.id);
        if (view) view.receive(event);
      });
      return native;
    } catch (err) {
      console.error(`[debrowser] streamview: could not load ${file}: ${err.message}`);
    }
  }
  return native;
}

const views = new Map();
let nextToken = 1;

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
    this.id = mod.create(window.getNativeWindowHandle(), {
      url, userDataDir, ...bounds,
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

  setBounds({ x, y, width, height }) {
    if (native && this.id) native.setBounds(this.id, Math.round(x), Math.round(y), Math.round(width), Math.round(height));
  }

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

module.exports = { StreamView, available: () => Boolean(load()), SAFARI_UA };
