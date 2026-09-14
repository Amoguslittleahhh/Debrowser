'use strict';
/**
 * M5: does freezing EVERY page in a shared renderer reclaim memory, when
 * freezing one of them does not?
 *
 * The repo records that freezing costs ~5MB rather than saving any, and freezes
 * only tabs still burning background CPU as a result. Chromium's
 * MemoryPurgeManager schedules a renderer purge when *all* of that renderer's
 * pages are frozen. With process-per-site on - the default here - freezing one
 * tab of a shared renderer never satisfies that condition, so the recorded cost
 * may be the cost of freezing without ever earning the purge.
 *
 * Three same-site tabs in one renderer. Freeze none / one / all, wait, measure
 * that renderer's PSS and private bytes.
 */
const { app, BaseWindow, WebContentsView } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const fixtureServer = require(path.join(ROOT, 'src/main/fixture-server'));
const { readProcessMemory } = require(path.join(ROOT, 'src/main/memory'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CASE = process.env.CASE || 'none';     // none | one | all
const HOLD = Number(process.env.HOLD || 60000);

app.commandLine.appendSwitch('host-resolver-rules', fixtureServer.HOST_RESOLVER_RULES);
app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('js-flags', '--optimize-for-size');

app.whenReady().then(async () => {
  const fx = await fixtureServer.start();
  const win = new BaseWindow({ width: 1000, height: 700, show: false });

  // Same host for all three, so process-per-site puts them in one renderer.
  const url = (page) => `http://t1.test:${fx.port}/${page}`;
  const views = [];
  for (const page of ['heavy.html', 'heavy.html', 'heavy.html']) {
    const v = new WebContentsView({ webPreferences: { sandbox: true } });
    win.contentView.addChildView(v);
    v.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
    await v.webContents.loadURL(url(page));
    views.push(v);
  }
  await sleep(3000);

  const pids = [...new Set(views.map((v) => v.webContents.getOSProcessId()))];
  if (pids.length !== 1) {
    console.log(`__M5__${JSON.stringify({ error: `expected 1 shared renderer, got ${pids.length}`, pids })}`);
    return app.quit();
  }
  const pid = pids[0];

  // Hide them all: a visible page is never frozen, and Chromium only considers
  // purging a renderer that is backgrounded.
  for (const v of views) v.setVisible(false);
  await sleep(2000);
  const before = readProcessMemory(pid);

  const freezeCount = CASE === 'none' ? 0 : CASE === 'one' ? 1 : views.length;
  for (let i = 0; i < freezeCount; i++) {
    const wc = views[i].webContents;
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' });
    wc.debugger.detach();
  }

  // Chromium's purge is scheduled, not immediate; the repo records V8 collecting
  // a backgrounded heap within ~10s, and MemoryPurgeManager waits longer still.
  const samples = [];
  for (let t = 0; t < HOLD; t += 15000) {
    await sleep(15000);
    const now = readProcessMemory(pid);
    samples.push({ atSec: (t + 15000) / 1000, pssMB: round(now.pssMB), privateMB: round(now.privateMB) });
  }

  console.log(`__M5__${JSON.stringify({
    case: CASE, pid, frozen: freezeCount, tabs: views.length,
    before: { pssMB: round(before.pssMB), privateMB: round(before.privateMB) },
    samples
  })}`);
  await fx.close();
  app.quit();
});

const round = (n) => Math.round(n * 10) / 10;
