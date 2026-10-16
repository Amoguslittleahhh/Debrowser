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
 *   row 1        the tabs, and + for a new one
 *   row 2        ← → ↻  and the address
 *   rows 3..n-1  the page in front
 *   row n        its title and the keys, or the find field
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
const HELP_KEYS = 'Ctrl+T tab · Ctrl+W close · Ctrl+L address · Ctrl+F find · Ctrl+Q quit';

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
const START_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>New tab</title>
<body style="margin:0;padding:32px 40px;background:#16171a;color:#eae7e0;font:16px/1.6 sans-serif">
<h1 style="font-size:28px;margin:0 0 12px">Debrowser, in your terminal</h1>
<p>Pages are drawn as well as a terminal can: the picture in coloured blocks, the words as words.</p>
<p><b>Ctrl+L</b> type an address or a search<br><b>Alt+←</b> back · <b>Alt+→</b> forward · <b>Ctrl+R</b> reload<br>
<b>Click</b> links and fields, or <b>Tab</b> to them · <b>scroll</b> with the wheel, the arrows or Page Up/Down</p>
<p><b>Ctrl+T</b> new tab · <b>Ctrl+W</b> close it · <b>Alt+1</b>…<b>9</b> or <b>Ctrl+Page Up/Down</b> to change tab<br>
<b>Ctrl+F</b> find on the page · <b>Ctrl+Q</b> quit</p>
<p style="color:#a5a5a5">A separate profile from the desktop browser: nothing you do here shows up there.</p></body>`)}`;

const TAB_ROW = 1;
const NAV_ROW = 2;
const PAGE_TOP = 3;

const fit = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n));

/**
 * The tab row: as many tabs as fit, the one in front always among them, and a
 * + at the end (the status row says which of how many is in front). Returns
 * the labels and where each was put, for the mouse.
 * Pure, for the test suite.
 */
function tabStrip(titles, active, cols) {
  const room = cols - 3;
  const n = titles.length;
  const width = Math.max(8, Math.min(24, Math.floor(room / n)));
  const shown = Math.max(1, Math.min(n, Math.floor(room / width)));
  const first = Math.max(0, Math.min(n - shown, active - Math.floor(shown / 2)));
  const tabs = [];
  for (let i = first; i < first + shown; i++) {
    const from = 1 + (i - first) * width;
    tabs.push({ index: i, from, to: from + width - 1, close: from + width - 2, label: ` ${fit(titles[i] || 'New tab', width - 4)} × ` });
  }
  return { tabs, plus: 1 + shown * width + 1 };
}

/** One tab: a page rendered off-screen, and what it last looked like. */
class Tab {
  constructor(browser, url) {
    this.browser = browser;
    this.image = null;
    this.texts = [];
    this.textTimer = null;
    this.win = new BrowserWindow({
      show: false,
      width: browser.cols * CELL_W,
      height: browser.pageRows * CELL_H,
      useContentSize: true,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
    });
    this.win.setContentSize(browser.cols * CELL_W, browser.pageRows * CELL_H);
    const wc = this.wc = this.win.webContents;
    wc.setFrameRate(15);
    wc.on('paint', (event, dirty, image) => {
      this.image = image;
      if (!this.front) return;
      browser.queueDraw();
      this.queueText();
    });
    wc.on('dom-ready', async () => {
      const advance = await wc.executeJavaScript(MEASURE_MONO, true).catch(() => 0);
      wc.insertCSS(monoCss(advance), { cssOrigin: 'user' }).catch(() => {});
    });
    const bars = () => { if (!this.closed) browser.drawBars(); };
    wc.on('did-start-loading', () => { this.status = 'Loading…'; bars(); });
    wc.on('did-stop-loading', () => { this.status = ''; bars(); if (this.front) this.queueText(); });
    wc.on('page-title-updated', bars);
    wc.on('did-navigate', bars);
    wc.on('did-navigate-in-page', bars);
    wc.on('did-fail-load', (e, code, desc, failed, isMain) => {
      if (isMain && code !== -3) { this.status = `Couldn’t load: ${desc}`; bars(); }
    });
    wc.on('found-in-page', (e, result) => {
      if (browser.finding && this.front) { browser.finding.result = result; browser.drawBars(); browser.drawPage(); }
    });
    // A link that would open a window opens a tab beside this one.
    wc.setWindowOpenHandler(({ url: to }) => { browser.openTab(to, browser.tabs.indexOf(this) + 1); return { action: 'deny' }; });
    wc.loadURL(url).catch(() => {});
  }

  get front() { return this.browser.current === this; }

  title() {
    const t = this.wc.getTitle();
    const url = this.wc.getURL();
    return (t && t !== url ? t : url.replace(/^https?:\/\/(www\.)?/, '')) || 'New tab';
  }

  /** The text moves with the page, so it is read again shortly after each repaint. */
  queueText() {
    clearTimeout(this.textTimer);
    this.textTimer = setTimeout(async () => {
      if (this.closed) return;
      const texts = await this.wc.executeJavaScript(COLLECT_TEXT, true).catch(() => null);
      if (!Array.isArray(texts) || this.closed) return;
      this.texts = texts.map(([x, y, ch, color]) => [x, y, ch, rgb(color)]);
      if (this.front) this.browser.drawPage();
    }, 120);
  }

  /** In front it paints; behind, it does not, and costs no drawing at all. */
  setFront(front) {
    if (front) { this.wc.startPainting(); this.wc.invalidate(); this.queueText(); } else this.wc.stopPainting();
  }

  resize() { this.win.setContentSize(this.browser.cols * CELL_W, this.browser.pageRows * CELL_H); }

  close() {
    this.closed = true;
    clearTimeout(this.textTimer);
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

class TerminalBrowser {
  constructor({ url, out = process.stdout, input = process.stdin, env = process.env }) {
    this.out = out;
    this.input = input;
    this.mode = render.colorMode(env);
    this.startUrl = addressFor(url) || START_PAGE;
    this.tabs = [];
    this.current = null;
    this.prev = null;
    this.editing = null;          // the address being typed, or null
    this.finding = null;          // { text, result } while Ctrl+F is open
    this.pending = '';
    this.drawQueued = false;
    this.hits = { tabs: [], plus: 0 };
  }

  get cols() { return Math.max(20, this.out.columns || 80); }
  get rows() { return Math.max(7, this.out.rows || 24); }
  get pageRows() { return this.rows - PAGE_TOP; }
  get wc() { return this.current && !this.current.closed ? this.current.wc : null; }

  start() {
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J');
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.input.on('data', (chunk) => this.onInput(chunk));
    this.out.on('resize', () => this.resize());
    // Files go to the Downloads folder, and the status line says so.
    session.defaultSession.on('will-download', (event, item) => {
      const file = path.join(app.getPath('downloads'), item.getFilename());
      item.setSavePath(file);
      this.notice = `Downloading ${item.getFilename()}…`;
      this.drawBars();
      item.once('done', (e, state) => {
        this.notice = state === 'completed' ? `Saved to ${file.replace(os.homedir(), '~')}` : `Download ${state}`;
        this.drawBars();
      });
    });
    this.openTab(this.startUrl);
  }

  openTab(url, at = this.tabs.length) {
    const tab = new Tab(this, url);
    this.tabs.splice(Math.min(at, this.tabs.length), 0, tab);
    this.select(tab);
    return tab;
  }

  select(tab) {
    if (!tab || tab === this.current) { this.drawBars(); return; }
    this.closeFind();
    const was = this.current;
    this.current = tab;
    if (was && !was.closed) was.setFront(false);
    tab.setFront(true);
    this.prev = null;
    this.drawPage();
    this.drawBars();
  }

  /** Close a tab; the last one is replaced by a new tab, never the quit. */
  closeTab(tab = this.current) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    if (this.tabs.length === 1) { this.openTab(START_PAGE); }
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    if (tab === this.current) this.select(this.tabs[Math.min(i, this.tabs.length - 1)]);
    tab.close();
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
    for (const tab of this.tabs) tab.resize();
    this.prev = null;
    this.out.write('\x1b[2J');
    this.drawBars();
    if (this.current) this.current.queueText();
  }

  queueDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    setTimeout(() => { this.drawQueued = false; this.drawPage(); }, 30);
  }

  drawPage() {
    const tab = this.current;
    if (!tab || !tab.image) return;
    const { width, height } = tab.image.getSize();
    if (!width || !height) return;
    const cols = this.cols;
    const rows = this.pageRows;
    const cells = render.cells(tab.image.toBitmap(), width, height, cols, rows, tab.texts);
    const match = this.finding && this.finding.result && this.finding.result.selectionArea;
    if (match && match.width) render.highlight(cells, cols, rows, match);
    this.out.write(render.encode(cells, this.prev, cols, rows, this.mode, PAGE_TOP));
    this.prev = cells;
    if (this.editing !== null || this.finding) this.placeCursor();
  }

  /** The tab row, the address row and the status row. */
  drawBars() {
    const wc = this.wc;
    if (!wc) return;
    const cols = this.cols;
    const sgr = (fg, bg) => render.sgr(fg, bg, this.mode);
    const base = [37, 37, 33];

    // Tabs.
    const strip = tabStrip(this.tabs.map((t) => t.title()), this.tabs.indexOf(this.current), cols);
    this.hits = strip;
    let row = `\x1b[${TAB_ROW};1H${sgr([200, 196, 188], [26, 26, 23])}${' '.repeat(cols)}\x1b[${TAB_ROW};1H`;
    for (const t of strip.tabs) {
      const front = t.index === this.tabs.indexOf(this.current);
      row += `\x1b[${TAB_ROW};${t.from}H${front ? sgr([255, 255, 255], [47, 133, 123]) : sgr([200, 196, 188], base)}${t.label}`;
    }
    row += `\x1b[${TAB_ROW};${strip.plus}H${sgr([234, 231, 224], [26, 26, 23])}+`;
    this.out.write(`${row}\x1b[0m`);

    // Back, forward, reload and the address.
    const nav = wc.navigationHistory;
    const button = (glyph, on) => `${sgr(on ? [234, 231, 224] : [110, 108, 104], base)}${glyph}`;
    const reload = this.mode === '16' ? 'R' : '↻';
    const head = ` ← → ${reload}  `;
    const buttons = ` ${button('←', nav.canGoBack())} ${button('→', nav.canGoForward())} ${button(reload, true)}  `;
    const url = wc.getURL().startsWith('data:') ? '' : wc.getURL();
    const shown = this.editing !== null ? this.editing : url;
    const field = fit(shown || (this.editing !== null ? '' : 'Ctrl+L to type an address or a search'), cols - head.length - 1);
    const fieldStyle = this.editing !== null
      ? sgr([255, 255, 255], [47, 133, 123])
      : sgr(shown ? [234, 231, 224] : [165, 165, 165], [26, 26, 23]);
    this.out.write(`\x1b[${NAV_ROW};1H${sgr([234, 231, 224], base)}${buttons}${fieldStyle}${field}${sgr([234, 231, 224], base)} \x1b[0m`);

    // Status, or the find field.
    let foot;
    if (this.finding) {
      const r = this.finding.result;
      const count = !this.finding.text ? '' : !r ? '…' : r.matches ? `${r.activeMatchOrdinal} of ${r.matches}` : 'No matches';
      const field = ` Find: ${fit(this.finding.text, Math.max(10, Math.min(40, cols - 50)))} `;
      foot = `${sgr([255, 255, 255], [47, 133, 123])}${field}${sgr([200, 196, 188], base)}${fit(` ${count}   Enter next · ↑ previous · Esc close`, Math.max(0, cols - field.length))}`;
    } else {
      const status = this.notice || this.current.status || this.current.title();
      const place = this.tabs.length > 1 ? `[${this.tabs.indexOf(this.current) + 1}/${this.tabs.length}] ` : '';
      foot = `${sgr([200, 196, 188], base)}${fit(`${place}${status}  ·  ${HELP_KEYS}`, cols)}`;
    }
    this.out.write(`\x1b[${this.rows};1H${foot}\x1b[0m`);
    this.placeCursor();
  }

  /** The cursor shows only where something is being typed. */
  placeCursor() {
    if (this.editing !== null) {
      this.out.write(`\x1b[${NAV_ROW};${Math.min(this.cols, 9 + this.editing.length)}H\x1b[?25h`);
    } else if (this.finding) {
      this.out.write(`\x1b[${this.rows};${Math.min(this.cols, 8 + this.finding.text.length)}H\x1b[?25h`);
    } else {
      this.out.write('\x1b[?25l');
    }
  }

  onInput(chunk) {
    const { events, rest } = parse(this.pending + chunk.toString('utf8'));
    this.pending = rest;
    for (const ev of events) this.handle(ev);
  }

  /** Keys that work everywhere: the browser's own, before a page or a field sees them. */
  browserKey(ev) {
    if (ev.type !== 'key') return false;
    const k = ev.key;
    if (ev.ctrl && (k === 'q' || k === 'c')) { this.quit(); return true; }
    if (ev.ctrl && k === 't') { this.openTab(START_PAGE); this.editing = ''; this.drawBars(); return true; }
    if (ev.ctrl && k === 'w') { this.editing = null; this.closeTab(); return true; }
    if (ev.ctrl && (k === 'PageDown' || k === 'PageUp')) { this.step(k === 'PageDown' ? 1 : -1); return true; }
    if (ev.alt && /^[1-9]$/.test(k)) {
      const n = Number(k);
      this.editing = null;
      this.select(n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1]);
      return true;
    }
    return false;
  }

  step(by) {
    const i = this.tabs.indexOf(this.current);
    this.editing = null;
    this.select(this.tabs[(i + by + this.tabs.length) % this.tabs.length]);
  }

  handle(ev) {
    const wc = this.wc;
    if (!wc) return;
    if (this.browserKey(ev)) return;
    if (this.editing !== null) { this.editAddress(ev, wc); return; }
    if (this.finding) { this.find(ev, wc); return; }
    if (ev.type === 'key') {
      this.notice = '';
      if (ev.ctrl && ev.key === 'l') { this.editing = ''; this.drawBars(); return; }
      if (ev.ctrl && ev.key === 'f') { this.finding = { text: '', result: null }; this.drawBars(); return; }
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

  /** Typing an address. */
  editAddress(ev, wc) {
    if (ev.type === 'text') this.editing += ev.text;
    else if (ev.type === 'key' && ev.key === 'Backspace') this.editing = this.editing.slice(0, -1);
    else if (ev.type === 'key' && ev.ctrl && ev.key === 'u') this.editing = '';
    else if (ev.type === 'key' && ev.key === 'Escape') this.editing = null;
    else if (ev.type === 'key' && ev.key === 'Enter') {
      const to = addressFor(this.editing);
      this.editing = null;
      if (to) wc.loadURL(to).catch(() => {});
    } else if (ev.type === 'mouse') { this.editing = null; this.mouse(ev, wc); return; }
    this.drawBars();
  }

  /** Ctrl+F: each letter searches again; Enter and the arrows step through. */
  find(ev, wc) {
    const f = this.finding;
    const search = () => {
      f.result = null;
      if (f.text) wc.findInPage(f.text); else wc.stopFindInPage('clearSelection');
    };
    if (ev.type === 'text') { f.text += ev.text; search(); }
    else if (ev.type === 'key' && ev.key === 'Backspace') { f.text = f.text.slice(0, -1); search(); }
    else if (ev.type === 'key' && (ev.key === 'Enter' || ev.key === 'Down' || ev.key === 'Up')) {
      if (f.text) wc.findInPage(f.text, { findNext: true, forward: ev.key !== 'Up' });
    } else if (ev.type === 'key' && ev.key === 'Escape') { this.closeFind(); }
    else if (ev.type === 'mouse') { this.mouse(ev, wc); return; }
    this.drawBars();
  }

  closeFind() {
    if (!this.finding) return;
    this.finding = null;
    if (this.wc) this.wc.stopFindInPage('keepSelection');
  }

  mouse(ev, wc) {
    // The tab row: a tab, its × (or a middle click), or the +.
    if (ev.row === TAB_ROW) {
      if (ev.action !== 'down') return;
      const hit = this.hits.tabs.find((t) => ev.col >= t.from && ev.col <= t.to);
      if (ev.col === this.hits.plus) { this.openTab(START_PAGE); this.editing = ''; this.drawBars(); }
      else if (hit && (ev.col === hit.close || ev.button === 'middle')) this.closeTab(this.tabs[hit.index]);
      else if (hit) { this.editing = null; this.select(this.tabs[hit.index]); }
      return;
    }
    // The address row: the three buttons, and the field.
    if (ev.row === NAV_ROW) {
      if (ev.action !== 'down') return;
      if (ev.col >= 2 && ev.col <= 3) { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return; }
      if (ev.col >= 4 && ev.col <= 5) { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return; }
      if (ev.col >= 6 && ev.col <= 7) { wc.reload(); return; }
      this.closeFind();
      this.editing = '';
      this.drawBars();
      return;
    }
    if (ev.row < PAGE_TOP || ev.row > this.rows - 1) return;
    const x = (ev.col - 1) * CELL_W + CELL_W / 2;
    const y = (ev.row - PAGE_TOP) * CELL_H + CELL_H / 2;
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

module.exports = { run, addressFor, monoCss, tabStrip, TerminalBrowser, COLLECT_TEXT };
