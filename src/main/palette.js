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

/**
 * The designs' neutrals, mirroring the design blocks in theme.css. `raised` is
 * what the new tab page is drawn on in every design but Legacy, so a spare or
 * a fresh one never shows a strip of the wrong grey before it paints.
 */
const DESIGNS = {
  legacy: PALETTES,
  ledger: {
    light: { bg: '#e4e8e1', raised: '#f7f8f5', text: '#1c2320', dim: '#5f6a64', border: '#cdd3cb' },
    dark: { bg: '#131514', raised: '#1a1c1b', text: '#e6e8e4', dim: '#8e948f', border: '#2e322f' }
  },
  paper: {
    light: { bg: '#f4f1ea', raised: '#fbfaf6', text: '#1e1c19', dim: '#6e685e', border: '#d9d3c7' },
    dark: { bg: '#1b1916', raised: '#22201c', text: '#ede7da', dim: '#a39b8e', border: '#3a3630' }
  },
  grid: {
    light: { bg: '#ffffff', raised: '#ffffff', text: '#0f0f0f', dim: '#595959', border: '#cfcfcf' },
    dark: { bg: '#0a0a0a', raised: '#111111', text: '#f2f2f2', dim: '#8c8c8c', border: '#3a3a3a' }
  }
};

/** A design's palette, light or dark; an unknown design is Legacy. */
function paletteFor(design, light) {
  const set = DESIGNS[design] || DESIGNS.legacy;
  return light ? set.light : set.dark;
}

const DEFAULT_ACCENT = '#2f857b';

/** Answers {light, accent, design} for the window. Set by main.js once the window exists. */
let source = () => ({ light: false, accent: DEFAULT_ACCENT, design: 'legacy' });
function useTheme(fn) { source = fn; }

/** The palette in force: {light, accent, p}. */
function current() {
  const { light, accent, design } = source();
  return {
    light: Boolean(light),
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : DEFAULT_ACCENT,
    design: DESIGNS[design] ? design : 'legacy',
    p: paletteFor(design, light)
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
  if (!pages.isInternal(url)) return '#ffffff';
  const { p, design } = current();
  return design !== 'legacy' && pages.pageName(url) === 'newtab' ? p.raised : p.bg;
}

module.exports = { PALETTES, DESIGNS, paletteFor, useTheme, current, surfaceFor };
