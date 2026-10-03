'use strict';

/**
 * The split-view divider, and the edge between a page and a docked inspector
 * (`?for=devtools`, `&axis=row` when it is docked below). While the button is
 * held it tells the browser the pointer moved, once a frame; the browser reads
 * where the pointer is itself, so nothing here needs to know the window's
 * geometry. A double-click puts the default share back.
 */

const api = window.debrowser;
const params = new URLSearchParams(location.search);
const kind = params.get('for') === 'devtools' ? 'devtools' : 'split';
if (params.get('axis') === 'row') document.body.classList.add('row');
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
  requestAnimationFrame(() => { queued = false; api.send(`${kind}-drag`); });
});
const stop = () => {
  if (dragging && kind === 'devtools') api.send('devtools-drag-end');
  dragging = false;
  document.body.classList.remove('dragging');
};
document.body.addEventListener('pointerup', stop);
document.body.addEventListener('pointercancel', stop);
document.body.addEventListener('dblclick', () => api.send(`${kind}-even`));

api.onState((state) => applyThemePrefs(state.prefs));
