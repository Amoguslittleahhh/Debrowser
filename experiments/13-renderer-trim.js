'use strict';
/*
 * M4b: does trimming reclaim anything from a renderer holding a LARGE live JS
 * heap? M4 measured ~0 on a 36MB page; this is the case where the lever would
 * pay if it pays anywhere. Reports per-process AND system-wide, because a trim
 * that only moves pages into the compressor's accounting is not a saving.
 */
const { app, BaseWindow, WebContentsView } = require('electron');
const path = require('path'); const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const fx = require(path.join(ROOT, 'src/main/fixture-server'));
const { readProcessMemory } = require(path.join(ROOT, 'src/main/memory'));
const PROBE = process.env.PROBE;
const MB = process.env.HEAP_MB || '250';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const avail = () => Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo','utf8'))[1]) / 1024;
function zram() {
  try {
    const s = fs.readFileSync('/sys/block/zram0/mm_stat','utf8').trim().split(/\s+/).map(Number);
    return { storedMB: s[0]/1048576, physMB: s[2]/1048576 };
  } catch { return { storedMB: 0, physMB: 0 }; }
}
const snap = (pid) => {
  const d = readProcessMemory(pid);
  return { pss: +d.pssMB.toFixed(1), priv: +d.privateMB.toFixed(1),
           avail: +avail().toFixed(0), z: zram() };
};

app.commandLine.appendSwitch('host-resolver-rules', fx.HOST_RESOLVER_RULES);
app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('js-flags', '--optimize-for-size');

app.whenReady().then(async () => {
  // Refuse to produce a number if the compressor is not actually there. An
  // earlier run of this measurement was silently invalid because zram had been
  // reset between setup and execution.
  const swaps = fs.readFileSync('/proc/swaps', 'utf8');
  if (!/zram0/.test(swaps)) {
    console.log('__M4B__' + JSON.stringify({ error: 'no zram swap active', swaps }));
    return app.quit();
  }
  const server = await fx.start();
  const win = new BaseWindow({ width: 1100, height: 800, show: false });
  const v = new WebContentsView({ webPreferences: { sandbox: true } });
  win.contentView.addChildView(v);
  v.setBounds({ x: 0, y: 0, width: 1100, height: 800 });
  await v.webContents.loadURL(`http://t1.test:${server.port}/bigheap.html?mb=${MB}`);

  // Wait for the heap to actually be built.
  for (let i = 0; i < 120; i++) {
    const ready = await v.webContents.executeJavaScript('!!window.__heapReady').catch(() => false);
    if (ready) break;
    await sleep(1000);
  }
  const heapMB = await v.webContents.executeJavaScript(
    'performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1');
  const pid = v.webContents.getOSProcessId();

  // Hide + freeze, as the governor would before hibernating.
  v.setVisible(false);
  v.webContents.debugger.attach('1.3');
  await v.webContents.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' });
  v.webContents.debugger.detach();
  await sleep(6000);           // let Chromium's own background reclaim run first

  const before = snap(pid);
  const probe = execFileSync(PROBE, [String(pid), 'pageout']).toString().trim();
  await sleep(10000);
  const after = snap(pid);

  const t0 = process.hrtime.bigint();
  v.webContents.debugger.attach('1.3');
  await v.webContents.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' });
  v.webContents.debugger.detach();
  v.setVisible(true);
  await v.webContents.executeJavaScript('window.__retained.length');
  const resumeMs = +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1);

  console.log('__M4B__' + JSON.stringify({ pid, heapMB, probe, before, after, resumeMs }));
  await server.close(); app.quit();
});
