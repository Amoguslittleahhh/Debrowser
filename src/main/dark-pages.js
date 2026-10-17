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

/**
 * The filter on the root element. The specification exempts the root from the
 * rule that a filter makes a containing block for fixed elements, so a fixed
 * header stays fixed - on any other element this would break them.
 */
const CSS = `
html {
  filter: invert(1) hue-rotate(180deg) brightness(0.94) !important;
  background-color: #fff !important;
}
img, video, picture, canvas, embed, object, iframe, svg image,
[style*="background-image"], [data-debrowser-dark-keep] {
  filter: invert(1) hue-rotate(180deg) !important;
}
`;

/** True when the page, as drawn, is light: its root or body background is mostly white. */
const IS_LIGHT = `(() => {
  const shade = (el) => {
    if (!el) return null;
    const parts = (getComputedStyle(el).backgroundColor.match(/[\\d.]+/g) || []).map(Number);
    if (parts.length < 3 || (parts.length > 3 && parts[3] < 0.1)) return null;
    return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
  };
  const shadeOf = shade(document.documentElement) ?? shade(document.body) ?? 1;
  return shadeOf > 0.55;
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

/**
 * Darken the tab's page, if it should be and is not already. Called on every
 * `dom-ready`; the inserted sheet goes with the document, so each new page is
 * decided afresh.
 */
async function apply(tab, prefs, sitePrefs) {
  if (!tab || tab.internal || !tab.isLive || tab.wc.isDestroyed()) return;
  tab.darkCssKey = null;   // the last page's sheet went with it
  const host = hostOf(tab.wc.getURL());
  if (!host || !wanted(prefs, sitePrefs, host)) return;
  try {
    const light = await tab.wc.executeJavaScriptInIsolatedWorld(1002, [{ code: IS_LIGHT }]);
    if (light !== true || tab.wc.isDestroyed()) return;
    tab.darkCssKey = await tab.wc.insertCSS(CSS, { cssOrigin: 'user' });
  } catch { /* gone, or a page that cannot be styled */ }
}

/** Take the darkening off the tab's current page, if it has it. */
async function remove(tab) {
  if (!tab || !tab.darkCssKey || !tab.isLive || tab.wc.isDestroyed()) return;
  const key = tab.darkCssKey;
  tab.darkCssKey = null;
  await tab.wc.removeInsertedCSS(key).catch(() => {});
}

module.exports = { apply, remove, wanted, hostOf, CSS };
