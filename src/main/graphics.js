'use strict';

/**
 * Is the browser drawing with the graphics card, or with the processor?
 *
 * Chromium keeps a list of graphics drivers it does not trust, and virtual
 * machines' adapters are often on it - VMware's and VirtualBox's among them.
 * On those, pages are drawn by the processor instead, and a 3D game in a tab
 * (WebGL) costs most of the machine: every frame of it rendered in software,
 * on the same cores the page's own code needs. Nothing on screen said so.
 *
 * So the task manager says which it is, and Settings → Advanced can ask
 * Chromium to use the adapter anyway (`ignore-gpu-blocklist`, Chrome's
 * "Override software rendering list"). That is a request, not a promise: an
 * adapter is on the list for a reason, so if the graphics process falls over
 * twice in the first minute with it on, it is turned off again by itself and
 * the next start says why.
 */

const CRASH_WINDOW_MS = 60_000;

/** The switches to add before the app is ready, from the saved preference. */
function applySwitches(app, prefs) {
  if (prefs.get('hardwareAcceleration') === false) return false;
  if (prefs.get('gpuIgnoreBlocklist') !== true) return false;
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  return true;
}

/**
 * Watch the graphics process while the override is on: two crashes soon
 * after start and the override goes, with a note for the next start.
 */
function guardOverride(app, prefs, log = () => {}) {
  if (prefs.get('gpuIgnoreBlocklist') !== true) return;
  const started = Date.now();
  let crashes = 0;
  app.on('child-process-gone', (_event, details) => {
    if (!details || details.type !== 'GPU' || details.reason === 'clean-exit') return;
    if (Date.now() - started > CRASH_WINDOW_MS) return;
    crashes += 1;
    log('graphics', `graphics process gone (${details.reason}) with the override on, ${crashes} time(s)`);
    if (crashes >= 2 && prefs.get('gpuIgnoreBlocklist') === true) {
      prefs.set('gpuIgnoreBlocklist', false);
      prefs.set('gpuOverrideFailed', true);
    }
  });
}

/** The feature status Chromium reports, read as one plain answer. */
function status(app) {
  let features = {};
  try { features = app.getGPUFeatureStatus() || {}; } catch { /* before ready */ }
  const soft = (v) => typeof v === 'string' && /software|disabled|unavailable/.test(v);
  return {
    // The page itself, and 3D in it: either one on the processor is what costs.
    software: soft(features.gpu_compositing) || soft(features.webgl),
    webgl: features.webgl || 'unknown',
    compositing: features.gpu_compositing || 'unknown',
    overridden: app.commandLine.hasSwitch('ignore-gpu-blocklist')
  };
}

module.exports = { applySwitches, guardOverride, status };
