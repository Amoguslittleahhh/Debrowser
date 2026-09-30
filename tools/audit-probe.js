'use strict';

/**
 * What `tools/shoot.js --audit` runs inside each page: the rules every surface
 * is held to on every platform, measured rather than eyeballed.
 *
 *   text      no visible text under 11px
 *   contrast  4.5:1 for text, 3:1 from 18.66px bold or 24px (WCAG AA)
 *   targets   buttons, links and fields at least 24 x 24px (WCAG 2.2)
 *
 * Returned as a string of source so shoot.js can hand it to executeJavaScript;
 * nothing here runs in Node.
 */

module.exports = `(() => {
  const MIN_TEXT = 11;
  const MIN_TARGET = 24;

  // Any colour the browser reports - rgb(), color(srgb ...), oklab(), a mix -
  // resolved to sRGB by painting it once on a 1px canvas.
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const parse = (c) => {
    if (!c || c === 'transparent') return null;
    if (cache.has(c)) return cache.get(c);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const out = { r, g, b, a: a / 255 };
    cache.set(c, out);
    return out;
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1
  });
  // The colour actually behind an element: its ancestors' backgrounds, layered.
  const behind = (el) => {
    const stack = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0) { stack.push(bg); if (bg.a >= 1) break; }
    }
    let colour = parse(getComputedStyle(document.body).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 };
    if (colour.a < 1) colour = over(colour, document.documentElement.dataset.theme === 'light' || matchMedia('(prefers-color-scheme: light)').matches
      ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 1 });
    for (const bg of stack.reverse()) colour = over(bg, colour);
    return colour;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.3) return false;
    }
    return true;
  };
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const text = (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 28);
    return el.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : '');
  };

  const problems = [];
  const seen = new Set();
  const add = (kind, el, detail) => {
    const key = kind + name(el) + detail;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ kind, el: name(el), detail });
  };

  // Text: every element that directly holds visible text.
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || ['SCRIPT', 'STYLE', 'svg', 'SVG'].includes(el.tagName)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) ||
      (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && !['range', 'checkbox', 'radio', 'color'].includes(el.type) && (el.value || el.placeholder));
    if (!own) continue;
    // A decorative stand-in (a site's letter where its icon would be) is an icon, not text.
    if (el.closest('[aria-hidden="true"]')) continue;
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize);
    if (size < MIN_TEXT) add('text', el, size.toFixed(1) + 'px');
    const fg = parse(s.color);
    if (!fg) continue;
    const bg = behind(el);
    const ink = over({ ...fg, a: fg.a * Number(s.opacity || 1) }, bg);
    const [a, b] = [lum(ink), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    // Disabled controls and placeholders are exempt, as WCAG exempts them.
    if (ratio < need && !el.closest(':disabled, [aria-disabled="true"]')) add('contrast', el, ratio.toFixed(2) + ':1 (needs ' + need + ')');
  }

  // Targets: anything you click or type into.
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=menuitem], [role=tab]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    // A link inside running text is exempt: its size is the sentence's.
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue;
    if (el.type === 'checkbox' || el.type === 'radio') {
      // Its label, or the row it sits in (the site panel's rows toggle their box on a click anywhere).
      const label = el.closest('label, li') || (el.id && document.querySelector('label[for="' + el.id + '"]'));
      if (label && label.getBoundingClientRect().height >= MIN_TARGET) continue;
    }
    if (r.width < MIN_TARGET - 0.5 || r.height < MIN_TARGET - 0.5) {
      add('target', el, Math.round(r.width) + 'x' + Math.round(r.height));
    }
  }
  return problems;
})()`;
