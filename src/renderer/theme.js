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

/* eslint-disable-next-line no-unused-vars -- read by chrome.js, panel.js, settings.js */
function applyThemePrefs(prefs) {
  if (!prefs) return;
  const body = document.body;

  const flags = {
    theme: prefs.theme,
    tabs: prefs.tabWidth,
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

  // Motion is opt-out in the OS and opt-out here; `still` is also set while a
  // page is off screen, because a throttled animation finishes in front of the
  // user instead of before them.
  body.classList.toggle('calm', prefs.reduceMotion === true);
}
