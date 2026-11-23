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
assert.ok(blk.includes('\x1b[3;1H') && blk.includes('▀'), 'half block drawn at row 3');
assert.strictEqual(L.blocks(img, 1, 1, 3, prev), '', 'unchanged cells are not redrawn');

// Text from a DOM snapshot lands in cells and is drawn as characters.
// Node 0 is a body; node 1 its text; node 2 a 1px clipped box (a skip link); node 3 its text.
const snap = { strings: ['Hi', 'rgb(10, 20, 30)', 'visible', '1', 'hidden', 'Skip', 'auto'], documents: [{ scrollOffsetX: 0, scrollOffsetY: 0,
  nodes: { parentIndex: [-1, 0, 0, 2] },
  layout: { nodeIndex: [0, 1, 2, 3], text: [-1, 0, -1, 5], bounds: [[0, 0, 32, 32], [0, 0, 16, 16], [0, 16, 1, 1], [0, 16, 32, 16]],
    styles: [[1, 2, 3, 2, 2, 6], [1, 2, 3, 2, 2, 6], [1, 2, 3, 4, 4, 6], [1, 2, 3, 2, 2, 6]] },
  textBoxes: { layoutIndex: [1, 3], bounds: [[0, 0, 16, 16], [0, 16, 32, 16]], start: [0, 0], length: [2, 4] } }] };
const cells = L.textCells(snap, 4, 2, 8, 16);
assert.deepStrictEqual([...cells], [[0, ['H', 0x0a141e]], [1, ['i', 0x0a141e]]]);
const withText = L.blocks(img, 2, 1, 3, new Int32Array(6).fill(-1), cells);
assert.ok(withText.includes('38;2;10;20;30m') && /H.*i/.test(withText) && !withText.includes('▀'), 'characters drawn in their colour');

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
const page = path.join(dir, 'page.html');
const fileUrl = (f) => 'file:///' + f.replace(/\\/g, '/').replace(/^\//, '');
fs.writeFileSync(page, `<body style="margin:0;background:#2050c0"><p style="color:#fff;font:16px sans-serif">Readable words here</p><script>
addEventListener('keydown', (e) => { document.title = 'k:' + e.key + ':' + e.code + ':' + e.keyCode + (e.ctrlKey ? ':ctrl' : ''); });
addEventListener('mousedown', (e) => { document.title = 'm:' + e.button + ':' + (e.clientX > 0 && e.clientY > 0); });
</script></body>`);
fs.writeFileSync(path.join(dir, 'hello.zip'), 'not really a zip');
const saveTo = path.join(dir, 'downloads');
const app = path.join(__dirname, 'debrowser-tui.js');
const args = [app, '--mode=blocks', `--downloads=${saveTo}`, fileUrl(page)];
let out = '', write, kill, exited;
if (pty) {
  const t = pty.spawn(process.execPath, args, { cols: 100, rows: 30, cwd: dir, env: process.env, name: 'xterm-256color' });
  t.onData((d) => { out += d; });
  write = (s) => t.write(s);
  kill = () => t.kill();
  exited = new Promise((r) => t.onExit((e) => r(e.exitCode)));
} else {
  const q = (a) => `'${a.replace(/'/g, `'\\''`)}'`;
  const p = spawn('script', ['-qfec', `stty cols 100 rows 30; exec ${q(process.execPath)} ${args.map(q).join(' ')}`, '/dev/null'],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  p.stdout.on('data', (d) => { out += d; });
  write = (s) => p.stdin.write(s);
  kill = () => p.kill();
  exited = new Promise((r) => p.on('exit', r));
}
// ConPTY re-draws the screen itself, so text is matched with escape sequences removed.
const plain = () => out.replace(/\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
const waitFor = async (what, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (plain().includes(what) || out.includes(what)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${JSON.stringify(what)}; last output: ${JSON.stringify(plain().slice(-400))}`);
};
const step = async (name, fn) => { const t0 = Date.now(); await fn(); console.log(`  ${name}: ok (${Date.now() - t0} ms)`); };
(async () => {
  try {
    await step('first frame', () => waitFor('▀'));
    await step('page text drawn as characters', () => waitFor('Readable'));
    await step('key a', () => { write('a'); return waitFor('k:a:KeyA:65'); });
    await step('Delete key', () => { write('\x1b[3~'); return waitFor('k:Delete:Delete:46'); });
    await step('Ctrl+B reaches the page', () => { write('\x02'); return waitFor('k:b:KeyB:66:ctrl'); });
    await step('mouse click', () => { write('\x1b[<0;20;10M\x1b[<0;20;10m'); return waitFor('m:0:true'); });
    await step('new tab', () => { write('\x14'); return waitFor(' 2 '); });
    await step('address bar', () => { write('\x0c'); write(`${fileUrl(page)}\r`); return waitFor('2 page.html'); });
    await step('download', async () => {
      write('\x0c'); write(`${fileUrl(path.join(dir, 'hello.zip'))}\r`);
      await waitFor('Saved');
      assert.strictEqual(fs.readFileSync(path.join(saveTo, 'hello.zip'), 'utf8'), 'not really a zip');
    });
    if (process.env.DEBROWSER_TEST_SITE) { // a real site, when the network allows
      const [url, text] = process.env.DEBROWSER_TEST_SITE.split(' | ');
      await step(`real site ${url}`, () => { write('\x0c'); write(`${url}\r`); return waitFor(text, 45000); });
    }
    await step('close tab, quit', async () => {
      write('\x17'); write('\x11');
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('hung'), 8000))]);
      assert.strictEqual(code, 0, `exit code ${code}`);
    });
    console.log('e2e: ok');
  } catch (e) {
    try { kill(); } catch { /* already gone */ }
    console.error(e.message); process.exitCode = 1;
  } finally {
    if (process.env.DEBROWSER_TEST_OUT) fs.writeFileSync(process.env.DEBROWSER_TEST_OUT, out);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Chromium may still hold it on Windows */ }
    setTimeout(() => process.exit(), 500).unref(); // a pty can keep the event loop alive after a failure
  }
})();
