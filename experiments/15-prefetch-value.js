'use strict';
/**
 * M8: does hover-prefetch actually shorten the wait, and what does it cost?
 *
 * A/B over the same tabs: discard, then either speculate-then-activate (with a
 * dwell in between, as a real pointer would) or activate cold. What is timed is
 * activation until the page has finished loading - the window the user spends
 * looking at a placeholder.
 */
const { app, BaseWindow } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { TabManager } = require(path.join(ROOT, 'src/main/tabs/tab-manager'));
const { loadConfig } = require(path.join(ROOT, 'src/main/config'));
const fixtureServer = require(path.join(ROOT, 'src/main/fixture-server'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DWELL = Number(process.env.DWELL || 150);
const REPS = Number(process.env.REPS || 6);

app.commandLine.appendSwitch('host-resolver-rules', fixtureServer.HOST_RESOLVER_RULES);
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const fx = await fixtureServer.start();
  const win = new BaseWindow({ width: 1000, height: 700, show: false });
  const cfg = loadConfig('balanced', { maxLiveTabs: 0 });
  const tabs = new TabManager({ cfg, canSpeculate: () => true });

  const timeLoad = (tab) => new Promise((resolve) => {
    const began = process.hrtime.bigint();
    const done = () => resolve(Number(process.hrtime.bigint() - began) / 1e6);
    tab.wc.once('did-stop-loading', done);
    setTimeout(() => resolve(-1), 15000);
  });

  const results = { prefetched: [], cold: [] };
  for (let i = 0; i < REPS; i++) {
    for (const mode of ['cold', 'prefetched']) {
      const tab = tabs.create({ url: fx.url('heavy.html', i + 1), activate: false, realise: true });
      win.contentView.addChildView(tab.view);
      await new Promise((r) => tab.wc.once('did-stop-loading', r));
      await sleep(400);

      // Discard by hand: this harness has no governor.
      tab.captureNavigation();
      tab.teardownView();

      if (mode === 'prefetched') {
        tabs.speculate(tab.id);
        await sleep(DWELL);          // the pointer resting before the click
      }
      const began = process.hrtime.bigint();
      await tabs.activate(tab.id);
      if (tab.view) win.contentView.addChildView(tab.view);
      if (tab.loading) await new Promise((r) => tab.wc.once('did-stop-loading', r));
      results[mode].push(Number(process.hrtime.bigint() - began) / 1e6);
      tabs.clearSpeculation(tab);
      tabs.close(tab.id);
      await sleep(200);
    }
  }

  const stat = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return { n: s.length, p50: +s[Math.floor(s.length / 2)].toFixed(1),
             min: +s[0].toFixed(1), max: +s[s.length - 1].toFixed(1) };
  };
  console.log('__M8__' + JSON.stringify({ dwell: DWELL,
    cold: stat(results.cold), prefetched: stat(results.prefetched) }));
  await fx.close();
  app.quit();
});
