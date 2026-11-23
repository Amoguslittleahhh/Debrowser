'use strict';
// node terminal/test.js - unit checks, then (when Chromium and `script` exist) an
// end-to-end run in a pseudo-terminal: keys and clicks reach the page, tabs, quit.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const L = require('./lib');

// ---------- unit ----------
function png(w, h, rgba) {
  const chunk = (name, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(name), body, Buffer.alloc(4)]); // CRC is not checked
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < h; y++) {
    // Row 0 unfiltered, row 1 with the "up" filter, to exercise unfiltering.
    const row = Buffer.from(rgba.slice(y * w * 4, (y + 1) * w * 4));
    if (y) for (let i = 0; i < row.length; i++) row[i] = (row[i] - rgba[(y - 1) * w * 4 + i]) & 255;
    rows.push(Buffer.from([y ? 2 : 0]), row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const px = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];
const img = L.decodePng(png(2, 2, px));
assert.deepStrictEqual([img.width, img.height, img.bpp], [2, 2, 4]);
assert.deepStrictEqual([...img.data], px);

const six = L.sixel(img, 2).toString('latin1');
assert.ok(six.startsWith('\x1bP0;1;0q"1;1;2;2') && six.endsWith('-\x1b\\'), 'sixel framing');
assert.ok(/#\d+[?-~!]/.test(six), 'sixel has pixel data');

const prev = new Int32Array(3).fill(-1);
const blk = L.blocks(img, 1, 1, 3, prev);
assert.ok(blk.includes('\x1b[3;1H') && /[▘▝▀▖▌▞▛▗▚▐▜▄▙▟]/.test(blk), 'quarter block drawn at row 3');
assert.strictEqual(L.blocks(img, 1, 1, 3, prev), '', 'unchanged cells are not redrawn');
// Red top-left, rest white: one quadrant in red.
const one = L.decodePng(png(2, 2, [255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]));
const q1 = L.blocks(one, 1, 1, 1, new Int32Array(3).fill(-1));
assert.ok(q1.includes('▘') && q1.includes('38;2;255;0;0m') && q1.includes('48;2;255;255;255m'), 'quadrant split');

// Text from a DOM snapshot lands in cells and is drawn as characters.
// Node 0 is a body; node 1 its text; node 2 a 1px clipped box (a skip link); node 3 its text.
const snap = { strings: ['Hi', 'rgb(10, 20, 30)', 'visible', '1', 'hidden', 'Skip', 'auto'], documents: [{ scrollOffsetX: 0, scrollOffsetY: 0,
  nodes: { parentIndex: [-1, 0, 0, 2] },
  layout: { nodeIndex: [0, 1, 2, 3], text: [-1, 0, -1, 5], bounds: [[0, 0, 32, 32], [0, 0, 16, 16], [0, 16, 1, 1], [0, 16, 32, 16]],
    styles: [[1, 2, 3, 2, 2, 6], [1, 2, 3, 2, 2, 6], [1, 2, 3, 4, 4, 6], [1, 2, 3, 2, 2, 6]] },
  textBoxes: { layoutIndex: [1, 3], bounds: [[0, 0, 16, 16], [0, 16, 32, 16]], start: [0, 0], length: [2, 4] } }] };
const cells = L.textCells(snap, 4, 2, 8, 16);
assert.deepStrictEqual([...cells], [[0, ['H', 0x0a141e]], [1, ['i', 0x0a141e]]]);
// node 2 as a checked checkbox, node 3 as an off switch: one state glyph each, at their centres
const form = JSON.parse(JSON.stringify(snap));
form.strings.push('INPUT', 'type', 'checkbox', 'DIV', 'role', 'switch', 'aria-checked', 'false');
Object.assign(form.documents[0].nodes, { nodeName: [10, 10, 7, 10], attributes: [[], [], [8, 9], [11, 12, 13, 14]], inputChecked: { index: [2] } });
form.documents[0].layout.bounds[2] = [0, 16, 8, 16];
form.documents[0].layout.styles[2] = [1, 2, 3, 2, 2, 6];
form.documents[0].layout.text[3] = -1;
form.documents[0].textBoxes = { layoutIndex: [], bounds: [], start: [], length: [] };
assert.deepStrictEqual([...L.textCells(form, 4, 2, 8, 16)], [[4, ['☒', 0x0a141e]], [6, ['☐', 0x0a141e]]]);
const withText = L.blocks(img, 2, 1, 3, new Int32Array(6).fill(-1), cells);
assert.ok(withText.includes('38;2;10;20;30m') && /H.*i/.test(withText) && !/[▘▝▀▖▌▞▛▗▚▐▜▄▙▟]/.test(withText), 'characters drawn in their colour');

const k = L.kittyImage(Buffer.alloc(5000), 7, 80, 20);
assert.ok(k.startsWith('\x1b_Ga=T,f=100,i=7,q=2,C=1,c=80,r=20,m=1;') && k.includes('\x1b_Gm=0;'), 'kitty chunks');

const ev = (s) => L.parseInput(s).map((e) => (e.type === 'key' ? `${e.ctrl ? 'C-' : ''}${e.alt ? 'A-' : ''}${e.shift ? 'S-' : ''}${e.key}/${e.code}/${e.keyCode}` : e.type));
assert.deepStrictEqual(ev('aZ'), ['a/KeyA/65', 'S-Z/KeyZ/90']);
assert.deepStrictEqual(ev('\x01\x7f\r\t'), ['C-a/KeyA/65', 'Backspace/Backspace/8', 'Enter/Enter/13', 'Tab/Tab/9']);
assert.deepStrictEqual(ev('\x1b[A\x1b[1;5D\x1b[3~\x1b[15~\x1bOP'), ['ArrowUp/ArrowUp/38', 'C-ArrowLeft/ArrowLeft/37', 'Delete/Delete/46', 'F5/F5/116', 'F1/F1/112']);
assert.deepStrictEqual(ev('\x1bx\x1b'), ['A-x/KeyX/88', 'Escape/Escape/27']);
assert.deepStrictEqual(ev('!é'), ['S-!/Digit1/49', 'é/Unidentified/0']);
const [m] = L.parseInput('\x1b[<0;12;7M');
assert.deepStrictEqual([m.type, m.button, m.x, m.y, m.release], ['mouse', 'left', 12, 7, false]);
assert.strictEqual(L.parseInput('\x1b[<65;1;1M')[0].wheel, 'down');
const st = {};
assert.deepStrictEqual(L.parseInput('\x1b[200~hel', st), []);
assert.deepStrictEqual(L.parseInput('lo\x1b[201~', st), [{ type: 'paste', text: 'hello' }]);
assert.strictEqual(L.parseInput('\x1b[6;16;8t')[0].type, 'reply');

assert.strictEqual(L.toUrl('example.com'), 'https://example.com');
assert.strictEqual(L.toUrl('localhost:3000/x'), 'http://localhost:3000/x');
assert.strictEqual(L.toUrl('file:///tmp/a.html'), 'file:///tmp/a.html');
assert.strictEqual(L.toUrl('how terminals work'), 'https://duckduckgo.com/?q=how%20terminals%20work');

assert.strictEqual(L.pickMode({ TERM_PROGRAM: 'WezTerm' }), 'kitty');
assert.strictEqual(L.pickMode({}, '\x1b[?61;4;6;22c'), 'sixel');
assert.strictEqual(L.pickMode({}, '\x1b[?62;c'), 'blocks');
assert.strictEqual(L.pickMode({ TMUX: '1', KITTY_WINDOW_ID: '1' }), 'blocks');
console.log('unit: ok');

// ---------- end to end ----------
// A real pseudo-terminal: node-pty (ConPTY on Windows) when it is installed, else script(1).
const chrome = L.findChrome();
let pty = null;
try { pty = require('node-pty'); } catch { /* optional */ }
let hasScript = process.platform === 'linux';
try { if (hasScript) execFileSync('script', ['--version'], { stdio: 'ignore' }); } catch { hasScript = false; }
if (!chrome || (!pty && !hasScript)) {
  console.log(`e2e: skipped (${!chrome ? 'no Chromium' : 'needs node-pty, or script(1) on Linux'})`);
  process.exit(0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtui-test-'));
const page = path.join(dir, 'page.html'), page2 = path.join(dir, 'second.html');
const fileUrl = (f) => 'file:///' + f.replace(/\\/g, '/').replace(/^\//, '');
fs.writeFileSync(page, `<body style="margin:0;background:#2050c0"><p style="color:#fff;font:16px sans-serif">Readable words here</p>
<textarea autofocus style="width:200px;height:40px"></textarea><script>
const say = (t) => { document.title = t; };
addEventListener('keydown', (e) => {
  say('k:' + e.key + ':' + e.code + ':' + e.keyCode + (e.ctrlKey ? ':ctrl' : ''));
  if (e.key === 'c') setTimeout(() => say('c:' + confirm('Sure?')));
  if (e.key === 'x') say('T\\x1b]52;c;cHduZWQ=\\x07\\x1b[31mRED');
  if (e.key === 'w') window.open(location.href.replace('page.html', 'second.html'));
});
addEventListener('mousedown', (e) => say('m:' + e.button + ':' + (e.clientX > 0 && e.clientY > 0)));
addEventListener('wheel', (e) => say('w:' + (e.deltaY > 0)));
addEventListener('beforeinput', (e) => { if (e.data && e.data.length > 1) say('p:' + e.data); });
</script></body>`);
fs.writeFileSync(page2, '<body style="background:#c02050"><script>sessionStorage.n = (+sessionStorage.n || 0) + 1; document.title = "Second " + sessionStorage.n;'
  + 'addEventListener("keydown", (e) => { document.title = "k:" + e.key; });</script></body>');
fs.writeFileSync(path.join(dir, 'hello.zip'), 'not really a zip');
const saveTo = path.join(dir, 'downloads');
const app = path.join(__dirname, 'debrowser-tui.js');

function launch(mode) {
  const args = [app, `--mode=${mode}`, `--downloads=${saveTo}`, '--cell=8x16', fileUrl(page)];
  const r = { out: '' };
  if (process.env.DEBROWSER_TEST_OUT) process.env.DEBROWSER_TUI_LOG = `${process.env.DEBROWSER_TEST_OUT}.${mode}.cdp.txt`; // what was said to Chromium, for a failed run
  if (pty) {
    const t = pty.spawn(process.execPath, args, { cols: 100, rows: 30, cwd: dir, env: process.env, name: 'xterm-256color' });
    t.onData((d) => { r.out += d; });
    r.write = (s) => t.write(s); r.kill = () => t.kill(); r.resize = (c, h) => t.resize(c, h);
    r.exited = new Promise((res) => t.onExit((e) => res(e.exitCode)));
  } else {
    const q = (a) => `'${a.replace(/'/g, `'\\''`)}'`;
    const p = spawn('script', ['-qfec', `stty cols 100 rows 30; exec ${q(process.execPath)} ${args.map(q).join(' ')}`, '/dev/null'],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    p.stdout.on('data', (d) => { r.out += d; });
    r.write = (s) => p.stdin.write(s); r.kill = () => p.kill();
    r.exited = new Promise((res) => p.on('exit', res));
  }
  // Each step looks only at what was drawn since it started. ConPTY re-draws the screen
  // itself, so text is matched with escape sequences removed too.
  r.mark = 0;
  r.since = () => r.out.slice(r.mark);
  r.plain = () => r.since().replace(/\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
  r.waitFor = async (what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (r.plain().includes(what) || r.since().includes(what)) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`timed out waiting for ${JSON.stringify(what)}; last output: ${JSON.stringify(r.plain().slice(-400))}`);
  };
  // Sends again once if nothing happened: a key or reload right after a navigation or tab
  // switch is occasionally lost (an open issue, see REPORT), and one loss must not hide the rest.
  r.retry = async (send, what) => { send(); try { await r.waitFor(what, 6000); } catch { console.log(`    (no answer to the first try for ${JSON.stringify(what)}: sent again)`); r.lost = (r.lost || 0) + 1; send(); await r.waitFor(what); } };
  r.step = async (name, fn) => { const t0 = Date.now(); r.mark = r.out.length; await fn(); console.log(`  ${mode}: ${name}: ok (${Date.now() - t0} ms)`); };
  r.quit = async () => {
    r.write('\x11');
    const code = await Promise.race([r.exited, new Promise((res) => setTimeout(() => res('hung'), 8000))]);
    assert.strictEqual(code, 0, `exit code ${code}`);
    assert.ok(r.out.endsWith('\x1b[?25h\x1b[?1049l') || r.out.includes('\x1b[?1049l'), 'terminal restored');
  };
  return r;
}

async function full(r) {
  const { write, waitFor, step } = r;
  await step('first frame', () => waitFor('48;2;32;80;192m')); // the page's blue
  await step('page text drawn as characters', () => { r.mark = 0; return waitFor('Readable'); });
  await step('key a', () => { write('a'); return waitFor('k:a:KeyA:65'); });
  await step('paste', () => { write('\x1b[200~pasted text\x1b[201~'); return waitFor('p:pasted text'); });
  await step('Delete key', () => { write('\x1b[3~'); return waitFor('k:Delete:Delete:46'); });
  await step('Ctrl+B reaches the page', () => { write('\x02'); return waitFor('k:b:KeyB:66:ctrl'); });
  await step('key sequence split across reads', async () => { write('\x1b['); await new Promise((res) => setTimeout(res, 30)); write('D'); await waitFor('k:ArrowLeft:ArrowLeft:37'); });
  await step('mouse click', () => { write('\x1b[<0;20;10M\x1b[<0;20;10m'); return waitFor('m:0:true'); });
  await step('mouse wheel', () => { write('\x1b[<65;20;10M'); return waitFor('w:true'); });
  await step('confirm dialog: Enter is OK', async () => { write('c'); await waitFor('confirm: Sure?'); write('\r'); await waitFor('c:true'); });
  await step('confirm dialog: Esc is Cancel', async () => { write('c'); await waitFor('confirm: Sure?'); write('\x1b'); await waitFor('c:false'); });
  await step('escape codes in a title never reach the terminal', async () => {
    write('x'); await waitFor('RED');
    assert.ok(!r.out.includes('\x1b]52;c;cHduZWQ='), 'OSC 52 from the page title was written to the terminal');
    assert.ok(!r.since().includes('\x1b[31mRED'), 'colour code from the page title was written');
  });
  await step('popup opens as a tab, Ctrl+W closes it', async () => { write('w'); await waitFor('2 Second'); write('\x17'); await waitFor('1 k:'); });
  await step('address bar', () => { write('\x0c'); write(`${fileUrl(page2)}\r`); return waitFor('1 Second 1'); }); // loaded (no ◌)
  await step('reload (F5)', () => r.retry(() => write('\x1b[15~'), 'Second 2'));
  await step('back (Alt+Left)', () => { write('\x1b[1;3D'); return waitFor('page.html'); });
  await step('forward (Alt+Right)', () => { write('\x1b[1;3C'); return waitFor('Second'); });
  await step('zoom (Alt+=)', () => { write('\x1b='); return waitFor('Zoom '); });
  await step('new tab, switch with Alt+1 and Ctrl+PgDn', async () => {
    write('\x14'); await waitFor(' 2 ');
    r.mark = r.out.length; write('\x1b1'); await r.retry(() => write('a'), '1 k:a');
    r.mark = r.out.length; write('\x1b[6;5~'); await new Promise((res) => setTimeout(res, 300));
  });
  await step('crashed tab shows it, F5 brings it back', async () => {
    write('\x0c'); write('chrome://crash\r');
    // Some Chromium builds ignore chrome://crash; then there is nothing to recover from.
    try { await waitFor('This tab crashed', 8000); } catch { console.log('    (this Chromium ignores chrome://crash: skipped)'); write('\x1b[15~'); return; }
    r.mark = r.out.length; write('\x1b[15~'); await waitFor('48;2;', 30000);
  });
  await step('download', async () => {
    write('\x0c'); write(`${fileUrl(path.join(dir, 'hello.zip'))}\r`);
    await waitFor('Saved');
    assert.strictEqual(fs.readFileSync(path.join(saveTo, 'hello.zip'), 'utf8'), 'not really a zip');
  });
  if (r.resize) await step('terminal resize', () => { r.resize(80, 24); return waitFor('48;2;'); });
  if (process.env.DEBROWSER_TEST_SITE) { // a real site, when the network allows
    const [url, text] = process.env.DEBROWSER_TEST_SITE.split(' | ');
    await step(`real site ${url}`, () => { write('\x0c'); write(`${url}\r`); return waitFor(text, 45000); });
  }
  await step('close tab, quit, terminal restored', () => { write('\x17'); return r.quit(); });
}
// The picture modes: a frame in that protocol, keys, quit.
async function pictures(r, mode) {
  await r.step('first frame', () => r.waitFor(mode === 'kitty' ? '\x1b_Ga=T,f=100' : '\x1bP0;1;0q'));
  await r.step('key a', () => { r.write('a'); return r.waitFor('k:a:KeyA:65'); });
  await r.step('quit, terminal restored', () => r.quit());
}

let current = null;
(async () => {
  try {
    for (const mode of ['blocks', 'kitty', 'sixel']) {
      // ConPTY keeps graphics sequences to itself instead of passing them to the test's end of
      // the terminal, so on Windows the picture modes can only be checked by eye.
      if (mode !== 'blocks' && process.platform === 'win32') { console.log(`  ${mode}: skipped (ConPTY)`); continue; }
      current = launch(mode);
      await (mode === 'blocks' ? full(current) : pictures(current, mode));
    }
    console.log('e2e: ok');
  } catch (e) {
    try { current.kill(); } catch { /* already gone */ }
    console.error(e.stack || e.message); process.exitCode = 1;
  } finally {
    if (process.env.DEBROWSER_TEST_OUT && current) fs.writeFileSync(process.env.DEBROWSER_TEST_OUT, current.out);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Chromium may still hold it on Windows */ }
    setTimeout(() => process.exit(), 500).unref(); // a pty can keep the event loop alive after a failure
  }
})();
