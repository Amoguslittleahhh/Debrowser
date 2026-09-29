'use strict';
/* global Node, DOMParser, localStorage, SpeechSynthesisUtterance */

/**
 * Reader view. The article comes from the browser by the token in this page's
 * address; its HTML is the site's, so it is rebuilt here from an allowlist -
 * anything that could run, load a frame, submit or restyle the page is left
 * out - before a node of it is shown. Links go through the browser.
 */

const api = window.debrowser;
const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t');

const ALLOWED = new Set(['p', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'br', 'hr', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'figure', 'figcaption', 'img', 'picture', 'source',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'div', 'span', 'section', 'article', 'small',
  'mark', 'abbr', 'time', 'dl', 'dt', 'dd', 'cite', 'q', 'kbd', 'var', 'samp', 'del', 'ins']);
const ATTRS = { a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height', 'srcset', 'sizes'],
  source: ['srcset', 'type', 'media', 'sizes'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'],
  time: ['datetime'], abbr: ['title'] };
const safeUrl = (value) => /^(https?:|data:image\/)/i.test(String(value || '').trim());

/** A clean copy of `node`'s children, built afresh in this document. */
function clean(node, into) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { into.append(child.textContent); continue; }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    if (!ALLOWED.has(tag)) {
      // A wrapper we do not keep may still hold text worth keeping; a script
      // or frame never does.
      if (!/^(script|style|iframe|frame|object|embed|form|input|button|select|textarea|svg|math|template|noscript|link|meta|base)$/.test(tag)) clean(child, into);
      continue;
    }
    const el = document.createElement(tag);
    for (const name of ATTRS[tag] || []) {
      const value = child.getAttribute(name);
      if (value === null) continue;
      if ((name === 'href' || name === 'src') && !safeUrl(value)) continue;
      if (name === 'srcset' && /javascript:/i.test(value)) continue;
      el.setAttribute(name, value);
    }
    if (tag === 'img') { el.loading = 'lazy'; el.referrerPolicy = 'no-referrer'; }
    clean(child, el);
    into.append(el);
  }
}

async function load() {
  const article = token ? await api.request('reader-article', { t: token }) : null;
  if (!article) { $('article').hidden = true; $('empty').hidden = false; return; }
  document.title = article.title || 'Reader view';
  if (article.lang) document.documentElement.lang = article.lang;
  let host = '';
  try { host = new URL(article.url).hostname.replace(/^www\./, ''); } catch { /* none */ }
  $('site').textContent = article.siteName || host;
  $('title').textContent = article.title || '';
  $('byline').textContent = article.byline || '';
  const minutes = Math.max(1, Math.round((article.length || 0) / 1100));
  $('time').textContent = `${minutes} min read`;
  const parsed = new DOMParser().parseFromString(article.content, 'text/html');
  const content = $('content');
  clean(parsed.body, content);
  // Readability repeats the title as the first heading more often than not.
  const first = content.querySelector('h1, h2');
  if (first && first.textContent.trim() === (article.title || '').trim()) first.remove();
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  event.preventDefault();
  api.send('navigate', { url: link.href });
});
$('original').addEventListener('click', () => api.send('reader-view'));

// Text size and face, remembered on this computer for the next article.
const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not kept */ } };
let size = Number(stored('reader-size')) || 19;
const setSize = (px) => {
  size = Math.min(28, Math.max(15, px));
  document.documentElement.style.setProperty('--reader-size', `${size}px`);
  store('reader-size', String(size));
};
setSize(size);
$('smaller').addEventListener('click', () => setSize(size - 1));
$('larger').addEventListener('click', () => setSize(size + 1));
const setFace = (serif) => {
  document.body.classList.toggle('serif', serif);
  $('face').setAttribute('aria-pressed', String(serif));
  store('reader-serif', serif ? '1' : '');
};
setFace(stored('reader-serif') === '1');
$('face').addEventListener('click', () => setFace(!document.body.classList.contains('serif')));

// Read aloud, where the system has a voice: paragraph by paragraph, the one
// being read marked, stopped by the same button.
const speech = window.speechSynthesis;
let reading = false;
function showSpeak() { $('speak').hidden = !speech || !speech.getVoices().length; }
if (speech) { showSpeak(); speech.addEventListener('voiceschanged', showSpeak); }
$('speak').addEventListener('click', () => {
  if (reading) { speech.cancel(); return; }
  const parts = [...$('content').querySelectorAll('h2, h3, p, li, blockquote')].filter((n) => n.textContent.trim());
  if (!parts.length) return;
  reading = true;
  $('speak').textContent = 'Stop reading';
  const done = () => {
    reading = false;
    $('speak').textContent = 'Read aloud';
    for (const n of $('content').querySelectorAll('.speaking')) n.classList.remove('speaking');
  };
  parts.forEach((node, i) => {
    const u = new SpeechSynthesisUtterance(node.textContent);
    u.lang = document.documentElement.lang || 'en';
    u.onstart = () => { node.classList.add('speaking'); node.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
    u.onend = () => { node.classList.remove('speaking'); if (i === parts.length - 1) done(); };
    u.onerror = done;
    speech.speak(u);
  });
});
window.addEventListener('beforeunload', () => { if (speech) speech.cancel(); });

api.onState((state) => applyThemePrefs(state.prefs));
load();
