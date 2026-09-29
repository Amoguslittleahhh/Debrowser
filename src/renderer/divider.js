'use strict';

/**
 * The split-view divider. While the button is held it tells the browser the
 * pointer moved, once a frame; the browser reads where the pointer is itself,
 * so nothing here needs to know the window's geometry. A double-click shares
 * the width evenly again.
 */

const api = window.debrowser;
let dragging = false;
let queued = false;

document.body.addEventListener('pointerdown', (event) => {
  dragging = true;
  document.body.setPointerCapture(event.pointerId);
  document.body.classList.add('dragging');
});
document.body.addEventListener('pointermove', () => {
  if (!dragging || queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; api.send('split-drag'); });
});
const stop = () => { dragging = false; document.body.classList.remove('dragging'); };
document.body.addEventListener('pointerup', stop);
document.body.addEventListener('pointercancel', stop);
document.body.addEventListener('dblclick', () => api.send('split-even'));

api.onState((state) => applyThemePrefs(state.prefs));
