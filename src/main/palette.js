'use strict';

/**
 * The window's palette, for what the main process paints itself: the surface
 * behind a page before it draws, and the error page, which cannot load our
 * stylesheet. Mirrors the two palettes in theme.css; change one, change both.
 */

const pages = require('./pages');

const PALETTES = {
  light: { bg: '#f3f1ec', text: '#201f1c', dim: '#6b6559', border: '#dcd7cc' },
  dark: { bg: '#161614', text: '#eae7e0', dim: '#9b978e', border: '#33332e' }
};

const DEFAULT_ACCENT = '#2f857b';

/** Answers {light, accent} for the window. Set by main.js once the window exists. */
let source = () => ({ light: false, accent: DEFAULT_ACCENT });
function useTheme(fn) { source = fn; }

/** The palette in force: {light, accent, p}. */
function current() {
  const { light, accent } = source();
  return {
    light: Boolean(light),
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : DEFAULT_ACCENT,
    p: light ? PALETTES.light : PALETTES.dark
  };
}

/**
 * What a tab shows where its page has not painted. White behind a website,
 * as in every browser - a page that sets no background of its own is written
 * for white, and used to come up on this browser's dark surface, black text on
 * near-black. The theme's own surface behind our pages, so opening one never
 * flashes.
 */
function surfaceFor(url) {
  return pages.isInternal(url) ? current().p.bg : '#ffffff';
}

module.exports = { PALETTES, useTheme, current, surfaceFor };
