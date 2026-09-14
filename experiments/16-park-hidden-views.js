'use strict';
/*
 * Lever 4: does detaching a hidden tab's view from the window release anything?
 *
 * Chromium already drops compositor tiles when a widget is hidden, which
 * setVisible(false) does. If anything is left it is a browser- or GPU-side
 * surface per attached child view, so the figure to watch is breakdown.GPU and
 * breakdown.Browser, not the renderers.
 */
const { app, BaseWindow, WebContentsView } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fx = require(path.join(ROOT, 'src/main/fixture-server'));
const { footprintMB, unreportedProcessesMB } = require(path.join(ROOT, 'src/main/memory'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TABS = Number(process.env.TABS || 8);

app.commandLine.appendSwitch('host-resolver-rules', fx.HOST_RESOLVER_RULES);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('js-flags', '--optimize-for-size');

function measure() {
  const metrics = app.getAppMetrics();
  const by = {};
  let total = 0;
  for (const p of metrics) {
    const mb = footprintMB(p.pid, (p.memory?.workingSetSize || 0) / 1024);
    by[p.type || 'unknown'] = (by[p.type || 'unknown'] || 0) + mb;
    total += mb;
  }
  total += unreportedProcessesMB(new Set(metrics.map((p) => p.pid))).mb;
  for (const k of Object.keys(by)) by[k] = Math.round(by[k]);
  return { total: Math.round(total), by };
}
const settle = async () => { for (let i = 0; i < 12; i++) await sleep(250); return measure(); };

app.whenReady().then(async () => {
  const server = await fx.start();
  const win = new BaseWindow({ width: 1200, height: 800, show: true });
  const views = [];
  for (let i = 0; i < TABS; i++) {
    const v = new WebContentsView({ webPreferences: { sandbox: true } });
    win.contentView.addChildView(v, 0);
    v.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    await v.webContents.loadURL(server.url('heavy.html', i + 1));
    views.push(v);
  }
  await sleep(3000);
  // One visible, the rest hidden - the normal steady state.
  views.forEach((v, i) => v.setVisible(i === 0));
  await sleep(4000);
  const attached = await settle();

  // Now park every hidden view: remove it from the window entirely.
  for (let i = 1; i < views.length; i++) win.contentView.removeChildView(views[i]);
  await sleep(4000);
  const parked = await settle();

  // And put them back, to check re-attach does not leak.
  for (let i = 1; i < views.length; i++) {
    win.contentView.addChildView(views[i], 0);
    views[i].setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    views[i].setVisible(false);
  }
  await sleep(3000);
  const reattached = await settle();

  console.log('__L4__' + JSON.stringify({ tabs: TABS, attached, parked, reattached }));
  await server.close(); app.quit();
});
