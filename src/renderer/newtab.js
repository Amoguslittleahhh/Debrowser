'use strict';

/**
 * The new tab page.
 *
 * Typing here goes through the same `navigate` command the address bar uses, so
 * the URL-versus-search decision is made in exactly one place in the browser
 * (`normaliseUrl` in main.js) rather than being reimplemented with slightly
 * different rules and disagreeing about what a bare hostname means.
 */

const api = window.debrowser;

const q = document.getElementById('q');
const stat = document.getElementById('stat');

/*
 * Tell the browser when there is something in the box worth keeping.
 *
 * Every other page is watched by `probe-preload.js`, which is what sets a tab's
 * `hasDirtyInput` and stops the governor discarding a half-filled form. The
 * browser's own pages do not get that preload - they get the command bridge
 * instead - so nothing was watching this box at all, and a query typed here
 * and left could be thrown away by the live-tab cap. Since this page is the one
 * that knows, this page is what says so.
 */
let reportedDirty = false;
q.addEventListener('input', () => {
  const dirty = q.value.trim().length > 0;
  if (dirty === reportedDirty) return;
  reportedDirty = dirty;
  api.send('page-dirty', { dirty });
});

document.getElementById('search').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = q.value.trim();
  if (text) api.send('navigate', { url: text });
});

// Animate only once the page is actually on screen. A hidden view's animation
// frames are throttled, so one started in the background is still running when
// the tab is shown, and the user sees it settle rather than arrive.
function releaseAnimation() {
  if (document.visibilityState !== 'visible') return;
  document.body.classList.remove('still');
  document.removeEventListener('visibilitychange', releaseAnimation);
}
document.body.classList.add('still');
document.addEventListener('visibilitychange', releaseAnimation);
releaseAnimation();

// Focus without stealing it from the address bar if the user went there first.
window.addEventListener('DOMContentLoaded', () => {
  if (!document.hasFocus()) return;
  q.focus();
});

// One line of the thing this browser is actually for. It costs nothing to
// render because the numbers are already in the state message the chrome gets.
api.onState((state) => {
  applyThemePrefs(state.prefs);
  if (typeof state.totalMB !== 'number') return;
  const open = state.tabs ? state.tabs.length : 0;
  const per = open ? (state.totalMB / open).toFixed(1) : '—';
  stat.textContent = `${state.totalMB} MB across ${open} tab${open === 1 ? '' : 's'} — ${per} MB each`;
});
