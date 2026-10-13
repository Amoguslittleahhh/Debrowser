'use strict';

/**
 * A page, as a terminal can show it.
 *
 * Each character cell stands for CELL_W x CELL_H pixels of the page and shows
 * two of them stacked: "▀" drawn with the top half's colour as foreground and
 * the bottom half's as background, which doubles the vertical resolution a
 * terminal otherwise has. That gives the picture - layout, colours, images,
 * buttons - at a terminal's resolution, which on its own makes text a smudge.
 * So the page's text is laid on top as real characters, each in the cell its
 * glyph's centre falls in, in the text's own colour over the colour most of
 * its cell is: the picture says where things are, the characters say what
 * they say. Browsh and Carbonyl make the same trade.
 *
 * Pure: pixels and text in, cells and escape codes out, so the test suite can
 * check it without a terminal (src/main/testing/smoke.js).
 */

const CELL_W = 8;
const CELL_H = 16;

/** The terminal's colours: 'truecolor', '256', or '16' (the Linux console). */
function colorMode(env = process.env) {
  const forced = env.DEBROWSER_TERMINAL_COLORS;
  if (forced === 'truecolor' || forced === '256' || forced === '16') return forced;
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM || '')) return 'truecolor';
  if (env.TERM === 'linux') return '16';
  return '256';
}

/** The average colour of a rectangle of a BGRA bitmap. */
function average(bmp, width, x0, y0, w, h) {
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let y = y0; y < y0 + h; y++) {
    let i = (y * width + x0) * 4;
    for (let x = 0; x < w; x++, i += 4) { b += bmp[i]; g += bmp[i + 1]; r += bmp[i + 2]; n++; }
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0];
}

/**
 * The colour most of a rectangle is: what is behind a character, as opposed to
 * its average, which a border or an image's edge would muddy. Colours are
 * counted at four bits a channel, so anti-aliasing does not split the vote,
 * and the winner is the average of the pixels that voted for it, so a
 * background comes out as exactly itself.
 */
function dominant(bmp, width, x0, y0, w, h) {
  const votes = new Map();
  let best = null;
  for (let y = y0; y < y0 + h; y++) {
    let i = (y * width + x0) * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const key = ((bmp[i + 2] >> 4) << 8) | ((bmp[i + 1] >> 4) << 4) | (bmp[i] >> 4);
      let v = votes.get(key);
      if (!v) { v = [0, 0, 0, 0]; votes.set(key, v); }
      v[0] += bmp[i + 2]; v[1] += bmp[i + 1]; v[2] += bmp[i]; v[3]++;
      if (!best || v[3] > best[3]) best = v;
    }
  }
  return best ? [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]), Math.round(best[2] / best[3])] : [0, 0, 0];
}

/**
 * The cells for a frame: `cols` x `rows`, each { ch, fg, bg }.
 *
 * @param {Buffer} bmp    BGRA pixels, `width` x `height` (Electron's toBitmap)
 * @param {Array}  texts  [x, y, ch, [r, g, b]] - a character and its centre, in page pixels
 */
function cells(bmp, width, height, cols, rows, texts = []) {
  const out = new Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * CELL_W;
      const y = row * CELL_H;
      if (x + CELL_W > width || y + CELL_H > height) {
        out[row * cols + col] = { ch: ' ', fg: [0, 0, 0], bg: [0, 0, 0] };
        continue;
      }
      out[row * cols + col] = {
        ch: '▀',
        fg: average(bmp, width, x, y, CELL_W, CELL_H / 2),
        bg: average(bmp, width, x, y + CELL_H / 2, CELL_W, CELL_H / 2)
      };
    }
  }
  for (const [x, y, ch, color] of texts) {
    const col = Math.floor(x / CELL_W);
    const row = Math.floor(y / CELL_H);
    if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
    const cell = out[row * cols + col];
    if (cell.text) continue;                 // the first character to land keeps the cell
    const px = col * CELL_W;
    const py = row * CELL_H;
    if (px + CELL_W > width || py + CELL_H > height) continue;
    const bg = dominant(bmp, width, px, py, CELL_W, CELL_H);
    out[row * cols + col] = { ch, fg: readable(color, bg), bg, text: true };
  }
  return out;
}

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The text's colour, unless the cell's background turned out too close to it
 * to read - which happens where the colour vote went to the glyph's own pixels
 * or to an image behind it. Then black or white, whichever stands out.
 */
function readable(fg, bg) {
  if (Math.abs(luminance(fg) - luminance(bg)) >= 60) return fg;
  return luminance(bg) > 128 ? [0, 0, 0] : [255, 255, 255];
}

/* ---- Colour, in the terminal's own terms ------------------------------ */

const BASE16 = [
  [0, 0, 0], [170, 0, 0], [0, 170, 0], [170, 85, 0], [0, 0, 170], [170, 0, 170], [0, 170, 170], [170, 170, 170],
  [85, 85, 85], [255, 85, 85], [85, 255, 85], [255, 255, 85], [85, 85, 255], [255, 85, 255], [85, 255, 255], [255, 255, 255]
];

function nearest16([r, g, b], limit = 16) {
  let best = 0; let bestD = Infinity;
  for (let i = 0; i < limit; i++) {
    const [R, G, B] = BASE16[i];
    const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** xterm's 256: the 6x6x6 cube, or the 24-step grey ramp where that is closer. */
function to256([r, g, b]) {
  const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const level = (n) => (n === 0 ? 0 : 55 + n * 40);
  const cube = 16 + 36 * q(r) + 6 * q(g) + q(b);
  const cubeD = (r - level(q(r))) ** 2 + (g - level(q(g))) ** 2 + (b - level(q(b))) ** 2;
  const grey = Math.round((r + g + b) / 3);
  const gi = Math.max(0, Math.min(23, Math.round((grey - 8) / 10)));
  const gv = 8 + gi * 10;
  const greyD = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;
  return greyD < cubeD ? 232 + gi : cube;
}

function sgr(fg, bg, mode) {
  if (mode === 'truecolor') return `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]};48;2;${bg[0]};${bg[1]};${bg[2]}m`;
  if (mode === '256') return `\x1b[38;5;${to256(fg)};48;5;${to256(bg)}m`;
  // The Linux console: sixteen foreground colours, eight background.
  const f = nearest16(fg);
  const b = nearest16(bg, 8);
  return `\x1b[${f < 8 ? 30 + f : 90 + f - 8};${40 + b}m`;
}

/**
 * The escape codes that turn `prev` into `next`, starting at screen row
 * `top` (1-based): only the cells that changed, so a page that is still costs
 * nothing and a scroll costs the rows it moved.
 */
function encode(next, prev, cols, rows, mode, top = 1) {
  let out = '';
  let lastStyle = '';
  let cursor = -1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const c = next[i];
      const p = prev && prev[i];
      if (p && p.ch === c.ch && same(p.fg, c.fg, mode) && same(p.bg, c.bg, mode)) continue;
      if (cursor !== i) out += `\x1b[${row + top};${col + 1}H`;
      // The Linux console has eight background colours to sixteen foreground,
      // so a white cell drawn as halves comes out white over grey. One that is
      // a single colour throughout is a full block in the foreground instead.
      const solid = mode === '16' && c.ch === '▀' && nearest16(c.fg) === nearest16(c.bg);
      const style = sgr(c.fg, c.bg, mode);
      if (style !== lastStyle) { out += style; lastStyle = style; }
      out += solid ? '█' : c.ch;
      cursor = i + 1;
    }
  }
  return out ? `${out}\x1b[0m` : '';
}

function same(a, b, mode) {
  if (mode === 'truecolor') return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  if (mode === '256') return to256(a) === to256(b);
  return nearest16(a) === nearest16(b);
}

module.exports = { CELL_W, CELL_H, colorMode, cells, encode, sgr, to256, nearest16, readable };
