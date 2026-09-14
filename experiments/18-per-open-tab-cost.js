'use strict';
/*
 * The asymptote, measured directly: what does the Nth simultaneously-open,
 * fully-discarded tab cost the browser process?
 *
 * Every tab here holds no renderer at all - only its Tab object and stored
 * navigation state. Whatever this curve does IS the per-open-tab term, and it
 * is the only cost that does not amortise away as tab count rises.
 */
const { app, BaseWindow } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fx = require(path.join(ROOT, 'src/main/fixture-server'));
const { TabManager } = require(path.join(ROOT, 'src/main/tabs/tab-manager'));
const { loadConfig } = require(path.join(ROOT, 'src/main/config'));
const { readProcessMemory } = require(path.join(ROOT, 'src/main/memory'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('host-resolver-rules', fx.HOST_RESOLVER_RULES);
app.commandLine.appendSwitch('disable-gpu');
const self = () => { const d = readProcessMemory(process.pid); return d ? d.pssMB : 0; };

app.whenReady().then(async () => {
  const server = await fx.start();
  const win = new BaseWindow({ width: 900, height: 700, show: false });
  const tabs = new TabManager({ cfg: loadConfig('balanced', { maxLiveTabs: 0 }) });

  await sleep(2000);
  const points = [{ tabs: 0, mb: +self().toFixed(1) }];

  // Build tabs one at a time and discard each immediately, so the count of
  // OPEN tabs rises while live renderers stay at zero.
  for (let i = 1; i <= 60; i++) {
    const t = tabs.create({ url: server.url('heavy.html', i), activate: false, realise: true });
    win.contentView.addChildView(t.view);
    await new Promise((r) => t.wc.once('did-stop-loading', r));
    t.captureNavigation();
    t.teardownView();
    if (i % 15 === 0) {
      await sleep(3000);
      points.push({ tabs: i, mb: +self().toFixed(1) });
    }
  }

  const live = tabs.all().filter((t) => t.isLive).length;
  console.log('__8A3__' + JSON.stringify({ points, openTabs: tabs.all().length, live }));
  await server.close(); app.quit();
});
