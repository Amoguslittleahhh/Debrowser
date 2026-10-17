'use strict';

/**
 * What a page can read about this computer beyond the fingerprint profile -
 * taken away, fixed, or blurred, before any of the page's own code runs.
 *
 * Each of these is something a site could read and send home: the graphics
 * card (WebGPU), the RAM (deviceMemory, performance.memory), the battery, the
 * network's speed, the keyboard's layout (which says what language you type),
 * the installed voices (which say what languages your OS has), connected
 * gamepads and media devices, the OS's dark-mode setting, and the tiny
 * per-machine differences in how canvas and audio are drawn.
 *
 * How it gets there first: the DevTools protocol runs the script in every
 * new document of the page and its frames (Page.addScriptToEvaluateOnNewDocument),
 * and holds every worker at its start (Target.setAutoAttach with
 * waitForDebuggerOnStart) until the script has run in it. A worker the script
 * could not run in is never resumed: it stays paused, which is failing closed.
 *
 * Shared and service workers are not children of the page and never reach
 * the debugger, so they are removed from private windows rather than
 * scrubbed. Sites feature-detect both and carry on without them.
 *
 * Canvas and audio are blurred rather than blanked: returning a blank canvas
 * uniformly (Tor Browser's answer) breaks every avatar cropper that uploads
 * what it drew. Instead each tab gets a random seed, and what a script reads
 * back carries a few low-bit changes derived from it - invisible, stable for
 * the tab's life, and different in every tab and after every new identity, so
 * the result cannot link one visit to another and says nothing about the
 * hardware underneath.
 */

/** The page-side script. Serialised: it must not reference anything outside itself. */
function scrubber(seed, cores, languages) {
  /* global self -- runs in a page or a worker, where `self` is the global */
  const g = self;
  const define = (obj, prop, value) => {
    try { Object.defineProperty(obj, prop, { get: () => value, configurable: true, enumerable: true }); } catch { /* frozen */ }
  };
  const remove = (obj, prop) => {
    try { delete obj[prop]; } catch { /* not configurable */ }
    if (obj && prop in obj) define(obj, prop, undefined);
  };
  const replace = (proto, name, make) => {
    if (!proto || typeof proto[name] !== 'function') return;
    const original = proto[name];
    const fn = make(original);
    try { Object.defineProperty(proto, name, { value: fn, configurable: true, writable: true }); } catch { /* frozen */ }
  };

  const nav = Object.getPrototypeOf(g.navigator);

  // Hardware and settings: fixed, or gone.
  define(nav, 'deviceMemory', 8);
  // Also set through the DevTools protocol; here too, for the workers it misses.
  define(nav, 'hardwareConcurrency', cores);
  // The same for the languages. A dedicated worker on Windows took its list
  // from the OS, which `--lang` does not reach: en-US on the CI runner, and
  // "en-US,en-SG,zh-Hans-SG" on a machine set up in Singapore. One array,
  // frozen, so every read returns the same object, as the real one does.
  const langs = Object.freeze(languages.slice());
  define(nav, 'languages', langs);
  define(nav, 'language', langs[0]);
  for (const p of ['gpu', 'getBattery', 'connection', 'keyboard', 'hid', 'usb', 'serial', 'bluetooth', 'xr', 'ml',
                   'serviceWorker', 'getInstalledRelatedApps', 'storageBuckets']) remove(nav, p);
  if (g.Performance) remove(g.Performance.prototype, 'memory');
  remove(g, 'SharedWorker');
  if (typeof nav.getGamepads === 'function') replace(nav, 'getGamepads', () => function getGamepads() { return []; });
  if (g.MediaDevices) replace(g.MediaDevices.prototype, 'enumerateDevices', () => function enumerateDevices() { return Promise.resolve([]); });
  if (g.SpeechSynthesis) replace(g.SpeechSynthesis.prototype, 'getVoices', () => function getVoices() { return []; });

  // A small deterministic generator from the tab's seed.
  let state = seed >>> 0 || 1;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const offsets = Array.from({ length: 64 }, () => next());

  // Which values change depends on the value as well as the place and the
  // seed. On place and seed alone the change was a fixed mask: a blank canvas
  // of the same size read it out, and drawing an exported image back in and
  // reading it applied the mask twice, which undid it - either way the raw
  // drawing, and with it the hardware, came back. Keyed on the value, a known
  // input says nothing about any other, and a second pass is a new draw of
  // the dice rather than the same one reversed.
  const mix = (h) => {
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
  };
  // Canvas: flip the low bit of a sparse set of pixels. Fully transparent
  // ones are left alone, so an empty canvas reads back empty.
  const blur = (data) => {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const px = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
      if (mix(px ^ offsets[(i >> 2) & 63] ^ Math.imul(i >> 2, 0x9e3779b1)) % 23 === 0) data[i] ^= 1;
    }
    return data;
  };
  const blurredCopy = (canvas, width, height, Make) => {
    const copy = new Make(width, height);
    const ctx = copy.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const img = originalGetImageData.call(ctx, 0, 0, width, height);
    blur(img.data);
    ctx.putImageData(img, 0, 0);
    return copy;
  };
  const ctx2d = g.CanvasRenderingContext2D && g.CanvasRenderingContext2D.prototype;
  const offCtx = g.OffscreenCanvasRenderingContext2D && g.OffscreenCanvasRenderingContext2D.prototype;
  const originalGetImageData = (ctx2d || offCtx || {}).getImageData;
  for (const proto of [ctx2d, offCtx]) {
    replace(proto, 'getImageData', (original) => function getImageData(...args) {
      const img = original.apply(this, args);
      blur(img.data);
      return img;
    });
  }
  const makeCanvas = (w, h) => {
    if (g.document) { const c = g.document.createElement('canvas'); c.width = w; c.height = h; return c; }
    return new g.OffscreenCanvas(w, h);
  };
  function MakeCanvas(w, h) { return makeCanvas(w, h); }
  if (g.HTMLCanvasElement && originalGetImageData) {
    const proto = g.HTMLCanvasElement.prototype;
    replace(proto, 'toDataURL', (original) => function toDataURL(...args) {
      if (!this.width || !this.height) return original.apply(this, args);
      return original.apply(blurredCopy(this, this.width, this.height, MakeCanvas), args);
    });
    replace(proto, 'toBlob', (original) => function toBlob(...args) {
      if (!this.width || !this.height) return original.apply(this, args);
      return original.apply(blurredCopy(this, this.width, this.height, MakeCanvas), args);
    });
  }
  if (g.OffscreenCanvas && originalGetImageData) {
    replace(g.OffscreenCanvas.prototype, 'convertToBlob', (original) => function convertToBlob(...args) {
      if (!this.width || !this.height) return original.apply(this, args);
      return original.apply(blurredCopy(this, this.width, this.height, g.OffscreenCanvas), args);
    });
  }

  // A drawing handed to video: `new VideoFrame(canvas)` and `copyTo` read the
  // pixels without passing through anything above.
  if (g.VideoFrame && originalGetImageData) {
    const Original = g.VideoFrame;
    const isCanvas = (src) => (g.HTMLCanvasElement && src instanceof g.HTMLCanvasElement) ||
      (g.OffscreenCanvas && src instanceof g.OffscreenCanvas);
    const VideoFrame = class VideoFrame extends Original {
      constructor(src, ...rest) {
        super(isCanvas(src) && src.width && src.height
          ? blurredCopy(src, src.width, src.height, g.HTMLCanvasElement && src instanceof g.HTMLCanvasElement ? MakeCanvas : g.OffscreenCanvas)
          : src, ...rest);
      }
    };
    try { Object.defineProperty(g, 'VideoFrame', { value: VideoFrame, configurable: true, writable: true }); } catch { /* frozen */ }
  }

  // Audio: every sample read back is scaled by a seed- and value-derived
  // amount far below anything audible. Scaled rather than shifted: a shift
  // was the same at every value, so rendering silence read it out to be
  // subtracted. Silence stays silence, and a known signal - a constant, say -
  // tells a page the change at that value only.
  const bits = new Uint32Array(1);
  const asFloat = new Float32Array(bits.buffer);
  const scale = (value, i) => {
    asFloat[0] = value;
    return value * (1 + (((mix(bits[0] ^ offsets[i & 63]) & 0xff) - 128) * 1e-8));
  };
  const nudged = new WeakSet();
  const nudge = (arr) => {
    if (nudged.has(arr)) return arr;
    nudged.add(arr);
    for (let i = 0; i < arr.length; i += 1) arr[i] = scale(arr[i], i);
    return arr;
  };
  // Analyser bytes: the low bit of a sparse, value-chosen set.
  const nudgeBytes = (arr) => {
    for (let i = 0; i < arr.length; i += 1) {
      if (mix(arr[i] ^ offsets[i & 63] ^ Math.imul(i, 0x9e3779b1)) % 23 === 0) arr[i] ^= 1;
    }
  };
  if (g.AudioBuffer) {
    replace(g.AudioBuffer.prototype, 'getChannelData', (original) => function getChannelData(...args) {
      return nudge(original.apply(this, args));
    });
    replace(g.AudioBuffer.prototype, 'copyFromChannel', (original) => function copyFromChannel(dest, ...rest) {
      original.call(this, dest, ...rest);
      for (let i = 0; i < dest.length; i += 1) dest[i] = scale(dest[i], i);
    });
  }
  if (g.AnalyserNode) {
    const proto = g.AnalyserNode.prototype;
    for (const name of ['getFloatFrequencyData', 'getFloatTimeDomainData']) {
      replace(proto, name, (original) => function read(arr) {
        original.call(this, arr);
        for (let i = 0; i < arr.length; i += 1) arr[i] = scale(arr[i], i);
      });
    }
    for (const name of ['getByteFrequencyData', 'getByteTimeDomainData']) {
      replace(proto, name, (original) => function read(arr) {
        original.call(this, arr);
        nudgeBytes(arr);
      });
    }
  }
}

/** The script for one tab, with its own seed. */
function sourceFor(seed, cores, languages = 'en-US') {
  const list = String(languages).split(',').map((l) => l.trim()).filter((l) => /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(l));
  return `(${scrubber})(${seed >>> 0}, ${Number(cores) || 4}, ${JSON.stringify(list.length ? list : ['en-US'])});`;
}

/** A fresh seed: one per tab. */
function newSeed() {
  return require('crypto').randomBytes(4).readUInt32LE(0);
}

/**
 * The media features every private window reports, whatever the OS is set
 * to: an OS in dark mode, or with reduced motion on, is a bit a site could read.
 */
const MEDIA_FEATURES = [
  { name: 'prefers-color-scheme', value: 'light' },
  { name: 'prefers-reduced-motion', value: 'no-preference' },
  { name: 'prefers-contrast', value: 'no-preference' },
  { name: 'prefers-reduced-transparency', value: 'no-preference' },
  { name: 'forced-colors', value: 'none' }
];

module.exports = { scrubber, sourceFor, newSeed, MEDIA_FEATURES };
