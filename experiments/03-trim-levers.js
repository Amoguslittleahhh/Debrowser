'use strict';

/**
 * Q: How much memory does each trim lever actually return?
 *
 * Why it mattered: the governor was built around forcing memory back from
 * idle tabs, and `Memory.forciblyPurgeJavaScriptMemory` is the obvious tool
 * for it - the one every "make Electron use less RAM" answer reaches for.
 * Nothing was measuring whether it worked.
 *
 * Result, on a page holding ~117MB:
 *
 *     hide (no action)               +1 MB
 *     HeapProfiler.collectGarbage    -5 MB
 *     forciblyPurgeJavaScriptMemory  -0 MB   <- reclaims nothing after the GC
 *
 * And the probe stopped reporting after the purge: it destroys the renderer's
 * isolated worlds, taking the activity probe with them. Zero benefit, and it
 * breaks the page's instrumentation - so the purge was removed outright.
 *
 * Run: xvfb-run -a npx electron experiments/03-trim-levers.js --no-sandbox --disable-gpu
 */

const { run, makeWindow, openPage, pageUrl, sleep, settledRss, delta, arg } = require('./lib');
const { ipcMain } = require('electron');

run('03 - what each trim lever reclaims', async () => {
  const page = arg('page', 'heavy');
  const win = makeWindow();
  const { view, wc } = await openPage(win, pageUrl(page), { preload: true });
  await sleep(2500);
  const pid = wc.getOSProcessId();

  let probeReports = 0;
  ipcMain.on('debrowser:probe', () => { probeReports += 1; });

  const baseline = await settledRss(pid);
  console.log(`  baseline (visible)          : ${baseline} MB`);

  view.setVisible(false);
  await sleep(1500);
  const hidden = await settledRss(pid);
  console.log(`  hidden, no action           : ${hidden} MB   (${delta(hidden - baseline)})`);

  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('HeapProfiler.collectGarbage');
  const afterGc = await settledRss(pid);
  console.log(`  after collectGarbage        : ${afterGc} MB   (${delta(afterGc - hidden)})`);

  const reportsBeforePurge = probeReports;
  await wc.debugger.sendCommand('Memory.forciblyPurgeJavaScriptMemory');
  const afterPurge = await settledRss(pid);
  console.log(`  after forcible purge        : ${afterPurge} MB   (${delta(afterPurge - afterGc)})`);

  // Does the in-page probe survive the purge? Show the tab again and see
  // whether it resumes reporting.
  view.setVisible(true);
  await sleep(2500);
  const probeSurvived = probeReports > reportsBeforePurge;

  console.log(`\n  probe reports: ${reportsBeforePurge} before purge -> ${probeReports} after re-showing`);
  console.log(`  CONCLUSION: purge reclaimed ${delta(afterGc - afterPurge)} MB beyond the GC, ` +
              `and the probe ${probeSurvived ? 'survived' : 'DIED'}.`);
  return 0;
});
