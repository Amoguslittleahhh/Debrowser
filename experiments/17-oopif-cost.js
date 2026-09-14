'use strict';
// What does one out-of-process iframe actually cost?
// One tab, N distinct cross-site frames, measured against the same tab with none.
const { app, BaseWindow, WebContentsView } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fx = require(path.join(ROOT, 'src/main/fixture-server'));
const { readProcessMemory, unreportedProcessesMB } = require(path.join(ROOT, 'src/main/memory'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FRAMES = Number(process.env.FRAMES || 6);

app.commandLine.appendSwitch('host-resolver-rules', fx.HOST_RESOLVER_RULES);
app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('js-flags', '--optimize-for-size');

app.whenReady().then(async () => {
  const server = await fx.start();
  const win = new BaseWindow({ width: 1100, height: 800, show: false });
  const v = new WebContentsView({ webPreferences: { sandbox: true } });
  win.contentView.addChildView(v);
  v.setBounds({ x: 0, y: 0, width: 1100, height: 800 });

  // FRAMES=0 loads a subframe-free page of the same shape.
  const page = FRAMES > 0 ? 'embeds.html' : 'idle.html';
  await v.webContents.loadURL(`http://t1.test:${server.port}/${page}`);
  await sleep(9000);

  const metrics = app.getAppMetrics();
  let total = 0; const renderers = [];
  for (const p of metrics) {
    const d = readProcessMemory(p.pid);
    const mb = d ? d.pssMB : (p.memory?.workingSetSize || 0) / 1024;
    total += mb;
    if (p.type === 'Tab') renderers.push(+mb.toFixed(1));
  }
  total += unreportedProcessesMB(new Set(metrics.map((p) => p.pid))).mb;

  console.log('__OOPIF__' + JSON.stringify({
    frames: FRAMES, totalMB: Math.round(total),
    rendererCount: renderers.length, renderers: renderers.sort((a, b) => b - a)
  }));
  await server.close(); app.quit();
});
