// Diagnostic: start the browser with the tabs tucked away down the side and
// report what the chrome's own views have drawn. Used by band-probe.yml on
// Windows, where the band across the top was reported empty.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const variants = {
  plain: {},
  mica: { backgroundMaterial: 'mica' },
  acrylic: { backgroundMaterial: 'acrylic', windowOpacity: 0.85 },
  pinned: { sidebarPinned: true },
  top: { tabBarPosition: 'top' }
};
const base = { design: 'calm', theme: 'dark', tabBarPosition: 'left', sidebarPinned: false, welcomeDone: true };
const electron = path.resolve('node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const out = path.resolve('band-probe');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(target, method, params = {}) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ id: 1, method, params }));
  const res = await Promise.race([
    new Promise((r) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d); }; }),
    sleep(4000).then(() => ({ timedOut: method }))
  ]);
  ws.close();
  return res;
}

const EXPR = `JSON.stringify({ ds: { ...document.body.dataset },
  body: getComputedStyle(document.body).backgroundColor,
  toolbar: (() => { const t = document.querySelector('.toolbar'); const s = getComputedStyle(t);
    return { vis: s.visibility, op: s.opacity, disp: s.display, bg: s.backgroundColor, rect: t.getBoundingClientRect(), pad: [s.paddingLeft, s.paddingRight] }; })(),
  url: (() => { const u = document.getElementById('url'); return u && u.getBoundingClientRect(); })(),
  size: [innerWidth, innerHeight], dpr: devicePixelRatio,
  errors: window.__probeErrors || [] })`;

for (const [name, extra] of Object.entries(variants)) {
  const profile = path.join(os.tmpdir(), `band-probe-${name}`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ ...base, ...extra }));
  const child = spawn(electron, ['.', '--remote-debugging-port=9333', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], {
    env: { ...process.env, DEBROWSER_TEST_PROFILE: profile }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  await sleep(15000);
  console.log(`===== ${name}`);
  try {
    const list = await (await fetch('http://127.0.0.1:9333/json')).json();
    for (const t of list.filter((x) => /chrome\.html/.test(x.url))) {
      const r = await cdp(t, 'Runtime.evaluate', { expression: EXPR, returnByValue: true });
      console.log(t.url.replace(/.*renderer\//, ''), r.result?.result?.value || JSON.stringify(r));
      const shot = await cdp(t, 'Page.captureScreenshot', { format: 'png' });
      if (shot.result) writeFileSync(path.join(out, `${name}-${t.url.includes('strip') ? 'strip' : 'chrome'}.png`), Buffer.from(shot.result.data, 'base64'));
    }
  } catch (err) {
    console.log('probe failed', err.message);
  }
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('${path.join(out, name + '-screen.png').replace(/\\/g, '\\\\')}')`;
    await new Promise((r) => spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' }).on('exit', r));
  }
  child.kill();
  await sleep(3000);
  console.log(log.split('\n').filter((l) => /error|exception|gone|crash/i.test(l)).slice(0, 20).join('\n'));
}
process.exit(0);
