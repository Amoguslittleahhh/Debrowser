'use strict';

/**
 * Apply personalisation preferences to whichever view loads this.
 *
 * A plain script rather than a module, because every view here is a classic
 * script under a CSP with no module loader, and because this needs to run
 * before the first state arrives rather than after a fetch.
 *
 * Everything it touches is a `data-` attribute or a custom property, so a change
 * is a style recalculation on the elements that use it - never a rebuild. It
 * writes only on a real change, which matters because preferences ride along
 * with governor state on every tick: without the comparison, a browser sitting
 * idle would touch the DOM twice a second forever.
 */

/**
 * A stable colour for a site, from its hostname.
 *
 * Used where a page has no favicon to show: the tab strip while one loads or
 * never arrives, and the history list, which stores no icons at all. A letter
 * on a coloured field is recognisable at a glance in a way that a grey
 * placeholder is not, and it is why a strip of twenty tabs no longer reads as
 * one long grey bar.
 *
 * Deliberately here rather than in either caller. Two hashes would mean the
 * same site was one colour in the tab strip and another in history, which is
 * worse than no colour at all - the whole value is that it is the same one
 * everywhere.
 *
 * djb2, because it is four lines and its avalanche is good enough to keep
 * neighbouring hostnames apart, which is the only property that matters here.
 *
 * @param {string} text - a hostname, or anything stable about the site
 * @returns {number} a hue, 0-359
 */
/* eslint-disable-next-line no-unused-vars -- read by chrome.js and history.js */
function siteHue(text) {
  let hash = 5381;
  const source = String(text || '');
  for (let i = 0; i < source.length; i++) hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/* eslint-disable-next-line no-unused-vars -- read by chrome.js, panel.js, settings.js */
function applyThemePrefs(prefs) {
  if (!prefs) return;
  const body = document.body;

  const flags = {
    theme: prefs.theme,
    tabs: prefs.tabWidth,
    // Which way the chrome is laid out. The main process has already given the
    // view the matching rectangle; this is the stylesheet's half of the same
    // decision, and the two are read from one preference so they cannot
    // disagree about which shape the window is.
    layout: prefs.tabBarPosition === 'left' ? 'left' : 'top',
    meter: prefs.showMemoryMeter ? 'on' : 'off',
    dots: prefs.showTierDots ? 'on' : 'off'
  };
  for (const [key, value] of Object.entries(flags)) {
    if (body.dataset[key] !== value) body.dataset[key] = value;
  }

  if (body.style.getPropertyValue('--accent') !== prefs.accent) {
    body.style.setProperty('--accent', prefs.accent);
  }

  // The tab strip is its own colour, deliberately not the accent: it is the
  // largest painted area in the chrome, and what works as a 3px focus ring is
  // rarely what you want across the top of a window. 'mirror' is for anyone who
  // would rather not choose twice.
  const strip = prefs.tabBarColor === 'mirror' ? prefs.accent
    : prefs.tabBarColor === 'default' ? '' : prefs.tabBarColor;
  if (body.style.getPropertyValue('--strip') !== strip) {
    if (strip) body.style.setProperty('--strip', strip);
    else body.style.removeProperty('--strip');
  }

  // Translucency applies to the strip, not the window. See chrome.css; the
  // short version is that fading the whole window fades the page text with it.
  // `data-translucent` is separate from the number because the body only drops
  // its own background while there is actually something to see through to.
  const alpha = typeof prefs.windowOpacity === 'number' ? prefs.windowOpacity : 1;
  if (body.style.getPropertyValue('--strip-alpha') !== String(alpha)) {
    body.style.setProperty('--strip-alpha', String(alpha));
  }
  // Only on a change, like every other write in this file. Assigning a dataset
  // property is a setAttribute on <body>, and this runs on every state
  // broadcast - so an idle browser was touching an attribute twice a second for
  // a value that had not moved since launch.
  const translucent = alpha < 1 ? 'on' : 'off';
  if (body.dataset.translucent !== translucent) body.dataset.translucent = translucent;

  // Motion is opt-out in the OS and opt-out here; `still` is also set while a
  // page is off screen, because a throttled animation finishes in front of the
  // user instead of before them.
  body.classList.toggle('calm', prefs.reduceMotion === true);
}
