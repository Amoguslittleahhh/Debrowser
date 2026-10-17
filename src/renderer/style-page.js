'use strict';

/** The site style editor: load the site's CSS, save it, or take it away. */

const api = window.debrowser;
const $ = (id) => document.getElementById(id);
const host = new URLSearchParams(location.search).get('host') || '';
$('host').textContent = host;
document.title = `Style for ${host}`;

async function load() {
  const res = await api.request('site-style-get', { host });
  if (!res) return;
  $('css').value = res.css;
  const n = res.hidden.length;
  $('hidden-note').hidden = !n;
  $('hidden-note').textContent = `${n} thing${n === 1 ? ' is' : 's are'} hidden on this site as well. The padlock shows them again.`;
}
const say = (text) => { $('note').textContent = text; setTimeout(() => { $('note').textContent = ''; }, 1600); };
$('save').addEventListener('click', () => { api.send('site-style-set', { host, css: $('css').value }); say('Saved'); });
$('remove').addEventListener('click', () => { $('css').value = ''; api.send('site-style-set', { host, css: '' }); say('Removed'); });
$('css').addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); $('save').click(); }
  if (event.key === 'Tab' && !event.shiftKey) {
    event.preventDefault();
    const el = $('css');
    el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end');
  }
});
api.onState((state) => applyThemePrefs(state.prefs));
load();
