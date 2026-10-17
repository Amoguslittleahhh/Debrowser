'use strict';

/**
 * A tab's hover card. The strip says which tab and what to show (chrome.js,
 * showHoverCard); this draws it and tells the browser how tall it came out,
 * so the view is never taller than the card and never covers the page with
 * nothing.
 */

const api = window.debrowser;
const $ = (id) => document.getElementById(id);
const el = { card: $('card'), title: $('title'), host: $('host'), note: $('note') };

function show(data) {
  el.title.textContent = data.title || '';
  el.host.textContent = data.host || '';
  el.host.hidden = !data.host;
  el.note.textContent = data.note || '';
  el.note.hidden = !data.note;
  el.card.classList.toggle('asleep', data.asleep === true);
  // Restart the entrance when one tab's card replaces another's.
  el.card.hidden = true;
  void el.card.offsetWidth;
  el.card.hidden = false;
  api.send('hover-card-size', { height: Math.ceil(document.body.getBoundingClientRect().height) });
}

api.onMessage((message) => { if (message.kind === 'hover-card') show(message); });
api.onState((state) => applyThemePrefs(state.prefs));
