'use strict';

/**
 * The toast. Shown when the browser sends one, gone after its time - longer
 * while the pointer rests on it, so reaching for Undo never races the clock.
 * Its button and its close both go back to the browser by id, which runs or
 * drops what the button stood for (main.js, `toast`).
 */

const api = window.debrowser;
const $ = (id) => document.getElementById(id);
const el = { toast: $('toast'), text: $('text'), action: $('action'), dismiss: $('dismiss') };

let current = null;
let timer = null;
let hovered = false;

function arm() {
  clearTimeout(timer);
  if (!current || hovered) return;
  timer = setTimeout(() => leave('toast-dismiss'), current.ms || 5000);
}

function leave(command) {
  if (!current) return;
  const { id } = current;
  current = null;
  clearTimeout(timer);
  el.toast.classList.add('leaving');
  setTimeout(() => {
    if (current) return;          // a new one arrived while this one left
    el.toast.hidden = true;
    api.send(command, { id });
  }, 130);
}

function show(toast) {
  current = toast;
  el.text.textContent = toast.text;
  el.action.textContent = toast.action || '';
  el.action.hidden = !toast.action;
  el.toast.classList.remove('leaving');
  // Restart the entrance even when one toast replaces another.
  el.toast.hidden = true;
  void el.toast.offsetWidth;
  el.toast.hidden = false;
  arm();
}

el.action.addEventListener('click', () => leave('toast-action'));
el.dismiss.addEventListener('click', () => leave('toast-dismiss'));
el.toast.addEventListener('pointerenter', () => { hovered = true; clearTimeout(timer); });
el.toast.addEventListener('pointerleave', () => { hovered = false; arm(); });

api.onMessage((message) => { if (message.kind === 'toast') show(message); });
api.onState((state) => applyThemePrefs(state.prefs));
