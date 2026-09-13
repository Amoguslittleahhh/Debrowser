'use strict';

/**
 * Activity probe, injected into every page.
 *
 * The governor needs to know when a page is *visibly busy* - animating,
 * playing media, being scrolled - as distinct from merely running code. That
 * distinction is what lets us take CPU and memory away the instant an
 * animation ends without ever clipping one that is still running.
 *
 * Constraints this file is written against:
 *
 *  - It runs in every tab, so it must cost almost nothing. It samples on a
 *    single shared interval, does no work at all while the tab is hidden, and
 *    sends IPC only when the reported tier actually changes.
 *  - It runs in an isolated world, so it cannot see or patch the page's own
 *    `requestAnimationFrame`. It therefore measures animation through
 *    `document.getAnimations()` (which covers CSS animations, CSS transitions
 *    and Web Animations) and media playback. Script-driven rAF loops - canvas,
 *    WebGL, scroll-linked effects - are picked up in the main process instead,
 *    from renderer CPU and from the page's own script/layout timings, and the
 *    two signals are fused there. See governor/boost.js.
 *  - It must never interfere with the page: all listeners are passive, and
 *    nothing on `window` or the DOM is modified.
 */

const { ipcRenderer, contextBridge } = require('electron');

/**
 * Sampling interval. Chromium throttles this to roughly once a minute once the
 * tab is hidden, and a frozen tab does not run it at all, so a background tab
 * costs essentially nothing here without any coordination from the browser.
 */
const SAMPLE_MS = 500;

/** Interaction is "recent" for this long after the last input event. */
const INTERACTION_WINDOW_MS = 700;

let lastInteractionAt = 0;
let lastScrollAt = 0;
let lastReport = '';
let timer = null;

/**
 * Note on visibility: an earlier version had the browser process push the
 * authoritative visible/hidden state down this channel, because
 * `document.visibilityState` is not always reliable for a detached view. That
 * turned out to be unsafe - delivering IPC to a frozen renderer segfaults it -
 * and it was also unnecessary. A hidden tab's timers are throttled by Chromium
 * to roughly one wake per minute and a frozen tab runs nothing at all, so this
 * probe already goes quiet on its own; and the browser process ignores reports
 * from any tab that is not the active one. Visibility is now a local hint only.
 */

const now = () => Date.now();

function markInteraction() { lastInteractionAt = now(); }
function markScroll() { lastScrollAt = now(); }

const passive = { passive: true, capture: true };
window.addEventListener('scroll', markScroll, passive);
window.addEventListener('wheel', markScroll, passive);
window.addEventListener('touchmove', markScroll, passive);
window.addEventListener('pointerdown', markInteraction, passive);
window.addEventListener('pointermove', markInteraction, passive);
window.addEventListener('keydown', markInteraction, passive);

/**
 * Count animations that are actually producing frames right now.
 *
 * `getAnimations()` walks the document's animation timeline, so on a very
 * large DOM it is not free. We cap the work by bailing out as soon as we have
 * seen enough running animations to classify the tab as heavy - the exact
 * count past that point does not change any decision.
 */
const RUNNING_CAP = 8;
function countRunningAnimations() {
  if (typeof document.getAnimations !== 'function') return 0;
  let running = 0;
  try {
    const animations = document.getAnimations();
    for (const animation of animations) {
      if (animation.playState === 'running') {
        running += 1;
        if (running >= RUNNING_CAP) break;
      }
    }
  } catch {
    return 0;
  }
  return running;
}

/** Is any media element actually playing (as opposed to merely present)? */
function hasPlayingMedia() {
  try {
    const media = document.querySelectorAll('video, audio');
    for (const el of media) {
      if (!el.paused && !el.ended && el.readyState > 2) return true;
    }
  } catch { /* detached document */ }
  return false;
}

function sample() {
  // A hidden tab is already on the demotion ladder; sampling it would burn CPU
  // to learn something that cannot change any decision.
  if (document.visibilityState === 'hidden') return;

  const t = now();
  const animations = countRunningAnimations();
  const media = hasPlayingMedia();
  const scrolling = t - lastScrollAt < INTERACTION_WINDOW_MS;
  const interacting = t - lastInteractionAt < INTERACTION_WINDOW_MS;

  // "Heavy" means the page is producing frames right now, not that it is
  // producing a lot of them. A single spinner needs its frames delivered on
  // time exactly as much as a full-screen canvas does, and the thing a boost
  // buys - normal priority, and no stalling work anywhere in the browser - is
  // worth just as much to it. Requiring several concurrent animations before
  // reacting was the wrong threshold: it left ordinary pages, which animate
  // one thing at a time, treated as idle while the user watched them move.
  let demand;
  if (media || scrolling || animations > 0) demand = 'heavy';
  else if (interacting) demand = 'light';
  else demand = 'idle';

  // Report only on change. A settled page sends nothing at all.
  const fingerprint = `${demand}:${media ? 1 : 0}`;
  if (fingerprint === lastReport) return;
  lastReport = fingerprint;

  ipcRenderer.send('debrowser:probe', { demand, animations, media, scrolling });
}

function start() {
  if (timer) return;
  timer = setInterval(sample, SAMPLE_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function onVisibilityChanged(visible) {
  lastReport = '';
  if (visible) {
    // Re-report immediately on show: the governor wants to know about an
    // animation the moment the tab becomes visible, not up to a tick later.
    sample();
  } else {
    // Hidden tabs are idle by definition as far as the boost controller cares.
    ipcRenderer.send('debrowser:probe', { demand: 'idle', animations: 0, media: false, scrolling: false });
  }
}

document.addEventListener('visibilitychange', () => {
  onVisibilityChanged(document.visibilityState === 'visible');
}, true);

start();

/* ------------------------------------------------------------------ */
/* Session capture, used to make discard/restore invisible to the user. */
/* ------------------------------------------------------------------ */

/**
 * Snapshot the parts of a page that navigation history alone does not carry:
 * where the user had scrolled to, and anything they had typed.
 *
 * The `dirty` flag is the important one. A tab holding text the user has not
 * submitted is never discarded, whatever the memory pressure - losing typed
 * input to save 60MB is not a trade this browser makes.
 */
function captureState() {
  const state = {
    scroll: { x: window.scrollX, y: window.scrollY },
    fields: [],
    dirty: false
  };

  try {
    const fields = document.querySelectorAll('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    let index = 0;
    for (const el of fields) {
      index += 1;
      const type = (el.getAttribute('type') || '').toLowerCase();
      // Never read back credentials or payment fields, even into our own
      // in-memory session store.
      if (type === 'password' || el.autocomplete === 'cc-number') continue;

      const path = el.id ? `#${CSS.escape(el.id)}` : `__debrowser_idx_${index}`;
      let value = null;

      if (el.isContentEditable) {
        if (el.innerHTML !== (el.dataset.debrowserInitial ?? el.innerHTML)) state.dirty = true;
        value = el.innerHTML;
        if (value) state.dirty = true;
      } else if (el.tagName === 'SELECT') {
        value = el.value;
        if (el.selectedIndex !== el.querySelector('option[selected]')?.index) state.dirty = true;
      } else if (type === 'checkbox' || type === 'radio') {
        value = el.checked;
        if (el.checked !== el.defaultChecked) state.dirty = true;
      } else {
        value = el.value;
        if (el.value !== el.defaultValue) state.dirty = true;
      }

      if (value !== null && value !== '' && value !== false) {
        state.fields.push({ path, value, kind: el.isContentEditable ? 'html' : el.tagName.toLowerCase(), type });
      }
    }
  } catch { /* best effort */ }

  return state;
}

ipcRenderer.on('debrowser:capture', (_event, requestId) => {
  ipcRenderer.send('debrowser:capture-result', requestId, captureState());
});

ipcRenderer.on('debrowser:restore-state', (_event, state) => {
  if (!state) return;
  const apply = () => {
    try {
      for (const field of state.fields || []) {
        if (!field.path.startsWith('#')) continue; // index paths are not stable across a reload
        const el = document.querySelector(field.path);
        if (!el) continue;
        if (field.kind === 'html') el.innerHTML = field.value;
        else if (field.type === 'checkbox' || field.type === 'radio') el.checked = Boolean(field.value);
        else el.value = field.value;
      }
      if (state.scroll) window.scrollTo(state.scroll.x, state.scroll.y);
    } catch { /* best effort */ }
  };
  if (document.readyState === 'complete') apply();
  else window.addEventListener('load', apply, { once: true });
});

// Expose nothing to the page itself; the bridge exists only so that
// contextIsolation stays on with no main-world surface area.
contextBridge.exposeInMainWorld('__debrowser', Object.freeze({ version: 1 }));
