'use strict';

/**
 * Dark websites: pages that only come in light, shown dark.
 *
 * Chromium has a forced dark mode of its own (`WebContentsForceDark`), but it
 * is one switch for the whole process. The toolbar, the menus and every page
 * of this browser are web contents too, and in a light theme they declare
 * `color-scheme: light` - which is exactly what the forced mode darkens. So
 * this does it per page instead, the way Dark Reader's filter mode does: the
 * page is inverted and turned back round the colour wheel, so white becomes
 * near-black and blue stays blue, and pictures and video are inverted again
 * so they look as they should.
 *
 * Only a page that is light already. A site with a dark theme of its own -
 * most, now, when the system is dark - is left as its designers drew it,
 * and so is one the user turned it off for (site-prefs, `dark: false`).
 * Never in a private window: whether a page is inverted is something a script
 * on it can measure.
 */

/** Marks a picture set by a style sheet, which the page's own markup does not show. */
const KEEP = 'data-debrowser-dark-keep';

/**
 * The filter on the root element. The specification exempts the root from the
 * rule that a filter makes a containing block for fixed elements, so a fixed
 * header stays fixed - on any other element this would break them.
 *
 * An author sheet, though a user one would outrank the page's own important
 * rules: Electron's removeInsertedCSS only finds author sheets, and a user one
 * could never be taken off again. The `:not(#\#)` raises it over the page's
 * ordinary rules. Pictures are turned back once, at the outermost: one inside
 * a <picture>, or inside a marked element, would otherwise be turned twice.
 */
const OUTSIDE = `:not(picture *):not([${KEEP}] *)`;
const CSS = `
html:not(#\\#) {
  filter: invert(1) hue-rotate(180deg) brightness(0.94) !important;
  background-color: #fff !important;
}
:is(img, video, picture, canvas, embed, object, iframe, svg image, [${KEEP}])${OUTSIDE}:not(#\\#) {
  filter: invert(1) hue-rotate(180deg) !important;
}
`;

/**
 * True when the page, as drawn, is light. What is drawn at a few points of the
 * window, down to the first element with a background: a single-page app paints
 * on its #app or #root, not on html or body. Colours go through a canvas, as
 * computed styles keep oklch(), lab() and color() in their own notation. Where
 * nothing paints a background, not even the root or the body, the colour
 * scheme decides it - which the text, drawn in the scheme's colours, shows.
 */
const IS_LIGHT = `(() => {
  const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  const shade = (colour) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#0000';
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a < 26 ? null : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  const painted = (el) => {
    for (; el; el = el.parentElement) {
      const s = shade(getComputedStyle(el).backgroundColor);
      if (s !== null) return s;
    }
    return null;
  };
  const root = document.documentElement;
  const body = document.body || root;
  // The canvas takes the root's background, or the body's when the root has none.
  const text = shade(getComputedStyle(body).color);
  const canvas = shade(getComputedStyle(root).backgroundColor) ?? shade(getComputedStyle(body).backgroundColor) ??
    (text === null ? 1 : 1 - text);
  const w = innerWidth, h = innerHeight;
  const points = w && h ? [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] : [];
  const shades = points.map(([x, y]) => painted(document.elementFromPoint(w * x, h * y)) ?? canvas);
  if (!shades.length) shades.push(canvas);
  return shades.reduce((a, b) => a + b, 0) / shades.length > 0.55;
})()`;

/**
 * Marks the pictures a style sheet sets, now and as the page adds them, so they
 * are turned back too. Not every one: an element with words of its own is only
 * marked when its picture covers it, as a hero image does - a small icon beside
 * the words would turn them back as well, dark on the darkened page.
 */
const MARK = `(() => {
  if (window.__debrowserDarkKeep) return;
  window.__debrowserDarkKeep = true;
  const root = document.documentElement;
  const mark = (nodes) => {
    const keep = [];
    for (const node of nodes) {
      if (node.nodeType !== 1) continue;
      for (const el of [node, ...node.querySelectorAll('*')]) {
        if (el === root || el === document.body || el.hasAttribute('${KEEP}')) continue;
        const style = getComputedStyle(el);
        if (!style.backgroundImage.includes('url(')) continue;
        if (!el.textContent.trim() || /cover|contain/.test(style.backgroundSize)) keep.push(el);
      }
    }
    for (const el of keep) el.setAttribute('${KEEP}', '');
  };
  mark([root]);
  new MutationObserver((records) => mark(records.flatMap((r) => [...r.addedNodes])))
    .observe(root, { childList: true, subtree: true });
})()`;

/** Whether dark websites apply to this host: on in Settings, and not turned off there. */
function wanted(prefs, sitePrefs, host) {
  if (!prefs || prefs.get('darkWebsites') !== true) return false;
  return !(sitePrefs && host && sitePrefs.get(host, 'dark') === false);
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname : null;
  } catch {
    return null;
  }
}

const usable = (tab) => tab && !tab.internal && tab.isLive && !tab.wc.isDestroyed();

/**
 * Darken the tab's page, if it should be and is not already. Called on every
 * `dom-ready` with `newPage`, as the inserted sheet goes with the document and
 * each new page is decided afresh; and when the setting or the site's choice
 * changes. `darkGen` counts the decisions: one overtaken while it waited on the
 * page - switched off again, or the page gone - does nothing.
 */
async function apply(tab, prefs, sitePrefs, { newPage = false } = {}) {
  if (!usable(tab)) return;
  if (newPage) tab.darkCssKey = null;
  if (tab.darkCssKey) return;
  const gen = tab.darkGen = (tab.darkGen || 0) + 1;
  const still = () => gen === tab.darkGen && usable(tab) && wanted(prefs, sitePrefs, hostOf(tab.wc.getURL()));
  if (!hostOf(tab.wc.getURL()) || !still()) return;
  try {
    const light = await tab.wc.executeJavaScriptInIsolatedWorld(1002, [{ code: IS_LIGHT }]);
    if (light !== true || !still()) return;
    const key = await tab.wc.insertCSS(CSS, { cssOrigin: 'author' });
    if (!still()) {
      if (!tab.wc.isDestroyed()) tab.wc.removeInsertedCSS(key).catch(() => {});
      return;
    }
    tab.darkCssKey = key;
    tab.wc.executeJavaScriptInIsolatedWorld(1002, [{ code: MARK }]).catch(() => {});
  } catch { /* gone, or a page that cannot be styled */ }
}

/** Take the darkening off the tab's current page, and stop any decision still being made. */
async function remove(tab) {
  if (!tab) return;
  tab.darkGen = (tab.darkGen || 0) + 1;
  const key = tab.darkCssKey;
  tab.darkCssKey = null;
  if (!key || !tab.isLive || tab.wc.isDestroyed()) return;
  await tab.wc.removeInsertedCSS(key).catch(() => {});
}

/**
 * Decide again, as the page sees it now: after the theme changes, a page with
 * a dark design of its own may have turned dark, and one darkened before would
 * then be inverted back to light.
 */
async function recheck(tab, prefs, sitePrefs) {
  if (!usable(tab) || !wanted(prefs, sitePrefs, hostOf(tab.wc.getURL()))) return;
  await remove(tab);
  await apply(tab, prefs, sitePrefs);
}

module.exports = { apply, remove, recheck, wanted, hostOf, CSS, KEEP };
