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
 *    nothing on `window` or the DOM is modified. The one exception is at the
 *    end of the file: private windows only, files dropped or pasted in.
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

/**
 * Ctrl and the wheel: zoom, as it does in every other browser.
 *
 * Chromium does not do this for an embedded view - measured, a real
 * ctrl+wheel neither changes the zoom nor raises `zoom-changed` - so the
 * gesture has to be noticed here, in the one script that runs inside every
 * page, and applied by the browser process.
 *
 * Capturing and non-passive on purpose. Capture so a page that handles the
 * wheel itself does not swallow it first; non-passive so the default - which
 * is scrolling the page under the pointer - can be cancelled. A ctrl+wheel
 * that both zooms and scrolls is worse than one that does neither.
 *
 * Rate-limited, because one notch of a wheel arrives as several events on a
 * trackpad and each one is a message to another process.
 */
let lastZoomAt = 0;

window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey || event.deltaY === 0) return;
  event.preventDefault();
  const at = now();
  if (at - lastZoomAt < 60) return;
  lastZoomAt = at;
  ipcRenderer.send('debrowser:zoom-gesture', { direction: event.deltaY < 0 ? 'in' : 'out' });
}, { passive: false, capture: true });

/*
 * Ctrl+S and Ctrl+/ reach the page first (see `pageFirst` in shortcuts.js):
 * an editor saves its document or toggles a comment, and the browser acts
 * only if the page did not. Checked after the event has been through the
 * page's own handlers, which is when `defaultPrevented` says whether it used
 * the key.
 */
const PAGE_FIRST = { s: 'save-page', '/': 'show-shortcuts' };
window.addEventListener('keydown', (event) => {
  const mod = process.platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const command = PAGE_FIRST[String(event.key).toLowerCase()];
  if (!command || !mod || event.shiftKey || event.altKey || event.repeat) return;
  setTimeout(() => {
    if (!event.defaultPrevented) ipcRenderer.send('debrowser:page-key', command);
  }, 0);
}, true);

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

  // Whether this page is currently showing a credential or payment field. Sent
  // as a bare boolean - never the field, never its value - so the main process
  // can decline to photograph the page for a restore placeholder. Reported here
  // rather than only in the page-state snapshot because that snapshot is taken
  // on tier demotion, which is far too late: by then the user has already
  // switched away and the screenshot would already have been written.
  const sensitive = hasSensitiveField();

  // Report only on change. A settled page sends nothing at all.
  const fingerprint = `${demand}:${media ? 1 : 0}:${sensitive ? 1 : 0}`;
  if (fingerprint === lastReport) return;
  lastReport = fingerprint;

  ipcRenderer.send('debrowser:probe', { demand, animations, media, scrolling, sensitive });
}

/**
 * Does this page show a password or payment field right now?
 *
 * Re-queried rather than cached: a single-page app can route from a product
 * page to a sign-in form without any navigation the main process would see, and
 * a stale `false` here would authorise a screenshot of the login page.
 */
/**
 * Is this one element a credential or payment field?
 *
 * The single definition, used by both the screenshot gate and the session
 * snapshot. They had drifted into two: one matched the `autocomplete`
 * *attribute* with an exact selector, the other the IDL property with `===`,
 * and neither handled a token list - `autocomplete="cc-number webauthn"` is
 * valid and matched nothing, so such a field would have been read into the
 * session store and its page photographed.
 *
 * `autocomplete` is a space-separated token list by specification, so it is
 * tokenised rather than compared. Payment tokens beyond the card number are
 * included: a CVC or an expiry date is not less sensitive than the number.
 */
const PAYMENT_TOKENS = new Set([
  'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-name', 'cc-type'
]);

function isSensitiveField(el) {
  try {
    if ((el.getAttribute('type') || '').toLowerCase() === 'password') return true;
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    return tokens.some((t) => PAYMENT_TOKENS.has(t));
  } catch {
    return true;    // fail closed
  }
}

/**
 * Does this page show one right now?
 *
 * Re-queried rather than cached: a single-page app can route from a product
 * page to a sign-in form without any navigation the main process would see, and
 * a stale `false` here would authorise a screenshot of the login page.
 */
function hasSensitiveField() {
  try {
    for (const el of document.querySelectorAll('input')) {
      if (isSensitiveField(el)) return true;
    }
    return false;
  } catch {
    // Fail closed: if the page cannot be inspected, treat it as sensitive.
    return true;
  }
}

function start() {
  if (timer) return;
  // Report once straight away rather than waiting out the first interval. Two
  // things depend on this page having been looked at: the boost controller
  // wants an animation known at once rather than up to SAMPLE_MS late, and the
  // restore thumbnail is refused outright for a page that has never reported -
  // so without this, briefly-visited tabs would never be photographed at all.
  //
  // Deferred until the DOM exists. A preload runs at document-start, where
  // querying for a password field finds nothing because nothing is parsed yet -
  // which would report a sign-in page as safe to photograph and only correct
  // itself a sample later, after the screenshot had been taken.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sample, { once: true });
  } else {
    sample();
  }
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
    ipcRenderer.send('debrowser:probe',
      { demand: 'idle', animations: 0, media: false, scrolling: false, sensitive: hasSensitiveField() });
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
 * Editable regions the user has actually typed into. A contenteditable has no
 * `defaultValue` to compare against, and treating any content as unsubmitted
 * input made every rich-text page - most of which ship with content in their
 * editors - permanently undiscardable. Held in a WeakSet rather than marked on
 * the element so the page's DOM is left untouched.
 */
const editedHosts = new WeakSet();
document.addEventListener('input', (event) => {
  for (let node = event.target; node && node.isContentEditable; node = node.parentElement) {
    editedHosts.add(node);
  }
}, { capture: true, passive: true });

/**
 * Whether a select differs from what the markup chose. A single select with
 * no `selected` attribute defaults to its first enabled option, so comparing
 * against `option[selected]` alone - undefined there - reported every such
 * select as changed.
 */
function selectIsDirty(el) {
  const options = [...el.options];
  if (el.multiple) return options.some((o) => o.selected !== o.defaultSelected);
  let initial = -1;
  for (const o of options) if (o.defaultSelected) initial = o.index; // the last one wins
  if (initial === -1 && el.size <= 1) initial = options.findIndex((o) => !o.disabled);
  return el.selectedIndex !== initial;
}

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
    dirty: false,
    /**
     * Whether this page carries a credential or payment field. Reported as a
     * bare boolean - never the field, never its value - so the main process can
     * decline to photograph the page. See Tab#captureThumbnail.
     */
    sensitive: false
  };

  try {
    const fields = document.querySelectorAll('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    let index = 0;
    for (const el of fields) {
      index += 1;
      const type = (el.getAttribute('type') || '').toLowerCase();

      // Never read back credentials or payment fields, even into our own
      // in-memory session store. Their *presence* is still worth reporting:
      // a page with a password box is one we should not screenshot either.
      // Saving one is a separate, explicit act - see credentials.js - and does
      // not come through here.
      if (isSensitiveField(el)) {
        state.sensitive = true;
        continue;
      }

      const path = el.id ? `#${CSS.escape(el.id)}` : `__debrowser_idx_${index}`;
      let value = null;

      if (el.isContentEditable) {
        value = el.innerHTML;
        if (editedHosts.has(el)) state.dirty = true;
      } else if (el.tagName === 'SELECT') {
        value = el.value;
        if (selectIsDirty(el)) state.dirty = true;
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
        if (field.kind === 'html') {
          el.innerHTML = field.value;
          // Restored input is still the user's unsubmitted input, exactly as a
          // restored text field's value still differs from its default.
          editedHosts.add(el);
        }
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
/* ------------------------------------------------------------------ */
/* Saved sign-ins                                                      */
/* ------------------------------------------------------------------ */

/**
 * Offer to remember a sign-in, when the user submits one.
 *
 * Reads a password only at the moment the user has deliberately submitted it,
 * and only to ask whether to keep it. Nothing is stored unless they say yes;
 * the answer is taken in the browser process, not here, so a page cannot
 * fabricate consent.
 *
 * This does not weaken the rule above. The session snapshot still never reads
 * these fields, and a page carrying one is still never photographed - both are
 * automatic mechanisms the user did not ask for, which is exactly why they must
 * not touch credentials. This is the opposite kind of thing.
 */
function offerToSave(form) {
  try {
    const password = form.querySelector('input[type="password"]');
    if (!password || !password.value) return;

    // The username is whatever text-like field precedes the password, which is
    // what every sign-in form looks like. Guessing wrong costs a wrong label on
    // a row the user can edit; guessing at the password would be unforgivable,
    // so that is never inferred.
    let username = '';
    const candidates = form.querySelectorAll('input');
    for (const el of candidates) {
      if (el === password) break;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['text', 'email', 'tel'].includes(type) && el.value) username = el.value;
    }

    ipcRenderer.send('debrowser:credential-offer', {
      origin: location.origin,
      username,
      password: password.value
    });
  } catch { /* a page that cannot be inspected simply gets no offer */ }
}

window.addEventListener('submit', (event) => {
  if (event.target instanceof HTMLFormElement) offerToSave(event.target);
}, true);

/**
 * Fill a saved sign-in.
 *
 * Driven from the browser process, never from the page: a page cannot ask to be
 * filled, it can only receive a fill the user's browser decided to perform.
 *
 * Synthetic `input` and `change` events are dispatched after setting the value.
 * Without them a field set this way looks empty to every framework that tracks
 * state outside the DOM - React, Vue, Angular - so the form would submit blank
 * while appearing filled, which is worse than not filling it at all.
 */
ipcRenderer.on('debrowser:credential-fill', (_event, record) => {
  try {
    if (!record || location.origin !== record.origin) return;   // never cross-origin
    const password = document.querySelector('input[type="password"]');
    if (!password) return;

    const setValue = (el, value) => {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    if (record.username) {
      const form = password.form || document;
      let user = null;
      for (const el of form.querySelectorAll('input')) {
        if (el === password) break;
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (['text', 'email', 'tel'].includes(type)) user = el;
      }
      if (user) setValue(user, record.username);
    }
    setValue(password, record.password);
  } catch { /* nothing fillable here */ }
});

/**
 * Fill payment details, on a click the user made in the browser's own UI.
 *
 * Never on load. A page can place a payment field off-screen or at zero size
 * and harvest whatever an autofill puts in it, and unlike a password there is
 * no origin binding to make that safe - a card number is equally valid
 * everywhere. So this only ever arrives because the user asked for it while
 * looking at the page.
 */
ipcRenderer.on('debrowser:payment-fill', (_event, record) => {
  try {
    if (!record) return;
    const pick = (token, fallback) =>
      document.querySelector(`input[autocomplete~="${token}"]`) ||
      (fallback ? document.querySelector(fallback) : null);

    const setValue = (el, value) => {
      if (!el || !value) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    setValue(pick('cc-number'), record.number);
    setValue(pick('cc-name'), record.holder);
    setValue(pick('cc-exp'), record.expiry);
  } catch { /* nothing fillable here */ }
});

contextBridge.exposeInMainWorld('__debrowser', Object.freeze({ version: 1 }));

/* ------------------------------------------------------------------ */
/* Private windows: files dropped or pasted into a page                 */
/* ------------------------------------------------------------------ */

/*
 * The one place this file does interfere with the page, and only in a private
 * window: a file the page would receive by drag and drop or by paste does not
 * pass through the file picker, where uploads are cleaned (see
 * incognito/sanitise.js), so it is caught here instead. The original event is
 * stopped before any of the page's listeners see it - this listener is on the
 * window, in the capture phase, added before any page script ran - and the
 * same event is sent again with clean files: images without their Exif, GPS,
 * XMP or comments, and every file with its timestamp reset, because when a
 * photo was taken or a document last edited is metadata too.
 *
 * If cleaning fails the drop is dropped. A file that reached the page with
 * its metadata would be the failure this exists to prevent.
 */
if (process.argv.includes('--debrowser-private')) {
  /* global DataTransfer, File, DragEvent, ClipboardEvent -- page-side constructors */
  const IMAGE = /\.(jpe?g|png|webp)$/i;
  const ours = new WeakSet();

  const cleanFiles = async (list) => {
    const files = [...list];
    const images = files.map((f, i) => (IMAGE.test(f.name) || /^image\/(jpeg|png|webp)$/.test(f.type) ? i : -1))
      .filter((i) => i >= 0);
    let cleaned = [];
    if (images.length) {
      const payload = await Promise.all(images.map(async (i) => ({
        name: files[i].name, type: files[i].type, bytes: new Uint8Array(await files[i].arrayBuffer())
      })));
      cleaned = await ipcRenderer.invoke('debrowser:clean-files', payload);
      if (!Array.isArray(cleaned) || cleaned.length !== images.length) throw new Error('not cleaned');
    }
    const now = Date.now();
    const out = new DataTransfer();
    files.forEach((f, i) => {
      const k = images.indexOf(i);
      const body = k >= 0 ? cleaned[k].bytes : f;
      out.items.add(new File([body], f.name, { type: f.type, lastModified: now }));
    });
    return out;
  };

  const intercept = (type, filesOf, remake) => {
    window.addEventListener(type, (event) => {
      if (ours.has(event)) return;
      const list = filesOf(event);
      if (!list || !list.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = event.target;
      cleanFiles(list).then((clean) => {
        if (type === 'drop' && target instanceof HTMLInputElement && target.type === 'file') {
          target.files = clean.files;
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
        const again = remake(event, clean);
        ours.add(again);
        target.dispatchEvent(again);
      }).catch(() => { /* not cleaned: not delivered */ });
    }, true);
  };

  intercept('drop', (e) => e.dataTransfer && e.dataTransfer.files, (e, dt) => new DragEvent('drop', {
    bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
    clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
    ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey
  }));
  intercept('paste', (e) => e.clipboardData && e.clipboardData.files, (e, dt) => new ClipboardEvent('paste', {
    bubbles: true, cancelable: true, composed: true, clipboardData: dt
  }));
}
