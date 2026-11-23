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
  const out = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y ? out[dst - stride + x] : 0;
      const c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[dst + x] = v;
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
function sixel(img, maxH) {
  const { width: w, bpp, data } = img;
  const h = Math.min(img.height, maxH);
  const idx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * bpp, d = BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5;
      const q = (v, n) => Math.max(0, Math.min(n, Math.round((v / 255) * n + d)));
      idx[y * w + x] = q(data[o], 5) * 42 + q(data[o + 1], 6) * 6 + q(data[o + 2], 5);
    }
  }
  let s = `\x1bP0;1;0q"1;1;${w};${h}${palette}`;
  const bits = new Uint8Array(256 * w), used = [], seen = new Uint8Array(256);
  for (let y0 = 0; y0 < h; y0 += 6) {
    used.length = 0;
    for (let r = 0; r < 6 && y0 + r < h; r++) {
      for (let x = 0; x < w; x++) {
        const c = idx[(y0 + r) * w + x];
        if (!seen[c]) { seen[c] = 1; used.push(c); }
        bits[c * w + x] |= 1 << r;
      }
    }
    for (const c of used) {
      s += `#${c}`;
      let run = 0, prev = -1;
      const flush = () => {
        if (!run) return;
        const ch = String.fromCharCode(63 + prev);
        s += run > 3 ? `!${run}${ch}` : ch.repeat(run);
      };
      for (let x = 0; x < w; x++) {
        const v = bits[c * w + x];
        bits[c * w + x] = 0;
        if (v === prev) run++;
        else { flush(); prev = v; run = 1; }
      }
      if (prev !== 0) flush(); // a trailing empty run needs no output
      s += '$';
      seen[c] = 0;
    }
    s += '-';
  }
  return s + '\x1b\\';
}

// ---------- half blocks: one cell = two stacked pixels, truecolor ----------
// `prev` holds the last drawn colours so only changed cells are re-sent.
function blocks(img, cols, rows, top, prev) {
  const { width: w, height: h, bpp, data } = img;
  let s = '', at = -1, fg = -1, bg = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.min(w - 1, Math.floor(((c + 0.5) * w) / cols));
      const px = (yy) => {
        const y = Math.min(h - 1, Math.floor(((yy + 0.5) * h) / (rows * 2)));
        const o = (y * w + x) * bpp;
        return (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
      };
      const t = px(r * 2), b = px(r * 2 + 1), k = r * cols + c;
      if (prev[k * 2] === t && prev[k * 2 + 1] === b) continue;
      prev[k * 2] = t; prev[k * 2 + 1] = b;
      if (at !== k) s += `\x1b[${top + r};${c + 1}H`;
      if (t !== fg) { s += `\x1b[38;2;${t >> 16};${(t >> 8) & 255};${t & 255}m`; fg = t; }
      if (b !== bg) { s += `\x1b[48;2;${b >> 16};${(b >> 8) & 255};${b & 255}m`; bg = b; }
      s += '▀';
      at = k + 1;
    }
    at = -1;
  }
  return s && s + '\x1b[0m';
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
  const home = os.homedir();
  const globs = [
    [path.join(home, '.cache/puppeteer/chrome-headless-shell'), 'chrome-headless-shell'],
    [path.join(home, '.cache/ms-playwright'), 'chrome-headless-shell'],
    ['/opt/pw-browsers', 'chrome-headless-shell'],
    [path.join(home, '.cache/puppeteer/chrome'), 'chrome'],
  ];
  for (const [dir, exe] of globs) {
    const hits = [];
    const walk = (d, depth) => {
      let list = [];
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.name === exe) hits.push(p);
      }
    };
    walk(dir, 0);
    if (hits.length) return hits.sort().pop(); // newest version sorts last
  }
  for (const name of ['chrome-headless-shell', 'chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { /* next */ }
  }
  return null;
}

// What the address field turns into: a URL, or a search.
function toUrl(text) {
  const t = text.trim();
  if (/^[a-z][\w+.-]*:/i.test(t) && !/^[\w.-]+:\d/.test(t)) return t;
  if (/^(localhost|[\w-]+(\.[\w-]+)+|\[[\d:a-f]+\])(:\d+)?(\/.*)?$/i.test(t)) {
    return (/^(localhost|127\.|\[)/.test(t) ? 'http://' : 'https://') + t;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

module.exports = { decodePng, kittyImage, kittyDelete, sixel, blocks, keyInfo, parseInput, pickMode, findChrome, toUrl };
