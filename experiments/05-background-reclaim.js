'use strict';

/**
 * Q: What does Chromium do with a hidden tab's memory if we leave it alone -
 *    and does freezing help or hurt?
 *
 * Why it mattered: the governor froze every tab that had been idle long
 * enough, on the assumption that freezing is strictly good. It is not. A
 * frozen page cannot run tasks, and some of the tasks it cannot run are the
 * ones that hand memory back.
 *
 * Result, one hidden heavy tab watched for 60 seconds:
 *
 *     left alone   117 MB -> 107 MB    Chromium reclaims on its own, and keeps going
 *     GC'd         118 MB -> 112 MB    fast initial drop, then flat forever
 *     frozen       118 MB -> 112 MB    flat; background reclamation stopped
 *
 * So freezing is a CPU optimisation with a real memory *cost*, and our forced
 * collection is beaten by simply waiting. The governor now freezes only tabs
 * that are still burning CPU while hidden - where trading a few MB for real
 * CPU going to zero is worth it - and leaves quiet tabs entirely alone.
 *
 * Run: for m in none gc frozen; do \
 *        xvfb-run -a npx electron experiments/05-background-reclaim.js --mode=$m --no-sandbox --disable-gpu; done
 */

const { run, makeWindow, openPage, pageUrl, sleep, rss, arg, delta } = require('./lib');

const MODES = ['none', 'gc', 'frozen'];

run(`05 - background reclamation over time (mode=${arg('mode', 'none')})`, async () => {
  const mode = arg('mode', 'none');
  if (!MODES.includes(mode)) {
    console.log(`  unknown mode "${mode}"; expected one of: ${MODES.join(', ')}`);
    return 2;
  }

  const win = makeWindow();
  const { view, wc } = await openPage(win, pageUrl('heavy'));
  await sleep(2500);
  const pid = wc.getOSProcessId();

  view.setVisible(false);
  const start = rss(pid);
  console.log(`  hidden at                   : ${start} MB\n`);

  if (mode === 'gc' || mode === 'frozen') {
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('HeapProfiler.collectGarbage');
  }
  if (mode === 'frozen') {
    await wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' });
    // Detach so the debugger session itself cannot be blamed for the result.
    wc.debugger.detach();
  } else if (mode === 'gc') {
    wc.debugger.detach();
  }

  let last = start;
  for (let t = 10; t <= 60; t += 10) {
    await sleep(10_000);
    last = rss(pid);
    console.log(`    t=${String(t).padStart(2)}s               : ${last} MB`);
  }

  console.log(`\n  CONCLUSION: over 60s this tab moved ${delta(last - start)} MB (mode=${mode}).`);
  return 0;
});
