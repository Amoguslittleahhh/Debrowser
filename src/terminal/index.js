'use strict';

/**
 * Debrowser in a terminal: `debrowser --terminal [address]`.
 *
 * For a Linux machine with no desktop - a server over SSH, the console after
 * Ctrl+Alt+F3, a terminal you would rather not leave. The same engine as the
 * desktop browser renders each page off-screen, at the size of the terminal
 * (render.js has how a picture becomes character cells), and the keyboard and
 * the mouse go to the page as if it were on a screen.
 *
 *   row 1        ← → ↻  and the address
 *   rows 2..n-1  the page
 *   row n        its title, and the keys
 *
 * Its own profile (Debrowser/Terminal in the config folder), so it runs while
 * the desktop browser is open without the two fighting over one set of files.
 * No display is needed: main.js has the process replace itself with one on
 * Chromium's headless platform before anything else starts (launch.js).
 */

const { app, BrowserWindow, session } = require('electron');
const os = require('os');
const path = require('path');
const render = require('./render');
const { parse } = require('./input');

const { CELL_W, CELL_H } = render;
const HELP_KEYS = 'Ctrl+L address · Alt+←/→ back/forward · Ctrl+R reload · Ctrl+Q quit';

/** What an address bar entry means: an address, or a search. */
function addressFor(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data):/i.test(text)) return text;
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/.*)?$/i.test(text) && !/\s/.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

/** The page's text, with where each character is: run in the page (render.js uses it). */
const COLLECT_TEXT = `(() => {
  const W = innerWidth, H = innerHeight, out = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let budget = 30000, node;
  while ((node = walker.nextNode()) && budget > 0) {
    const t = node.nodeValue;
    if (!t || !t.trim()) continue;
    const el = node.parentElement;
    if (!el) continue;
    const box = el.getBoundingClientRect();
    if (box.bottom < 0 || box.top > H || box.right < 0 || box.left > W) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    // Each line is placed by its first character and stepped a cell at a
    // time from there: characters are a cell wide, give or take a rounding,
    // and placed one by one the rounding sends some into their neighbour's cell.
    let lineTop = null, lineLeft = 0, lineCol = 0;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === ' ' || ch === '\\n' || ch === '\\t' || ch === '\\u00a0') continue;
      range.setStart(node, i); range.setEnd(node, i + 1);
      const r = range.getClientRects()[0];
      if (!r || r.width === 0 || r.bottom < 0 || r.top > H) continue;
      if (lineTop === null || Math.abs(r.top - lineTop) > 2) { lineTop = r.top; lineLeft = r.left; lineCol = Math.round(r.left / ${CELL_W}); }
      const col = lineCol + Math.round((r.left - lineLeft) / ${CELL_W});
      out.push([col * ${CELL_W} + ${CELL_W / 2}, r.top + r.height / 2, ch, cs.color]);
      budget--;
    }
  }
  // List bullets and numbers, which are no text node either.
  for (const li of document.querySelectorAll('li')) {
    const r = li.getBoundingClientRect();
    if (r.bottom < 0 || r.top > H || r.height === 0) continue;
    const cs = getComputedStyle(li);
    if (cs.display !== 'list-item' || cs.listStyleType === 'none') continue;
    const n = li.parentElement && li.parentElement.tagName === 'OL' ? String([...li.parentElement.children].indexOf(li) + 1) + '.' : '•';
    const top = r.top + Math.min(r.height, ${CELL_H}) / 2;
    for (let i = 0; i < n.length; i++) out.push([r.left - (n.length + 1 - i) * ${CELL_W} + ${CELL_W / 2}, top, n[i], cs.color]);
  }
  // What is typed into fields, which is no text node: from the left edge, a
  // character a cell, and a password as dots.
  for (const f of document.querySelectorAll('input, textarea')) {
    const r = f.getBoundingClientRect();
    if (r.bottom < 0 || r.top > H || r.width === 0) continue;
    const type = (f.type || '').toLowerCase();
    if (['hidden', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color'].includes(type)) continue;
    const cs = getComputedStyle(f);
    const value = f.value ? (type === 'password' ? '•'.repeat(f.value.length) : f.value) : (f.placeholder || '');
    for (let i = 0; i < value.length && 6 + i * ${CELL_W} < r.width; i++) {
      out.push([r.left + 6 + i * ${CELL_W} + ${CELL_W / 2}, r.top + r.height / 2, value[i], f.value ? cs.color : 'rgb(128,128,128)']);
    }
  }
  return out;
})()`;

/**
 * A character a cell: every page in a monospace font sized so that one
 * character is exactly one cell wide, and a line exactly one cell tall. In a
 * page's own font, narrow letters share cells and wide ones straddle two, and
 * the words come out with letters missing. Sized by measuring, because which
 * monospace font a system has, and how wide it is, varies.
 *
 * And the text painted invisibly - its colour, which the characters laid over
 * it are drawn in, untouched - so its pixels do not smear into the cells
 * around each line as grey specks.
 */
const MEASURE_MONO = `(() => {
  const s = document.createElement('span');
  s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:100px monospace';
  s.textContent = 'M'.repeat(20);
  (document.body || document.documentElement).appendChild(s);
  const w = s.getBoundingClientRect().width / 2000;
  s.remove();
  return w;
})()`;

const monoCss = (advance) => `*, *::before, *::after {
  font-family: monospace !important;
  font-size: ${(CELL_W / (advance || 0.6)).toFixed(3)}px !important;
  line-height: ${CELL_H}px !important;
  letter-spacing: 0 !important;
  word-spacing: 0 !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
}`;

const rgb = (css) => {
  const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(String(css));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [255, 255, 255];
};

/** The page shown with no address given: what this is, and the keys. */
const START_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>Debrowser</title>
<body style="margin:0;padding:32px 40px;background:#16171a;color:#eae7e0;font:16px/1.6 sans-serif">
<h1 style="font-size:28px;margin:0 0 12px">Debrowser, in your terminal</h1>
<p>Pages are drawn as well as a terminal can: the picture in coloured blocks, the words as words.</p>
<p><b>Ctrl+L</b> type an address or a search<br><b>Alt+←</b> back · <b>Alt+→</b> forward · <b>Ctrl+R</b> reload<br>
<b>Click</b> links and fields, or <b>Tab</b> to them · <b>scroll</b> with the wheel, the arrows or Page Up/Down<br><b>Ctrl+Q</b> quit</p>
<p style="color:#a5a5a5">A separate profile from the desktop browser: nothing you do here shows up there.</p></body>`)}`;

class TerminalBrowser {
  constructor({ url, out = process.stdout, input = process.stdin, env = process.env }) {
    this.out = out;
    this.input = input;
    this.mode = render.colorMode(env);
    this.startUrl = addressFor(url) || START_PAGE;
    this.prev = null;
    this.image = null;
    this.texts = [];
    this.editing = null;          // the address being typed, or null
    this.status = '';
    this.pending = '';
    this.drawQueued = false;
    this.textTimer = null;
  }

  get cols() { return Math.max(20, this.out.columns || 80); }
  get rows() { return Math.max(6, this.out.rows || 24); }
  get pageRows() { return this.rows - 2; }

  start() {
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J');
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.input.on('data', (chunk) => this.onInput(chunk));
    this.out.on('resize', () => this.resize());

    this.win = new BrowserWindow({
      show: false,
      width: this.cols * CELL_W,
      height: this.pageRows * CELL_H,
      useContentSize: true,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
    });
    this.win.setContentSize(this.cols * CELL_W, this.pageRows * CELL_H);
    const wc = this.win.webContents;
    wc.setFrameRate(15);
    wc.on('paint', (event, dirty, image) => {
      this.image = image;
      this.queueDraw();
      this.queueText();
    });
    wc.on('dom-ready', async () => {
      const advance = await wc.executeJavaScript(MEASURE_MONO, true).catch(() => 0);
      wc.insertCSS(monoCss(advance), { cssOrigin: 'user' }).catch(() => {});
    });
    wc.on('did-start-loading', () => { this.status = 'Loading…'; this.drawBars(); });
    wc.on('did-stop-loading', () => { this.status = ''; this.drawBars(); this.queueText(); });
    wc.on('page-title-updated', () => this.drawBars());
    wc.on('did-navigate', () => this.drawBars());
    wc.on('did-navigate-in-page', () => this.drawBars());
    wc.on('did-fail-load', (e, code, desc, url, isMain) => {
      if (isMain && code !== -3) { this.status = `Couldn’t load: ${desc}`; this.drawBars(); }
    });
    // Links that would open a window open here instead: one page at a time.
    wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    // Files go to the Downloads folder, and the status line says so.
    session.defaultSession.on('will-download', (event, item) => {
      const file = path.join(app.getPath('downloads'), item.getFilename());
      item.setSavePath(file);
      this.status = `Downloading ${item.getFilename()}…`;
      this.drawBars();
      item.once('done', (e, state) => {
        this.status = state === 'completed' ? `Saved to ${file.replace(os.homedir(), '~')}` : `Download ${state}`;
        this.drawBars();
      });
    });
    wc.loadURL(this.startUrl).catch(() => {});
    this.drawBars();
  }

  /** Put the terminal back as it was: mouse off, cursor on, the old screen. */
  restore() {
    try { if (this.input.isTTY) this.input.setRawMode(false); } catch { /* already closed */ }
    this.out.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[0m\x1b[?25h\x1b[?1049l');
  }

  quit() {
    this.restore();
    app.exit(0);
  }

  resize() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setContentSize(this.cols * CELL_W, this.pageRows * CELL_H);
    this.prev = null;
    this.out.write('\x1b[2J');
    this.drawBars();
    this.queueText();
  }

  queueDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    setTimeout(() => { this.drawQueued = false; this.drawPage(); }, 30);
  }

  /** The text moves with the page, so it is read again shortly after each repaint. */
  queueText() {
    clearTimeout(this.textTimer);
    this.textTimer = setTimeout(async () => {
      if (!this.win || this.win.isDestroyed()) return;
      const texts = await this.win.webContents.executeJavaScript(COLLECT_TEXT, true).catch(() => null);
      if (!Array.isArray(texts)) return;
      this.texts = texts.map(([x, y, ch, color]) => [x, y, ch, rgb(color)]);
      this.drawPage();
    }, 120);
  }

  drawPage() {
    if (!this.image) return;
    const { width, height } = this.image.getSize();
    if (!width || !height) return;
    const cols = this.cols;
    const rows = this.pageRows;
    const cells = render.cells(this.image.toBitmap(), width, height, cols, rows, this.texts);
    this.out.write(render.encode(cells, this.prev, cols, rows, this.mode, 2));
    this.prev = cells;
    if (this.editing !== null) this.drawBars();
  }

  /** The address row and the status row. */
  drawBars() {
    if (!this.win || this.win.isDestroyed()) return;
    const wc = this.win.webContents;
    const cols = this.cols;
    const fit = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n));
    const nav = wc.navigationHistory;

    const url = wc.getURL().startsWith('data:') ? '' : wc.getURL();
    const shown = this.editing !== null ? this.editing : url;
    // Arrows the Linux console's font has too; an unavailable one is dimmed.
    const button = (glyph, on) => `${render.sgr(on ? [234, 231, 224] : [110, 108, 104], [37, 37, 33], this.mode)}${glyph}`;
    const reload = this.mode === '16' ? 'R' : '↻';
    const head = ` ← → ${reload}  `;
    const buttons = ` ${button('←', nav && nav.canGoBack())} ${button('→', nav && nav.canGoForward())} ${button(reload, true)}  `;
    const field = fit(shown || (this.editing !== null ? '' : 'Ctrl+L to type an address or a search'), cols - head.length - 1);
    const bar = render.sgr([234, 231, 224], [37, 37, 33], this.mode);
    const fieldStyle = this.editing !== null
      ? render.sgr([255, 255, 255], [47, 133, 123], this.mode)
      : render.sgr(shown ? [234, 231, 224] : [165, 165, 165], [26, 26, 23], this.mode);
    this.out.write(`\x1b[1;1H${bar}${buttons}${fieldStyle}${field}${bar} \x1b[0m`);
    const title = this.status || wc.getTitle() || '';
    const foot = fit(`${title}${title ? '  ·  ' : ''}${HELP_KEYS}`, cols);
    this.out.write(`\x1b[${this.rows};1H${render.sgr([200, 196, 188], [37, 37, 33], this.mode)}${foot}\x1b[0m`);
    if (this.editing !== null) {
      this.out.write(`\x1b[1;${Math.min(cols, head.length + this.editing.length + 1)}H\x1b[?25h`);
    } else {
      this.out.write('\x1b[?25l');
    }
  }

  onInput(chunk) {
    const { events, rest } = parse(this.pending + chunk.toString('utf8'));
    this.pending = rest;
    for (const ev of events) this.handle(ev);
  }

  handle(ev) {
    const wc = this.win && !this.win.isDestroyed() ? this.win.webContents : null;
    if (!wc) return;
    // Typing an address.
    if (this.editing !== null) {
      if (ev.type === 'text') this.editing += ev.text;
      else if (ev.type === 'key' && ev.key === 'Backspace') this.editing = this.editing.slice(0, -1);
      else if (ev.type === 'key' && ev.ctrl && ev.key === 'u') this.editing = '';
      else if (ev.type === 'key' && ev.key === 'Escape') this.editing = null;
      else if (ev.type === 'key' && ev.key === 'Enter') {
        const to = addressFor(this.editing);
        this.editing = null;
        if (to) wc.loadURL(to).catch(() => {});
      } else if (ev.type === 'key' && ev.ctrl && (ev.key === 'q' || ev.key === 'c')) { this.quit(); return; }
      this.drawBars();
      return;
    }

    if (ev.type === 'key') {
      if (ev.ctrl && (ev.key === 'q' || ev.key === 'c')) { this.quit(); return; }
      if (ev.ctrl && ev.key === 'l') { this.editing = ''; this.drawBars(); return; }
      if (ev.ctrl && ev.key === 'r') { wc.reload(); return; }
      if (ev.alt && ev.key === 'Left') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return; }
      if (ev.alt && ev.key === 'Right') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return; }
      const modifiers = [ev.shift && 'shift', ev.alt && 'alt', ev.ctrl && 'control'].filter(Boolean);
      wc.sendInputEvent({ type: 'keyDown', keyCode: ev.key, modifiers });
      if (ev.key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode: ev.key, modifiers });
      return;
    }
    if (ev.type === 'text') {
      for (const ch of ev.text) wc.sendInputEvent({ type: 'char', keyCode: ch });
      return;
    }
    if (ev.type === 'mouse') this.mouse(ev, wc);
  }

  mouse(ev, wc) {
    // The address row: the three buttons, and the field.
    if (ev.row === 1) {
      if (ev.action !== 'down') return;
      if (ev.col >= 2 && ev.col <= 3) { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return; }
      if (ev.col >= 4 && ev.col <= 5) { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return; }
      if (ev.col >= 6 && ev.col <= 7) { wc.reload(); return; }
      this.editing = '';
      this.drawBars();
      return;
    }
    if (ev.row < 2 || ev.row > this.rows - 1) return;
    const x = (ev.col - 1) * CELL_W + CELL_W / 2;
    const y = (ev.row - 2) * CELL_H + CELL_H / 2;
    if (ev.action === 'wheel') {
      wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: ev.button === 'up' ? 3 * CELL_H : -3 * CELL_H });
      return;
    }
    const button = ev.button === 'right' ? 'right' : ev.button === 'middle' ? 'middle' : 'left';
    if (ev.action === 'down') {
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
    } else if (ev.action === 'up') {
      wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
    } else {
      wc.sendInputEvent({ type: 'mouseMove', x, y });
    }
  }
}

/** Run it. Called from main.js, before the desktop browser has started anything. */
function run(argv = process.argv) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stdout.write('debrowser --terminal needs a terminal to draw in.\n');
    app.exit(1);
    return;
  }
  const at = argv.indexOf('--terminal');
  const url = argv.slice(at + 1).find((a) => !a.startsWith('-')) || '';
  // Its own profile, beside the desktop browser's, never inside it.
  app.setPath('userData', path.join(app.getPath('appData'), 'Debrowser', 'Terminal'));
  // The user agent a page sees, without Electron's and the app's own tokens -
  // sites serve those their worst version.
  app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|debrowser|Debrowser)\/\S+/g, '');
  const browser = new TerminalBrowser({ url });
  const bail = (err) => {
    browser.restore();
    // stderr is the log file (launch.js): the stack goes there, a line here.
    if (err) {
      process.stderr.write(`${err && err.stack || err}\n`);
      process.stdout.write(`Debrowser stopped: ${err && err.message || err}\n`);
    }
    app.exit(err ? 1 : 0);
  };
  process.on('uncaughtException', bail);
  process.on('SIGTERM', () => bail());
  process.on('SIGHUP', () => bail());
  app.on('window-all-closed', () => {});
  app.whenReady().then(() => browser.start(), bail);
}

module.exports = { run, addressFor, monoCss, TerminalBrowser, COLLECT_TEXT };
