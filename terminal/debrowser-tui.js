#!/usr/bin/env node
'use strict';
// Debrowser for the terminal: drives a current headless Chromium over the
// DevTools protocol and draws its frames with kitty graphics, sixel or
// half blocks. Row 1 is tabs, row 2 the address bar, the last row status.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');

const HELP = `Usage: debrowser-tui [url] [--mode=kitty|sixel|blocks] [--zoom=1.25] [--fps=15] [--cell=8x16] [--profile=DIR] [--downloads=DIR]

Keys: Ctrl+L address bar, Ctrl+T new tab, Ctrl+W close tab, Alt+1..9 or
Ctrl+PgUp/PgDn switch tabs, Alt+Left/Right back/forward, F5 or Ctrl+R reload,
Alt+= / Alt+- zoom, Ctrl+Q quit. Every other key goes to the page.`;

const args = process.argv.slice(2);
const opt = (n) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
if (args.includes('--help') || args.includes('-h')) { console.log(HELP); process.exit(0); }
if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('debrowser-tui needs a terminal.'); process.exit(2); }
const startUrl = L.toUrl(args.find((a) => !a.startsWith('--')) || 'https://duckduckgo.com');
const chrome = opt('chrome') || L.findChrome();
if (!chrome) {
  console.error('No Chromium found. Install one with:\n  npx @puppeteer/browsers install chrome-headless-shell@stable\nor set DEBROWSER_CHROME to its path.');
  process.exit(2);
}

const out = process.stdout;
let mode = opt('mode'), zoom = +(opt('zoom') || 1);
let cols = out.columns, rows = out.rows, cellW = 0, cellH = 0;
const TOP = 3; // first page row

// ---------- Chromium over a pipe (no port, nothing listening) ----------
const profile = opt('profile') || fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-tui-'));
const chromeArgs = ['--headless', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required', 'about:blank'];
// Begin-frame control (render only when asked) exists only in chrome-headless-shell; a full
// Chrome or Edge renders on its own and is just screencast.
// (macOS has no begin-frame control: Chromium refuses it there.)
const frameControl = /headless[-_]shell/i.test(path.basename(chrome)) && process.platform !== 'darwin';
// The rest is Chromium's own recipe for begin-frame control. Without it, an animation that
// runs on the compositor thread (a transition started after load) can stall beginFrame for
// good and freeze the tab.
if (frameControl) chromeArgs.splice(-1, 0, '--enable-begin-frame-control', '--run-all-compositor-stages-before-draw',
  '--disable-threaded-animation', '--disable-threaded-scrolling', '--disable-checker-imaging', '--disable-new-content-rendering-timeout');
chromeArgs.push(...(process.env.DEBROWSER_CHROME_ARGS || '').split(' ').filter(Boolean));
if (process.getuid && process.getuid() === 0) chromeArgs.push('--no-sandbox'); // Chromium refuses root otherwise
let msgId = 0, inbuf = '';
const pending = new Map(), handlers = {};
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  if (process.env.DEBROWSER_TUI_LOG) fs.appendFileSync(process.env.DEBROWSER_TUI_LOG, `> ${id} ${method} ${sessionId ? sessionId.slice(0, 6) : ''} ${JSON.stringify(params).slice(0, 200)}\n`);
  proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  const p = new Promise((res, rej) => pending.set(id, { res, rej }));
  // Draw as soon as the page has handled the input, not on the next scheduled frame.
  if (method.startsWith('Input.')) p.then(wake, () => {});
  return p;
}
// Started once the terminal has said its size: kitty scales the image into its cells, so
// pages are drawn at 1920x1080 or more (sharp on HiDPI screens too) and the terminal shrinks
// them. Sixel and blocks show pixels one for one, so more would only cost CPU. Screencast
// ignores the emulated scale factor, hence the launch flag.
let proc, HI = 1;
function launch() {
  if (mode === 'kitty') HI = Math.min(4, Math.max(1, 1920 / (cols * cellW), 1080 / (pageRows() * cellH)));
  if (HI > 1) chromeArgs.push(`--force-device-scale-factor=${HI}`);
  proc = spawn(chrome, chromeArgs, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  proc.stdio[4].on('data', (d) => {
    inbuf += d.toString();
    let z;
    while ((z = inbuf.indexOf('\0')) >= 0) {
      const m = JSON.parse(inbuf.slice(0, z));
      if (process.env.DEBROWSER_TUI_LOG && !/screencastFrame|"data":"/.test(inbuf.slice(0, 200))) fs.appendFileSync(process.env.DEBROWSER_TUI_LOG, '< ' + inbuf.slice(0, Math.min(z, 300)) + '\n');
      inbuf = inbuf.slice(z + 1);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      } else if (handlers[m.method]) handlers[m.method](m.params, m.sessionId);
    }
  });
  proc.stdio[3].on('error', () => {});
  proc.on('exit', (code) => quit(`Chromium exited (${code}).`, 1));
}

// ---------- tabs ----------
const tabs = []; // {id, session, title, url, loading, crashed}
let cur = null, urlEdit = null, status = '', imgId = 1, prevCells = null;
const bySession = (s) => tabs.find((t) => t.session === s);
const pageRows = () => Math.max(1, rows - TOP); // rows TOP..rows-1; last row is status
function metrics() {
  return { width: Math.round((cols * cellW) / zoom), height: Math.round((pageRows() * cellH) / zoom),
    deviceScaleFactor: zoom, mobile: false };
}
async function applySize(t) {
  await send('Emulation.setDeviceMetricsOverride', metrics(), t.session).catch(() => {});
}
let switches = 0; // tabs picked by hand
const pick = (t) => { switches++; return activate(t); };
async function activate(t) {
  if (cur && cur !== t) send('Page.stopScreencast', {}, cur.session).catch(() => {});
  cur = t; t.drewAt = Date.now();
  stopWaiting();
  // Keys go to the focused page only: a tab opened since took the focus with it.
  send('Page.bringToFront', {}, t.session).catch(() => {});
  prevCells = null; waiting = null; textMap = null; lastPng = null;
  clearPage();
  drawUi();
  await applySize(t);
  await startCast(t);
  wake();
}
handlers['Target.targetCreated'] = async ({ targetInfo: ti }) => {
  if (ti.type !== 'page' || tabs.some((t) => t.id === ti.targetId) || startup.has(ti.targetId)) return;
  const t = { id: ti.targetId, title: ti.title, url: ti.url, loading: true }, picked = switches;
  const old = replacing; replacing = null;
  if (old && tabs.includes(old)) tabs.splice(tabs.indexOf(old), 0, t); else tabs.push(t);
  t.session = (await send('Target.attachToTarget', { targetId: ti.targetId, flatten: true })).sessionId;
  await Promise.all(['Page.enable', 'Inspector.enable'].map((m) => send(m, {}, t.session).catch(() => {})));
  send('Emulation.setFocusEmulationEnabled', { enabled: true }, t.session).catch(() => {});
  // A person is reading this page, so it says Chrome rather than HeadlessChrome (same engine, same version);
  // some sites refuse to serve "headless" visitors at all.
  if (userAgent) send('Emulation.setUserAgentOverride', { userAgent }, t.session).catch(() => {});
  if (mode === 'blocks') {
    // Characters are drawn from the layout, so pages are laid out in a monospace font one cell
    // wide per letter, and the pixel copy of the text is hidden instead of smudging the cells.
    send('Page.addScriptToEvaluateOnNewDocument', { source: TEXT_MODE }, t.session).catch(() => {});
    send('Runtime.evaluate', { expression: TEXT_MODE }, t.session).catch(() => {});
  }
  if (nextUrl && !ti.openerId && (!ti.url || ti.url === 'about:blank')) {
    const url = nextUrl; nextUrl = null;
    if (url !== 'about:blank') send('Page.navigate', { url }, t.session).catch(() => {});
  }
  // New tabs, including pages' own popups, come to the front, unless another tab was picked meanwhile.
  if (old) { await activate(t); send('Target.closeTarget', { targetId: old.id }).catch(() => {}); }
  else if (switches === picked) await activate(t); else drawUi();
};
// A constructed style sheet: no <style> element, so a page's Content Security Policy has
// nothing to refuse and stays in force for everything else.
const TEXT_MODE = `(() => {
  let sheet = window.__debrowserText;
  if (!sheet) {
    sheet = new CSSStyleSheet();
    Object.defineProperty(window, '__debrowserText', { value: sheet });
  }
  if (document.adoptedStyleSheets.includes(sheet)) return; // a page that replaced the list gets it back on load
  sheet.replaceSync('*:not(svg):not(svg *){font-family:"DejaVu Sans Mono","Cascadia Mono",Consolas,Menlo,"Liberation Mono",monospace!important;'
    + 'letter-spacing:0!important;word-spacing:0!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}'
    + '::placeholder{-webkit-text-fill-color:transparent!important}'
    + 'input[type=checkbox],input[type=radio]{opacity:0!important}'); // drawn as characters instead
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
})()`;
handlers['Target.targetDestroyed'] = ({ targetId }) => {
  const i = tabs.findIndex((t) => t.id === targetId);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  if (!tabs.length) return quit();
  if (t === cur) activate(tabs[Math.min(i, tabs.length - 1)]); else drawUi();
};
handlers['Target.targetInfoChanged'] = ({ targetInfo: ti }) => {
  const t = tabs.find((x) => x.id === ti.targetId);
  if (t) { t.title = ti.title; t.url = ti.url; drawUi(); }
};
// Chromium reports title changes made by scripts only lazily, so the front tab is asked once a second.
setInterval(() => {
  const t = cur;
  if (t) send('Target.getTargetInfo', { targetId: t.id }).then(({ targetInfo: ti }) => {
    if (ti.title !== t.title || ti.url !== t.url) { t.title = ti.title; t.url = ti.url; drawUi(); }
  }, () => {});
}, 1000).unref();
handlers['Page.frameStartedLoading'] = ({ frameId }, s) => {
  const t = bySession(s);
  if (t && frameId === t.id) { t.loading = true; t.crashed = false; drawUi(); if (t === cur) wake(); }
};
// A tab's first page can commit before the script above is registered; this catches it.
handlers['Page.domContentEventFired'] = (_, s) => {
  if (mode === 'blocks') send('Runtime.evaluate', { expression: TEXT_MODE }, s).catch(() => {});
};
handlers['Page.frameStoppedLoading'] = ({ frameId }, s) => {
  const t = bySession(s);
  if (t && frameId === t.id) { t.loading = false; drawUi(); }
};
handlers['Inspector.targetCrashed'] = (_, s) => {
  const t = bySession(s);
  if (t) { t.crashed = true; t.loading = false; drawUi(); }
};
// Alerts are shown in the status line and dismissed. Confirm, prompt and "leave this page?"
// wait for Enter (OK, a prompt's suggested answer) or Esc (Cancel): never answered for you.
let dialog = null;
handlers['Page.javascriptDialogOpening'] = ({ type, message, defaultPrompt }, s) => {
  const text = `${type === 'beforeunload' ? 'Leave this page?' : message}`.replace(/\s+/g, ' ');
  if (type === 'alert') {
    status = `alert: ${text}`;
    send('Page.handleJavaScriptDialog', { accept: true }, s).catch(() => {});
  } else {
    dialog = { session: s, promptText: defaultPrompt || '' };
    status = `${type}: ${text}   Enter = OK, Esc = Cancel`;
  }
  drawUi();
};
handlers['Page.javascriptDialogClosed'] = (_, s) => { if (dialog && dialog.session === s) { dialog = null; status = ''; drawUi(); } };
function answerDialog(accept) {
  send('Page.handleJavaScriptDialog', { accept, promptText: dialog.promptText }, dialog.session).catch(() => {});
  dialog = null; status = ''; drawUi();
}

// ---------- downloads: saved to ~/Downloads (or --downloads=DIR), progress in the status line ----------
const downloads = opt('downloads') || path.join(os.homedir(), 'Downloads');
const saving = new Map();
handlers['Browser.downloadWillBegin'] = ({ guid, suggestedFilename }) => {
  saving.set(guid, suggestedFilename);
  status = `Downloading ${suggestedFilename}…`; drawUi();
};
handlers['Browser.downloadProgress'] = ({ guid, state, receivedBytes, totalBytes, filePath }) => {
  const name = saving.get(guid) || 'file';
  if (state === 'inProgress') {
    const pct = totalBytes ? ` ${Math.floor((receivedBytes / totalBytes) * 100)}%` : ` ${(receivedBytes / 1e6).toFixed(1)} MB`;
    const next = `Downloading ${name}…${pct}`;
    if (next === status) return;
    status = next;
  } else {
    saving.delete(guid);
    status = state === 'completed' ? `Saved ${filePath || path.join(downloads, name)}` : `Download of ${name} cancelled`;
  }
  drawUi();
};

// ---------- frames ----------
// Chromium runs with begin-frame control: it renders only when asked. The front tab is
// asked up to --fps times a second while something changes and 4 times a second when
// still; background tabs are not asked at all, so their animations cost nothing.
// The screencast then hands over a picture only when one actually changed.
const fps = Math.max(1, +(opt('fps') || process.env.DEBROWSER_FPS || 15)), frameGap = 1000 / fps;
let needShot = false, rush = false, busy = false, fast = 0, loopTimer = null, ticking = false, waiting = null, stopWaiting = () => {};
// Chromium can lose a tab's frame for good (seen after chrome://crash on Linux, when the
// renderer neither dies nor draws): it then refuses every new one. After 10 seconds of that
// the tab is shown as crashed, and F5 opens it afresh.
function stuck(t) {
  if (t !== cur || t.crashed || Date.now() - (t.drewAt || 0) < 10000) return;
  t.crashed = t.stuck = true; t.loading = false; drawUi();
}
function wake() {
  fast = fps * 2;
  if (ticking) rush = true; // a frame is in flight: ask for the next one straight after
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = setTimeout(tick, 0); }
}
async function tick() {
  loopTimer = null;
  const t = cur, start = Date.now();
  if (frameControl && t && !busy && !ticking && !t.crashed) {
    ticking = true;
    try {
      // The screencast only sends pictures that changed, so a page that looks the same after a
      // resize or a tab switch would stay blank: those ask for one screenshot.
      const shot = needShot && !(needShot = false);
      // A frame asked of a tab that is then hidden never comes back: a tab switch stops the wait.
      const r = await Promise.race([send('HeadlessExperimental.beginFrame', { interval: frameGap, ...(shot && { screenshot: { format: 'png' } }) }, t.session),
        new Promise((res) => { stopWaiting = () => res({}); setTimeout(stopWaiting, 3000); })]);
      if ('hasDamage' in r) t.drewAt = Date.now();
      else stuck(t); // no answer in 3 seconds
      if (r.hasDamage) fast = fps * 2;
      if (r.screenshotData && t === cur) frame(r.screenshotData);
    } catch (err) { if (/frame is pending/.test(err.message)) stuck(t); /* else tab closing or crashed */ }
    ticking = false;
  }
  if (fast > 0) fast--;
  if (!quitting) loopTimer = setTimeout(tick, rush ? 0 : Math.max(0, (fast > 0 ? frameGap : 250) - (Date.now() - start)));
  rush = false;
}
handlers['Page.screencastFrame'] = ({ data, sessionId: frameSession }, s) => {
  send('Page.screencastFrameAck', { sessionId: frameSession }, s).catch(() => {});
  if (bySession(s) === cur) frame(data);
};
const frame = (data) => { if (busy) waiting = data; else draw(Buffer.from(data, 'base64')); };
async function startCast(t) {
  needShot = true;
  if (!frameControl) send('Page.captureScreenshot', { format: 'png' }, t.session).then((r) => { if (t === cur) frame(r.data); }, () => {});
  const m = mode === 'blocks' ? { maxWidth: cols * 4, maxHeight: pageRows() * 8 } // 2x2 per cell, each pixel averaged from 2x2
    : { maxWidth: Math.round(cols * cellW * HI), maxHeight: Math.round(pageRows() * cellH * HI) };
  await send('Page.startScreencast', { format: 'png', everyNthFrame: 1, ...m }, t.session).catch(() => {});
}
// Block mode also asks where the page's text is (at most ~6 times a second) and
// redraws with those characters, since text is unreadable at two pixels per cell.
let textMap = null, lastPng = null, textBusy = false, textAt = 0;
function readText() {
  const t = cur;
  if (textBusy || !t || Date.now() - textAt < 150) return;
  textBusy = true; textAt = Date.now();
  send('DOMSnapshot.captureSnapshot', { computedStyles: L.TEXT_STYLES }, t.session).then((snap) => {
    textBusy = false;
    if (t !== cur) return;
    textMap = L.textCells(snap, cols, pageRows(), cellW / zoom, cellH / zoom);
    if (lastPng && !busy) draw(lastPng, true);
  }, () => { textBusy = false; });
}
function draw(png, again) {
  let seq = '';
  try {
    if (mode === 'kitty') {
      const old = imgId; imgId = imgId === 1 ? 2 : 1;
      seq = `\x1b[${TOP};1H` + L.kittyImage(png, imgId, cols, pageRows()) + L.kittyDelete(old);
    } else if (mode === 'sixel') {
      seq = Buffer.concat([Buffer.from(`\x1b[${TOP};1H`), L.sixel(L.decodePng(png), Math.floor((pageRows() * cellH) / 6) * 6)]);
    } else {
      prevCells ||= new Int32Array(cols * pageRows() * 3).fill(-1);
      seq = L.blocks(L.decodePng(png), cols, pageRows(), TOP, prevCells, textMap);
      lastPng = png; if (!again) readText();
    }
  } catch (e) { status = `Frame error: ${e.message}`; }
  if (urlEdit) seq = Buffer.concat([Buffer.from(seq), Buffer.from(cursorAt())]);
  // Back-pressure: while the terminal is still drawing, only the newest frame is kept.
  busy = !out.write(seq);
  if (busy) {
    out.once('drain', () => {
      busy = false;
      if (waiting) { const d = waiting; waiting = null; draw(Buffer.from(d, 'base64')); }
    });
  }
}

// ---------- drawing the bars ----------
const clip = L.fit; // cuts by terminal cells and strips control characters a page may put in a title
let tabSpans = [], navSpans = {};
// Fixed 256-colour greys, so the bars look the same whatever the terminal's own colours are.
const BAR = '\x1b[0;48;5;236;38;5;250m', ACTIVE = '\x1b[0;1;48;5;254;38;5;16m', FIELD = '\x1b[0;48;5;239;38;5;255m',
  EDIT = '\x1b[0;48;5;255;38;5;16m', DIM = '\x1b[0;48;5;235;38;5;246m';
function drawUi() {
  if (!cols) return;
  let s = `\x1b[?25l\x1b[1;1H${BAR}`, x = 1;
  tabSpans = [];
  const w = Math.max(8, Math.min(28, Math.floor((cols - 4) / Math.max(1, tabs.length))));
  for (const [i, t] of tabs.entries()) {
    if (x + w > cols - 3) break;
    const label = clip(` ${i + 1} ${t.crashed ? '✕ ' : t.loading ? '◌ ' : ''}${t.title || t.url || 'New tab'}`, w - 1);
    s += t === cur ? `${ACTIVE}${label}${BAR}│` : `${label}│`;
    tabSpans.push([x, x + w - 1, t]);
    x += w;
  }
  navSpans.plus = x;
  s += ' + ' + ' '.repeat(Math.max(0, cols - x - 2));
  // Address bar: ← → ⟳ then the URL (or what's being typed).
  const field = urlEdit ? urlEdit.text : cur ? cur.url : '';
  navSpans.field = 9;
  s += `\x1b[2;1H${BAR} ← → ${cur && cur.loading ? '✕' : '⟳'}  ${urlEdit ? EDIT : FIELD} ${clip(field.slice(urlEdit ? urlEdit.scroll : 0), cols - 10)}`;
  const hint = cur && cur.crashed ? 'This tab crashed. Press F5 to reload it.'
    : status || '^L address  ^T tab  ^W close  Alt+←/→ back/fwd  ^Q quit';
  s += `\x1b[${rows};1H${DIM}${clip(' ' + hint, cols - 1)}\x1b[0m`;
  if (urlEdit) s += cursorAt();
  out.write(s);
}
function cursorAt() {
  return `\x1b[2;${navSpans.field + 1 + L.textWidth(urlEdit.text.slice(urlEdit.scroll, urlEdit.pos))}H\x1b[?25h`;
}
function clearPage() {
  let s = mode === 'kitty' ? '\x1b_Ga=d,d=A,q=2\x1b\\' : '';
  for (let r = TOP; r <= rows; r++) s += `\x1b[${r};1H\x1b[2K`;
  out.write(s);
}

// ---------- address bar editing ----------
function editUrl() {
  const text = cur ? cur.url.replace(/^about:blank$/, '') : '';
  urlEdit = { text, pos: text.length, scroll: 0, all: true }; // starts selected: typing replaces it
  fitScroll(); drawUi();
}
function fitScroll() {
  const w = cols - 12;
  if (urlEdit.pos < urlEdit.scroll) urlEdit.scroll = urlEdit.pos;
  while (L.textWidth(urlEdit.text.slice(urlEdit.scroll, urlEdit.pos)) > w) urlEdit.scroll = next(urlEdit.text, urlEdit.scroll);
}
// Positions step by whole characters, so an emoji (two UTF-16 units) is never cut in half.
const next = (t, i) => Math.min(t.length, i + (t.codePointAt(i) > 0xffff ? 2 : 1));
const prev = (t, i) => Math.max(0, i - (i > 1 && t.codePointAt(i - 2) > 0xffff ? 2 : 1));
function urlKey(k) {
  const e = urlEdit;
  const put = (str) => {
    if (e.all) { e.text = ''; e.pos = 0; }
    e.text = e.text.slice(0, e.pos) + str + e.text.slice(e.pos); e.pos += str.length;
  };
  if (k.type === 'paste') put(k.text.replace(/\s*\n\s*/g, ' '));
  else if (k.key === 'Enter') { urlEdit = null; if (cur && e.text.trim()) navigate(L.toUrl(e.text)); drawUi(); return; }
  else if (k.key === 'Escape') { urlEdit = null; drawUi(); return; }
  else if (k.key === 'Backspace') { if (e.all) { e.text = ''; e.pos = 0; } else if (e.pos) { const p = prev(e.text, e.pos); e.text = e.text.slice(0, p) + e.text.slice(e.pos); e.pos = p; } }
  else if (k.key === 'Delete') e.text = e.text.slice(0, e.pos) + e.text.slice(next(e.text, e.pos));
  else if (k.key === 'ArrowLeft') e.pos = prev(e.text, e.pos);
  else if (k.key === 'ArrowRight') e.pos = next(e.text, e.pos);
  else if (k.key === 'Home' || (k.ctrl && k.key === 'a')) e.pos = 0;
  else if (k.key === 'End' || (k.ctrl && k.key === 'e')) e.pos = e.text.length;
  else if (k.ctrl && k.key === 'u') { e.text = ''; e.pos = 0; }
  else if (k.text && !k.ctrl && !k.alt) put(k.text);
  e.all = false;
  fitScroll(); drawUi();
}
const navigate = (url) => cur.stuck ? (replacing = cur, newTab(url)) : send('Page.navigate', { url }, cur.session).catch((err) => { status = err.message; drawUi(); });
async function history(step) {
  const h = await send('Page.getNavigationHistory', {}, cur.session);
  const e = h.entries[h.currentIndex + step];
  if (e) await send('Page.navigateToHistoryEntry', { entryId: e.id }, cur.session);
}
const reload = () => {
  // A tab that stopped drawing is opened afresh in its place: reloading keeps the stuck frame.
  // The last page it actually showed, not the address that broke it.
  if (cur.stuck) {
    const t = cur;
    return send('Page.getNavigationHistory', {}, t.session).then((h) => h.entries[h.currentIndex].url, () => 'about:blank')
      .then((url) => { replacing = t; return newTab(url); }).catch(() => {});
  }
  cur.crashed = false; send('Page.reload', {}, cur.session).catch(() => {});
};
// A crashed tab gets a new renderer on reload, which starts with no size and no screencast.
handlers['Inspector.targetReloadedAfterCrash'] = async (_, s) => {
  const t = bySession(s);
  if (!t) return;
  t.crashed = false; drawUi();
  await applySize(t);
  if (t === cur) { prevCells = null; await startCast(t); wake(); }
};
// Tabs open blank and are navigated once set up, so block mode's text styling is in
// place before the first page loads.
let nextUrl = null, replacing = null;
// New tabs open in the background and take the focus when shown (activate), not before.
const newTab = (url = 'about:blank') => { nextUrl = url; return send('Target.createTarget', { url: 'about:blank', background: true, enableBeginFrameControl: frameControl }); };
const closeTab = () => send('Target.closeTarget', { targetId: cur.id });
const switchBy = (n) => tabs.length && pick(tabs[(tabs.indexOf(cur) + n + tabs.length) % tabs.length]);

// ---------- input ----------
const mods = (e) => (e.alt ? 1 : 0) | (e.ctrl ? 2 : 0) | (e.shift ? 8 : 0);
function pageKey(k) {
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: mods(k) };
  const lost = (e) => { status = `Key not delivered: ${e.message}`; drawUi(); };
  send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text, unmodifiedText: k.text, ...base }, cur.session).catch(lost);
  send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, cur.session).catch(lost);
}
let lastClick = { t: 0, x: 0, y: 0, n: 0 }, held = 'none';
function mouse(e) {
  if (e.y < TOP) {
    if (e.release || e.motion || e.wheel) return;
    if (e.y === 1) {
      const hit = tabSpans.find(([a, b]) => e.x >= a && e.x <= b);
      if (hit && e.button === 'middle') send('Target.closeTarget', { targetId: hit[2].id });
      else if (hit) pick(hit[2]);
      else if (e.x >= navSpans.plus && e.x <= navSpans.plus + 2) newTab();
    } else if (e.x <= 3) history(-1);
    else if (e.x <= 5) history(1);
    else if (e.x <= 7) cur.loading ? send('Page.stopLoading', {}, cur.session) : reload();
    else editUrl();
    return;
  }
  if (urlEdit) { urlEdit = null; drawUi(); }
  if (e.y >= rows) return;
  const x = ((e.x - 0.5) * cellW) / zoom, y = ((e.y - TOP + 0.5) * cellH) / zoom, modifiers = mods(e);
  if (e.wheel) {
    const d = (3 * cellH) / zoom, v = e.wheel === 'up' || e.wheel === 'left' ? -d : d;
    const horiz = e.wheel === 'left' || e.wheel === 'right' || e.shift;
    return send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: horiz ? v : 0, deltaY: horiz ? 0 : v, modifiers }, cur.session);
  }
  let type = 'mouseMoved', button = held;
  if (!e.motion && !e.release) {
    type = 'mousePressed'; button = held = e.button;
    const now = Date.now();
    lastClick.n = now - lastClick.t < 400 && lastClick.x === e.x && lastClick.y === e.y ? lastClick.n + 1 : 1;
    Object.assign(lastClick, { t: now, x: e.x, y: e.y });
  } else if (e.release) { type = 'mouseReleased'; held = 'none'; }
  send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : lastClick.n,
    buttons: held === 'left' ? 1 : held === 'right' ? 2 : held === 'middle' ? 4 : 0, modifiers }, cur.session);
}
function key(k) {
  if (k.ctrl && k.key === 'q') return quit();
  if (dialog && (k.key === 'Enter' || k.key === 'Escape')) return answerDialog(k.key === 'Enter');
  if (k.ctrl && k.key === 'l' || k.key === 'F6') return editUrl();
  if (k.ctrl && k.key === 't') return newTab();
  if (k.ctrl && k.key === 'w') return closeTab();
  if (!cur) return;
  if (urlEdit) return urlKey(k);
  if (k.alt && k.key === 'ArrowLeft') return history(-1);
  if (k.alt && k.key === 'ArrowRight') return history(1);
  if (k.key === 'F5' || (k.ctrl && k.key === 'r')) return reload();
  if (k.ctrl && (k.key === 'PageUp' || k.key === 'PageDown')) return switchBy(k.key === 'PageUp' ? -1 : 1);
  if (k.alt && /^[1-9]$/.test(k.key)) return tabs[+k.key - 1] && pick(tabs[+k.key - 1]);
  if (k.alt && (k.key === '=' || k.key === '-' || k.key === '0')) {
    zoom = k.key === '0' ? 1 : Math.max(0.25, Math.min(4, zoom * (k.key === '=' ? 1.25 : 0.8)));
    status = `Zoom ${Math.round(zoom * 100)}%`;
    return resize();
  }
  if (status) { status = ''; drawUi(); }
  pageKey(k);
}
const inputState = {};
let replyWait = null;
let escTimer = null;
process.stdin.on('data', (d) => onInput(d.toString('utf8')));
function onInput(str, final) {
  clearTimeout(escTimer);
  for (const e of L.parseInput(str, inputState, final)) {
    if (e.type === 'reply') { if (replyWait) replyWait(e.seq); continue; }
    if (!booted) continue;
    if (cur) wake();
    try {
      if (e.type === 'mouse') { if (cur) mouse(e); }
      else if (e.type === 'paste') { if (urlEdit) urlKey(e); else if (cur) send('Input.insertText', { text: e.text }, cur.session); }
      else key(e);
    } catch (err) { status = err.message; drawUi(); }
  }
  // Alt+[ or Alt+O looks like the start of a sequence: if nothing follows soon, it was the key.
  if (inputState.esc) escTimer = setTimeout(() => onInput('', true), 100);
}

// ---------- terminal setup, size and teardown ----------
async function queryTerminal() {
  const replies = [];
  await new Promise((done) => {
    const timer = setTimeout(done, 800);
    replyWait = (seq) => { replies.push(seq); if (/c$/.test(seq)) { clearTimeout(timer); done(); } };
    out.write('\x1b[16t\x1b[14t\x1b[c'); // cell size, window size, then DA1 (everyone answers DA1)
  });
  replyWait = null;
  for (const r of replies) {
    let m;
    if ((m = /^\x1b\[6;(\d+);(\d+)t/.exec(r))) { cellH = +m[1]; cellW = +m[2]; }
    else if ((m = /^\x1b\[4;(\d+);(\d+)t/.exec(r)) && !cellW) { cellH = Math.floor(m[1] / rows); cellW = Math.floor(m[2] / cols); }
  }
  const forced = /^(\d+)x(\d+)$/.exec(opt('cell') || '');
  if (forced) { cellW = +forced[1]; cellH = +forced[2]; }
  if (!cellW || !cellH) { cellW = 8; cellH = 16; } // the usual cell when the terminal won't say
  mode ||= L.pickMode(process.env, replies.find((r) => /c$/.test(r)));
  // Blocks draw one character per cell, and 16px monospace is 9.6 CSS px per letter.
  if (mode === 'blocks' && !opt('zoom')) zoom = cellW / 9.6;
  if (process.env.DEBROWSER_TUI_LOG) fs.appendFileSync(process.env.DEBROWSER_TUI_LOG, `${mode} ${cols}x${rows} cell ${cellW}x${cellH} ${JSON.stringify(replies)}\n`);
}
async function resize() {
  cols = out.columns; rows = out.rows;
  if (!cur) return;
  clearPage(); prevCells = null; textMap = null; drawUi();
  await Promise.all(tabs.map(applySize));
  await startCast(cur);
  wake();
}
let resizeTimer;
out.on('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 80); });

let quitting = false;
function quit(msg, code = 0) {
  if (quitting) return;
  quitting = true;
  out.write((mode === 'kitty' ? '\x1b_Ga=d,d=A,q=2\x1b\\' : '') + '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l');
  try { process.stdin.setRawMode(false); } catch { /* already gone */ }
  if (msg) console.error(msg);
  try { proc.kill(); } catch { /* gone */ }
  if (!opt('profile')) setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* in use */ } process.exit(code); }, 300);
  else process.exit(code);
}
process.on('SIGTERM', () => quit());
process.on('SIGHUP', () => quit());
process.on('uncaughtException', (e) => quit(`debrowser-tui: ${e.stack || e}`, 1));
process.on('unhandledRejection', () => {}); // a closed tab's late replies

let booted = false, userAgent = '';
const startup = new Set();
(async () => {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h');
  await queryTerminal();
  launch();
  // Chromium's own startup about:blank is not a tab; it is closed once the first real one exists.
  for (const t of (await send('Target.getTargets')).targetInfos) startup.add(t.targetId);
  userAgent = (await send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome');
  fs.mkdirSync(downloads, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true }).catch(() => {});
  await send('Target.setDiscoverTargets', { discover: true });
  booted = true;
  await newTab(startUrl);
  tick();
  for (const id of startup) send('Target.closeTarget', { targetId: id }).catch(() => {});
  if (process.env.DEBROWSER_TUI_DEBUG) status = `${mode} ${cols}x${rows} cell ${cellW}x${cellH}`;
})().catch((e) => quit(`debrowser-tui: ${e.message}`, 1));
