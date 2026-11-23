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

const six = L.sixel(img, 2);
assert.ok(six.startsWith('\x1bP0;1;0q"1;1;2;2') && six.endsWith('-\x1b\\'), 'sixel framing');
assert.ok(/#\d+[?-~!]/.test(six), 'sixel has pixel data');

const prev = new Int32Array(2).fill(-1);
const blk = L.blocks(img, 1, 1, 3, prev);
assert.ok(blk.includes('\x1b[3;1H') && blk.includes('▀'), 'half block drawn at row 3');
assert.strictEqual(L.blocks(img, 1, 1, 3, prev), '', 'unchanged cells are not redrawn');

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
const chrome = L.findChrome();
let hasScript = true;
try { execFileSync('script', ['--version'], { stdio: 'ignore' }); } catch { hasScript = false; }
if (!chrome || !hasScript || process.platform !== 'linux') {
  console.log(`e2e: skipped (${!chrome ? 'no Chromium' : 'needs Linux and script(1)'})`);
  process.exit(0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtui-test-'));
const page = path.join(dir, 'page.html');
fs.writeFileSync(page, `<body style="margin:0;background:#2050c0"><script>
addEventListener('keydown', (e) => { document.title = 'k:' + e.key + ':' + e.code + ':' + e.keyCode + (e.ctrlKey ? ':ctrl' : ''); });
addEventListener('mousedown', (e) => { document.title = 'm:' + e.button + ':' + (e.clientX > 0 && e.clientY > 0); });
</script></body>`);
const app = path.join(__dirname, 'debrowser-tui.js');
const p = spawn('script', ['-qfec', `stty cols 100 rows 30; exec node '${app}' --mode=blocks 'file://${page}'`, '/dev/null'],
  { stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
p.stdout.on('data', (d) => { out += d; });
const exited = new Promise((r) => p.on('exit', r));
const waitFor = async (what, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (out.includes(what)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${JSON.stringify(what)}; last output: ${JSON.stringify(out.slice(-300))}`);
};
(async () => {
  try {
    await waitFor('▀'); // a frame was drawn
    p.stdin.write('a'); await waitFor('k:a:KeyA:65');
    p.stdin.write('\x1b[3~'); await waitFor('k:Delete:Delete:46');
    p.stdin.write('\x02'); await waitFor('k:b:KeyB:66:ctrl'); // Ctrl+B is not a browser shortcut, so the page gets it
    p.stdin.write('\x1b[<0;20;10M\x1b[<0;20;10m'); await waitFor('m:0:true');
    p.stdin.write('\x14'); await waitFor(' 2 '); // Ctrl+T: a second tab
    p.stdin.write('\x0c'); p.stdin.write(`file://${page}\r`); await waitFor('2 page.html');
    p.stdin.write('\x17'); // Ctrl+W closes it
    p.stdin.write('\x11'); // Ctrl+Q quits
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('hung'), 5000))]);
    assert.strictEqual(code, 0, `exit code ${code}`);
    assert.ok(out.includes('\x1b[?1049l'), 'terminal restored');
    console.log('e2e: ok');
  } catch (e) {
    p.kill(); console.error(e.message); process.exitCode = 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
