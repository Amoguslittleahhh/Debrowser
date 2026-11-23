'use strict';
// Pure helpers for the terminal browser: PNG decoding, the three ways of
// drawing a frame (kitty, sixel, half blocks), terminal input parsing and
// finding a Chromium. No dependencies, so it runs anywhere Node 22 does.
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------- PNG (8-bit RGB/RGBA, non-interlaced: what Chromium emits) ----------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8, w = 0, h = 0, type = 0, depth = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), name = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (name === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      depth = body[8]; type = body[9]; interlace = body[12];
    } else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace || (type !== 2 && type !== 6)) {
    throw new Error(`unsupported PNG (depth ${depth}, type ${type})`);
  }
  const bpp = type === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (!decodePng.out || decodePng.out.length !== h * stride) decodePng.out = new Uint8Array(h * stride);
  const out = decodePng.out; // reused: callers use a frame before decoding the next
  // One loop per filter type: a branch per byte is what made this slow.
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    if (f === 0 || (f === 2 && !y)) out.set(raw.subarray(src, src + stride), dst);
    else if (f === 1) {
      for (let x = 0; x < bpp; x++) out[dst + x] = raw[src + x];
      for (let x = bpp; x < stride; x++) out[dst + x] = raw[src + x] + out[dst + x - bpp];
    } else if (f === 2) {
      for (let x = 0; x < stride; x++) out[dst + x] = raw[src + x] + out[up + x];
    } else if (f === 3) {
      for (let x = 0; x < stride; x++) {
        out[dst + x] = raw[src + x] + (((x >= bpp ? out[dst + x - bpp] : 0) + (y ? out[up + x] : 0)) >> 1);
      }
    } else if (f === 4) {
      for (let x = 0; x < bpp; x++) out[dst + x] = raw[src + x] + (y ? out[up + x] : 0);
      for (let x = bpp; x < stride; x++) {
        const a = out[dst + x - bpp], b = y ? out[up + x] : 0, c = y ? out[up + x - bpp] : 0;
        let pa = b - c, pb = a - c, pc = pa + pb;
        if (pa < 0) pa = -pa;
        if (pb < 0) pb = -pb;
        if (pc < 0) pc = -pc;
        out[dst + x] = raw[src + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
    }
  }
  return { width: w, height: h, bpp, data: out };
}

// ---------- kitty graphics protocol: the PNG goes over as-is ----------
// Draws image `id` at the cursor, scaled to cols x rows cells, cursor unmoved.
function kittyImage(png, id, cols, rows) {
  const b64 = png.toString('base64');
  let s = '';
  for (let i = 0; i < b64.length; i += 4096) {
    const more = i + 4096 < b64.length ? 1 : 0;
    const head = i ? `m=${more}` : `a=T,f=100,i=${id},q=2,C=1,c=${cols},r=${rows},m=${more}`;
    s += `\x1b_G${head};${b64.slice(i, i + 4096)}\x1b\\`;
  }
  return s;
}
const kittyDelete = (id) => `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;

// ---------- sixel: fixed 6x7x6 colour cube with 4x4 ordered dithering ----------
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
let palette = '';
for (let i = 0; i < 252; i++) {
  const pc = (v, n) => Math.round((v / n) * 100);
  palette += `#${i};2;${pc(Math.floor(i / 42), 5)};${pc(Math.floor(i / 6) % 7, 6)};${pc(i % 6, 5)}`;
}
// Dithered channel -> palette part, per Bayer threshold, so the pixel loop is three lookups.
const QR = new Uint8Array(16 * 256), QG = new Uint8Array(16 * 256), QB = new Uint8Array(16 * 256);
for (let t = 0; t < 16; t++) {
  for (let v = 0; v < 256; v++) {
    const q = (n) => Math.max(0, Math.min(n, Math.round((v / 255) * n + t / 16 - 0.5)));
    QR[t * 256 + v] = q(5) * 42; QG[t * 256 + v] = q(6) * 6; QB[t * 256 + v] = q(5);
  }
}
// Encoded straight into reused byte buffers: building it as JS strings made the garbage
// collector the biggest cost during video.
let six = { idx: null, bits: null, buf: Buffer.alloc(1 << 20) };
function sixel(img, maxH) {
  const { width: w, bpp, data } = img;
  const h = Math.min(img.height, maxH);
  if (!six.idx || six.idx.length < w * h) six.idx = new Uint8Array(w * h);
  if (!six.bits || six.bits.length < 256 * w) six.bits = new Uint8Array(256 * w);
  const { idx, bits } = six;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * bpp, d = (BAYER[(y & 3) * 4 + (x & 3)]) << 8;
      idx[y * w + x] = QR[d + data[o]] + QG[d + data[o + 1]] + QB[d + data[o + 2]];
    }
  }
  let buf = six.buf, n = 0;
  const room = (k) => {
    if (n + k <= buf.length) return;
    const bigger = Buffer.alloc(Math.max(buf.length * 2, n + k));
    buf.copy(bigger, 0, 0, n); buf = six.buf = bigger;
  };
  const str = (t) => { room(t.length); n += buf.write(t, n, 'latin1'); };
  const num = (v) => { // a small decimal number, without making a string
    room(4);
    if (v >= 100) buf[n++] = 48 + ((v / 100) | 0);
    if (v >= 10) buf[n++] = 48 + (((v / 10) | 0) % 10);
    buf[n++] = 48 + (v % 10);
  };
  const run = (count, ch) => {
    if (count > 3) { room(1); buf[n++] = 33; if (count >= 1000) str(String(count)); else num(count); room(1); buf[n++] = ch; }
    else { room(count); for (let i = 0; i < count; i++) buf[n++] = ch; }
  };
  str(`\x1bP0;1;0q"1;1;${w};${h}${palette}`);
  const used = [], seen = new Uint8Array(256), lo = new Int32Array(256), hi = new Int32Array(256);
  for (let y0 = 0; y0 < h; y0 += 6) {
    used.length = 0;
    for (let r = 0; r < 6 && y0 + r < h; r++) {
      for (let x = 0; x < w; x++) {
        const c = idx[(y0 + r) * w + x];
        if (!seen[c]) { seen[c] = 1; used.push(c); lo[c] = x; hi[c] = x; }
        else if (x < lo[c]) lo[c] = x;
        else if (x > hi[c]) hi[c] = x;
        bits[c * w + x] |= 1 << r;
      }
    }
    for (const c of used) {
      // Only the span where this colour appears; the gap before it is one run of "empty".
      room(1); buf[n++] = 35; num(c); // #c
      if (lo[c]) run(lo[c], 63);
      let count = 0, prev = -1;
      for (let x = lo[c], end = hi[c]; x <= end; x++) {
        const v = bits[c * w + x];
        bits[c * w + x] = 0;
        if (v === prev) count++;
        else { if (count) run(count, 63 + prev); prev = v; count = 1; }
      }
      run(count, 63 + prev);
      room(1); buf[n++] = 36; // $
      seen[c] = 0;
    }
    room(1); buf[n++] = 45; // -
  }
  str('\x1b\\');
  return Buffer.from(buf.subarray(0, n)); // a copy: the work buffer is reused next frame
}

// ---------- quarter blocks: each cell is 2x2 pixels in two colours, truecolor ----------
// Each pixel is the average of its share of a larger frame, and the four are split into
// the two colour groups that fit them best, drawn with one of the quadrant characters.
// `prev` (3 ints per cell) holds what was last drawn so only changed cells are re-sent.
// `text` (cell index -> [char, rgb]) puts the page's own characters in cells instead.
const QUAD = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';
const dist = (a, b) => Math.abs((a >> 16) - (b >> 16)) + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) + Math.abs((a & 255) - (b & 255));
function blocks(img, cols, rows, top, prev, text) {
  const { width: w, height: h, bpp, data } = img;
  let s = '', at = -1, fg = -1, bg = -1;
  const rgb = (v) => `${v >> 16};${(v >> 8) & 255};${v & 255}`;
  const q = new Float64Array(12); // 4 quadrants x r,g,b
  const avg = (x0, x1, y0, y1, o) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) { const i = (y * w + x) * bpp; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    }
    q[o] = r / n; q[o + 1] = g / n; q[o + 2] = b / n;
  };
  const pack = (r, g, b) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // The cell's source rectangle, split in four (each part at least one pixel).
      const xs = [0, 1, 2].map((k) => Math.min(w, Math.floor(((c * 2 + k) * w) / (cols * 2))));
      const ys = [0, 1, 2].map((k) => Math.min(h, Math.floor(((r * 2 + k) * h) / (rows * 2))));
      for (let k = 0; k < 2; k++) { if (xs[k + 1] <= xs[k]) xs[k + 1] = Math.min(w, xs[k] + 1); if (ys[k + 1] <= ys[k]) ys[k + 1] = Math.min(h, ys[k] + 1); }
      const x0 = Math.min(xs[0], w - 1), y0 = Math.min(ys[0], h - 1);
      avg(x0, Math.max(x0 + 1, xs[1]), y0, Math.max(y0 + 1, ys[1]), 0);
      avg(Math.min(xs[1], w - 1), Math.max(Math.min(xs[1], w - 1) + 1, xs[2]), y0, Math.max(y0 + 1, ys[1]), 3);
      avg(x0, Math.max(x0 + 1, xs[1]), Math.min(ys[1], h - 1), Math.max(Math.min(ys[1], h - 1) + 1, ys[2]), 6);
      avg(Math.min(xs[1], w - 1), Math.max(Math.min(xs[1], w - 1) + 1, xs[2]), Math.min(ys[1], h - 1), Math.max(Math.min(ys[1], h - 1) + 1, ys[2]), 9);
      // Best split of the four into two groups (7 ways), by squared error from group means.
      let best = Infinity, mask = 0, F = 0, B = 0;
      for (let m = 1; m < 15; m++) {
        if (m & 8) continue; // a split and its complement are the same split
        const sum = [0, 0, 0, 0, 0, 0], cnt = [0, 0];
        for (let k = 0; k < 4; k++) { const g = (m >> k) & 1; sum[g * 3] += q[k * 3]; sum[g * 3 + 1] += q[k * 3 + 1]; sum[g * 3 + 2] += q[k * 3 + 2]; cnt[g]++; }
        let err = 0;
        for (let k = 0; k < 4; k++) {
          const g = (m >> k) & 1;
          for (let ch = 0; ch < 3; ch++) { const d = q[k * 3 + ch] - sum[g * 3 + ch] / cnt[g]; err += d * d; }
        }
        if (err < best) {
          best = err; mask = m;
          F = pack(sum[3] / cnt[1], sum[4] / cnt[1], sum[5] / cnt[1]); B = pack(sum[0] / cnt[0], sum[1] / cnt[0], sum[2] / cnt[0]);
        }
      }
      let t = F, b2 = B, glyph = QUAD[mask];
      if (dist(F, B) < 24) { // the two groups look alike: a plain background cell
        b2 = pack((q[0] + q[3] + q[6] + q[9]) / 4, (q[1] + q[4] + q[7] + q[10]) / 4, (q[2] + q[5] + q[8] + q[11]) / 4);
        t = b2; glyph = ' ';
      }
      const k = r * cols + c, ch = text && text.get(k);
      if (ch) { // the page's own character, on the cell's average colour (its pixel text is hidden)
        b2 = pack((q[0] + q[3] + q[6] + q[9]) / 4, (q[1] + q[4] + q[7] + q[10]) / 4, (q[2] + q[5] + q[8] + q[11]) / 4);
        t = ch[1]; glyph = ch[0];
      }
      const key = glyph.codePointAt(0);
      if (prev[k * 3] === t && prev[k * 3 + 1] === b2 && prev[k * 3 + 2] === key) continue;
      prev[k * 3] = t; prev[k * 3 + 1] = b2; prev[k * 3 + 2] = key;
      if (at !== k) s += `\x1b[${top + r};${c + 1}H`;
      if (glyph !== ' ' && t !== fg) { s += `\x1b[38;2;${rgb(t)}m`; fg = t; }
      if (b2 !== bg) { s += `\x1b[48;2;${rgb(b2)}m`; bg = b2; }
      s += glyph;
      at = k + 1;
    }
    at = -1;
  }
  return s && s + '\x1b[0m';
}

// Text boxes from DOMSnapshot.captureSnapshot laid onto the cell grid, one character per
// cell. TEXT_STYLES is the computedStyles list the snapshot must be taken with.
const TEXT_STYLES = ['color', 'visibility', 'opacity', 'overflow-x', 'overflow-y', 'clip'];
function textCells(snap, cols, rows, cssPerCol, cssPerRow) {
  const cells = new Map(), doc = snap.documents[0], str = snap.strings;
  if (!doc) return cells;
  const { layout, textBoxes, nodes } = doc, sx = doc.scrollOffsetX || 0, sy = doc.scrollOffsetY || 0;
  const layoutOf = new Map();
  layout.nodeIndex.forEach((n, li) => layoutOf.set(n, li));
  const style = (li, k) => str[layout.styles[li][k]] || '';
  // The visible rectangle of a node: its ancestors' clipping (overflow, clip) intersected,
  // or null when an ancestor is transparent. Text in a closed menu or a "skip to content"
  // link has a layout but is never painted, and must not be drawn.
  const clipCache = new Map();
  const visibleRect = (n) => {
    if (n < 0) return [-Infinity, -Infinity, Infinity, Infinity];
    if (clipCache.has(n)) return clipCache.get(n);
    let r = visibleRect(nodes.parentIndex[n]);
    const li = layoutOf.get(n);
    if (r && li !== undefined) {
      if (style(li, 2) === '0') r = null;
      else if (style(li, 3) !== 'visible' || style(li, 4) !== 'visible' || (style(li, 5) && style(li, 5) !== 'auto')) {
        const [x, y, w, h] = layout.bounds[li];
        r = [Math.max(r[0], x), Math.max(r[1], y), Math.min(r[2], x + w), Math.min(r[3], y + h)];
        if (r[0] >= r[2] || r[1] >= r[3]) r = null;
      }
    }
    clipCache.set(n, r);
    return r;
  };
  const boxes = [];
  for (let i = 0; i < textBoxes.layoutIndex.length; i++) {
    const li = textBoxes.layoutIndex[i], [x, y, bw, bh] = textBoxes.bounds[i];
    const full = str[layout.text[li]];
    if (!full || bh < 4 || style(li, 1) === 'hidden') continue; // tiny text has no room in a cell
    const clip = visibleRect(nodes.parentIndex[layout.nodeIndex[li]]);
    const cx = x + bw / 2, cy = y + bh / 2;
    if (!clip || cx < clip[0] || cx > clip[2] || cy < clip[1] || cy > clip[3]) continue;
    const row = Math.floor((y - sy + bh / 2) / cssPerRow);
    if (row < 0 || row >= rows) continue;
    const m = /(\d+), (\d+), (\d+)(?:, ([\d.]+))?/.exec(style(li, 0));
    if (m && m[4] === '0') continue; // transparent text
    boxes.push({ x: x - sx, bw, row, part: [...full.substr(textBoxes.start[i], textBoxes.length[i])],
      // Clipped only where its box really cuts it (an ellipsis), not by rounding at the edge.
      left: clip[0] > x + 1 ? Math.round((clip[0] - sx) / cssPerCol) : -Infinity,
      right: clip[2] < x + bw - 1 ? Math.floor((clip[2] - sx) / cssPerCol) : Infinity,
      color: m ? (m[1] << 16) | (m[2] << 8) | +m[3] : 0 });
  }
  // Left to right along each row, letters side by side from where the run starts (pages are
  // laid out in a monospace font one cell wide). A run that would start inside the one before
  // it on the same line is moved along rather than written over it.
  boxes.sort((a, b) => a.row - b.row || a.x - b.x);
  // Separate items (menu entries, labels) that had a gap between them keep at least one cell
  // of it. Text cut off by its box (an ellipsis) is cut at the box's edge.
  let rowAt = -1, rowEnd = -1, endX = -Infinity;
  for (const { x, bw, row, part, color, left, right } of boxes) {
    if (row !== rowAt) { rowAt = row; rowEnd = -1; endX = -Infinity; }
    const natural = Math.round(x / cssPerCol), gap = x - endX >= 2 ? 1 : 0;
    const start = natural < rowEnd + gap && natural >= rowEnd - 12 ? rowEnd + gap : natural;
    part.forEach((ch, j) => {
      const col = start + j;
      if (ch !== ' ' && ch >= ' ' && col >= left && col < right && col < cols) cells.set(row * cols + col, [ch, color]);
    });
    rowEnd = Math.max(rowEnd, start + part.length);
    endX = Math.max(endX, x + bw);
  }
  // Checkboxes, radio buttons and switches are a few pixels each, a smudge at this size, so
  // they become one character that shows their state. Styled ones often hide the real input
  // (opacity 0) right over the box they draw, so only its ancestors' visibility counts.
  const checked = new Set((nodes.inputChecked && nodes.inputChecked.index) || []);
  layout.nodeIndex.forEach((n, li) => {
    const name = str[(nodes.nodeName || [])[n]];
    const attrs = (nodes.attributes && nodes.attributes[n]) || [];
    const attr = (k) => { for (let i = 0; i < attrs.length; i += 2) if (str[attrs[i]] === k) return str[attrs[i + 1]]; return null; };
    const type = name === 'INPUT' ? (attr('type') || '').toLowerCase() : null;
    const role = attr('role');
    let kind = null, on = false;
    if (type === 'checkbox' || type === 'radio') { kind = type; on = checked.has(n); }
    else if (role === 'checkbox' || role === 'switch' || role === 'radio') { kind = role === 'radio' ? 'radio' : 'checkbox'; on = attr('aria-checked') === 'true'; }
    if (!kind) return;
    const [x, y, bw, bh] = layout.bounds[li];
    if (bw < 4 || bh < 4) return;
    const clip = visibleRect(nodes.parentIndex[n]), cx = x + bw / 2, cy = y + bh / 2;
    if (!clip || cx < clip[0] || cx > clip[2] || cy < clip[1] || cy > clip[3]) return;
    const row = Math.floor((cy - sy) / cssPerRow), col = Math.floor((cx - sx) / cssPerCol);
    if (row < 0 || row >= rows || col < 0 || col >= cols) return;
    const m = /(\d+), (\d+), (\d+)/.exec(style(li, 0));
    cells.set(row * cols + col, [kind === 'radio' ? (on ? '◉' : '○') : (on ? '☒' : '☐'), m ? (m[1] << 16) | (m[2] << 8) | +m[3] : 0]);
  });
  return cells;
}

// ---------- keyboard: DOM key/code/keyCode for what the terminal sends ----------
const NAMED = {
  Enter: ['Enter', 13], Tab: ['Tab', 9], Backspace: ['Backspace', 8], Escape: ['Escape', 27],
  ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39], Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34], Insert: ['Insert', 45], Delete: ['Delete', 46],
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = [`F${i}`, 111 + i];
const PUNCT = {
  ' ': ['Space', 32], '-': ['Minus', 189], _: ['Minus', 189], '=': ['Equal', 187],
  '+': ['Equal', 187], ',': ['Comma', 188], '<': ['Comma', 188], '.': ['Period', 190],
  '>': ['Period', 190], '/': ['Slash', 191], '?': ['Slash', 191], ';': ['Semicolon', 186],
  ':': ['Semicolon', 186], "'": ['Quote', 222], '"': ['Quote', 222], '[': ['BracketLeft', 219],
  '{': ['BracketLeft', 219], ']': ['BracketRight', 221], '}': ['BracketRight', 221],
  '\\': ['Backslash', 220], '|': ['Backslash', 220], '`': ['Backquote', 192], '~': ['Backquote', 192],
};
')!@#$%^&*('.split('').forEach((ch, i) => { PUNCT[ch] = [`Digit${i}`, 48 + i]; });

// {key, code, keyCode, text?, shift, alt, ctrl}
function keyInfo(key, mods = {}) {
  if (NAMED[key]) {
    const [code, keyCode] = NAMED[key];
    return { key, code, keyCode, text: key === 'Enter' ? '\r' : undefined, ...mods };
  }
  let code = 'Unidentified', keyCode = 0;
  if (/^[a-z]$/i.test(key)) { code = `Key${key.toUpperCase()}`; keyCode = key.toUpperCase().charCodeAt(0); }
  else if (/^[0-9]$/.test(key)) { code = `Digit${key}`; keyCode = 48 + +key; }
  else if (PUNCT[key]) [code, keyCode] = PUNCT[key];
  const shift = mods.shift || /^[A-Z]$/.test(key) || /^[!@#$%^&*()_+{}|:"<>?~]$/.test(key);
  return { key, code, keyCode, text: mods.ctrl ? undefined : key, ...mods, shift };
}

const CSI_TILDE = { 1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown',
  7: 'Home', 8: 'End', 15: 'F5', 17: 'F6', 18: 'F7', 19: 'F8', 20: 'F9', 21: 'F10', 23: 'F11', 24: 'F12' };
const CSI_FINAL = { A: 'ArrowUp', B: 'ArrowDown', C: 'ArrowRight', D: 'ArrowLeft', H: 'Home',
  F: 'End', P: 'F1', Q: 'F2', R: 'F3', S: 'F4', Z: 'Tab' };
const modsOf = (n) => ({ shift: !!(n - 1 & 1), alt: !!(n - 1 & 2), ctrl: !!(n - 1 & 4) });

// Splits a chunk of terminal input into events:
// {type:'key', ...keyInfo} | {type:'mouse', button, x, y, release, motion, wheel, mods}
// | {type:'paste', text} | {type:'reply', seq} (answers to our queries).
function parseInput(str, state = {}) {
  const ev = [];
  if (state.paste != null) str = state.paste + str, state.paste = null;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (str.startsWith('\x1b[200~', i)) {
      const end = str.indexOf('\x1b[201~', i);
      if (end < 0) { state.paste = str.slice(i); break; }
      ev.push({ type: 'paste', text: str.slice(i + 6, end) });
      i = end + 6;
      continue;
    }
    if (ch === '\x1b' && (str[i + 1] === '[' || str[i + 1] === 'O') && i + 2 < str.length) {
      const m = /^\x1b([[O])([<?]?)([\d;]*)([A-Za-z~])/.exec(str.slice(i, i + 32));
      if (m) {
        i += m[0].length;
        const [, intro, priv, params, fin] = m;
        const nums = params.split(';').map(Number);
        if (priv === '<' && (fin === 'M' || fin === 'm')) {
          const b = nums[0];
          ev.push({ type: 'mouse', x: nums[1], y: nums[2], release: fin === 'm',
            motion: !!(b & 32), wheel: b & 64 ? ['up', 'down', 'left', 'right'][b & 3] : null,
            button: ['left', 'middle', 'right', 'none'][b & 3],
            shift: !!(b & 4), alt: !!(b & 8), ctrl: !!(b & 16) });
        } else if (priv === '?' || fin === 't' || (intro === '[' && fin === 'c')) {
          ev.push({ type: 'reply', seq: m[0] });
        } else if (fin === '~') {
          if (CSI_TILDE[nums[0]]) ev.push({ type: 'key', ...keyInfo(CSI_TILDE[nums[0]], modsOf(nums[1] || 1)) });
        } else if (CSI_FINAL[fin]) {
          const mods = modsOf(nums[1] || 1);
          if (fin === 'Z') mods.shift = true;
          ev.push({ type: 'key', ...keyInfo(CSI_FINAL[fin], mods) });
        }
        continue;
      }
    }
    if (ch === '\x1b') {
      const next = str[i + 1];
      if (next === undefined || next === '\x1b') { ev.push({ type: 'key', ...keyInfo('Escape') }); i++; continue; }
      const [k] = parseInput(next); // Alt+key
      if (k && k.type === 'key') ev.push({ ...k, alt: true, text: undefined });
      i += 2;
      continue;
    }
    const cp = str.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    i += len;
    if (cp === 13 || cp === 10) ev.push({ type: 'key', ...keyInfo('Enter') });
    else if (cp === 9) ev.push({ type: 'key', ...keyInfo('Tab') });
    else if (cp === 127 || cp === 8) ev.push({ type: 'key', ...keyInfo('Backspace') });
    else if (cp === 0) ev.push({ type: 'key', ...keyInfo(' ', { ctrl: true }) });
    else if (cp < 27) ev.push({ type: 'key', ...keyInfo(String.fromCharCode(96 + cp), { ctrl: true }) });
    else if (cp >= 32) ev.push({ type: 'key', ...keyInfo(String.fromCodePoint(cp)) });
  }
  return ev;
}

// ---------- which picture protocol the terminal speaks ----------
function pickMode(env, da1) {
  if (['kitty', 'sixel', 'blocks'].includes(env.DEBROWSER_MODE)) return env.DEBROWSER_MODE;
  if (env.TMUX) return 'blocks'; // tmux would need passthrough wrapping
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty' || env.GHOSTTY_RESOURCES_DIR ||
      ['WezTerm', 'ghostty'].includes(env.TERM_PROGRAM)) return 'kitty';
  if (da1 && /^\x1b\[\?[\d;]*c$/.test(da1) && da1.slice(3, -1).split(';').includes('4')) return 'sixel';
  return 'blocks';
}

// ---------- a Chromium to drive ----------
function findChrome(env = process.env) {
  if (env.DEBROWSER_CHROME) return env.DEBROWSER_CHROME;
  const home = os.homedir(), win = process.platform === 'win32', exe = (n) => (win ? `${n}.exe` : n);
  const globs = [
    [path.join(home, '.cache/puppeteer/chrome-headless-shell'), exe('chrome-headless-shell')],
    [path.join(home, win ? 'AppData/Local/ms-playwright' : '.cache/ms-playwright'), exe('chrome-headless-shell')],
    ['/opt/pw-browsers', 'chrome-headless-shell'],
    [path.join(home, '.cache/puppeteer/chrome'), exe('chrome')],
  ];
  for (const [dir, name] of globs) {
    const hits = [];
    const walk = (d, depth) => {
      let list = [];
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.name === name) hits.push(p);
      }
    };
    walk(dir, 0);
    if (hits.length) return hits.sort().pop(); // newest version sorts last
  }
  for (const name of ['chrome-headless-shell', 'chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']) {
    try { return execFileSync(win ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim(); } catch { /* next */ }
  }
  if (win) { // an installed Chrome or Edge works too
    for (const p of [`${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`]) if (fs.existsSync(p)) return p;
  }
  return null;
}

// What the address field turns into: a URL, or a search.
function toUrl(text) {
  const t = text.trim();
  if (/^[a-z]:[\\/]/i.test(t) || t.startsWith('\\\\')) return 'file:///' + t.replace(/\\/g, '/'); // a Windows path
  if (/^[a-z][\w+.-]*:/i.test(t) && !/^[\w.-]+:\d/.test(t)) return t;
  if (/^(localhost|[\w-]+(\.[\w-]+)+|\[[\d:a-f]+\])(:\d+)?(\/.*)?$/i.test(t)) {
    return (/^(localhost|127\.|\[)/.test(t) ? 'http://' : 'https://') + t;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

module.exports = { decodePng, kittyImage, kittyDelete, sixel, blocks, textCells, TEXT_STYLES, keyInfo, parseInput, pickMode, findChrome, toUrl };
