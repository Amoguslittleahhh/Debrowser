'use strict';

/**
 * Q: Which renderer operation was segfaulting tabs on activation?
 *
 * Why it mattered: tabs were dying with SIGSEGV (exitCode 11) the moment the
 * user clicked back to them. The suspects were all plausible - software
 * rasterization, page freezing, forced memory purging, runtime throttling
 * changes, the activity probe - and guessing wrong would have meant removing a
 * working feature and keeping the fatal one.
 *
 * This bisects them. Each mode adds exactly one operation to the previous.
 *
 * Result: `--mode=purge-then-ipc` is the only one that crashes. Delivering IPC
 * to a renderer whose JS memory has been forcibly purged kills it, because the
 * purge tears down the isolated world the preload lives in. Freezing, view
 * toggling, throttling changes and the probe are all innocent.
 *
 * That finding produced `Tab#sendToPage`, the single gate every message to a
 * page goes through, and ultimately the removal of forced purging entirely
 * (see experiment 04).
 *
 * Run: for m in views freeze purge-then-ipc; do \
 *        xvfb-run -a npx electron experiments/02-frozen-ipc-segfault.js --mode=$m --no-sandbox --disable-gpu; done
 */

const { run, makeWindow, openPage, pageUrl, sleep, arg, cdpSend } = require('./lib');
const { ipcMain } = require('electron');

const MODES = ['views', 'freeze', 'purge-then-ipc'];
const PAGES = ['idle', 'heavy', 'animated', 'form'];

run(`02 - what segfaults a renderer? (mode=${arg('mode', 'purge-then-ipc')})`, async () => {
  const mode = arg('mode', 'purge-then-ipc');
  if (!MODES.includes(mode)) {
    console.log(`  unknown mode "${mode}"; expected one of: ${MODES.join(', ')}`);
    return 2;
  }

  const win = makeWindow();
  const tabs = [];
  let replies = 0;
  ipcMain.on('debrowser:capture-result', () => { replies += 1; });

  for (const name of PAGES) {
    // The real probe preload is attached in every mode, so it is held constant
    // rather than being an uncontrolled difference between them.
    const tab = await openPage(win, pageUrl(name), { preload: true, show: false });
    tab.wc.debugger.attach('1.3');
    tabs.push(tab);
  }
  console.log(`  loaded ${tabs.length} tabs with the activity probe attached\n`);

  const anyCrash = () => tabs.some((tab) => tab.crashes.length);

  for (let round = 0; round < 3 && !anyCrash(); round++) {
    for (const tab of tabs) {
      if (mode === 'freeze' || mode === 'purge-then-ipc') {
        await cdpSend(tab.wc, 'Page.setWebLifecycleState', { state: 'frozen' });
      }
      if (mode === 'purge-then-ipc') {
        await cdpSend(tab.wc, 'Page.setWebLifecycleState', { state: 'active' });
        await cdpSend(tab.wc, 'Memory.forciblyPurgeJavaScriptMemory');
        // The operation under suspicion: a message to a purged renderer.
        try { tab.wc.send('debrowser:capture', round); } catch { /* frame gone */ }
      }
      if (anyCrash()) break; // the crash is the result; stop provoking more
    }

    await sleep(400);

    // Cycle visibility, which is what a user switching tabs actually does.
    for (let i = 0; i < tabs.length && !anyCrash(); i++) {
      if (mode === 'freeze') {
        await cdpSend(tabs[i].wc, 'Page.setWebLifecycleState', { state: 'active' });
      }
      tabs.forEach((tab, j) => { if (!tab.wc.isDestroyed()) tab.view.setVisible(i === j); });
      await sleep(300);
    }
  }

  await sleep(1000);
  const crashes = tabs.reduce((sum, tab) => sum + tab.crashes.length, 0);
  console.log(`\n  mode=${mode}  crashes=${crashes}  probe replies=${replies}`);
  console.log(`  CONCLUSION: ${crashes ? 'this operation KILLS renderers' : 'this operation is safe'}`);
  return 0;
});
