'use strict';

/**
 * Q: Forcing a GC on an idle tab reclaims a few MB. What does asking cost?
 *
 * Why it mattered: this is the experiment that overturned the design. The
 * 12-tab benchmark showed the governor using ~90MB *more* than no governor at
 * all, and the per-tab measurement in experiment 03 said the opposite - a
 * heavy page came out 6MB ahead. Both were right; the difference is the page.
 *
 * Result:
 *
 *     heavy page (~118MB)   attach +3,  collectGarbage -8   => net -6 MB
 *     idle page  (~86MB)    attach +3,  collectGarbage +6   => net +9 MB
 *
 * Instantiating the heap profiler agent costs ~6MB per renderer and does not
 * return it on detach. On a page with a large collectable heap the GC pays for
 * that; on an ordinary page it does not, and most tabs are ordinary. Across
 * twelve tabs the governor was spending ~90MB to reclaim a few.
 *
 * Combined with experiment 05 - Chromium reclaims a hidden renderer on its own,
 * and further than a forced GC does - the conclusion was that the correct
 * action on an idle tab is no action, and forced collection was removed.
 *
 * Run: for p in heavy idle; do \
 *        xvfb-run -a npx electron experiments/04-gc-instrumentation-cost.js --page=$p --no-sandbox --disable-gpu; done
 */

const { run, makeWindow, openPage, pageUrl, sleep, settledRss, delta, arg } = require('./lib');

run(`04 - cost of asking for a GC (page=${arg('page', 'heavy')})`, async () => {
  const page = arg('page', 'heavy');
  const win = makeWindow();
  const { view, wc } = await openPage(win, pageUrl(page));
  await sleep(2500);
  const pid = wc.getOSProcessId();

  view.setVisible(false);
  await sleep(1000);

  const untouched = await settledRss(pid, 10);
  console.log(`  hidden, untouched           : ${untouched} MB`);

  wc.debugger.attach('1.3');
  const attached = await settledRss(pid, 10);
  console.log(`  after debugger.attach       : ${attached} MB   (${delta(attached - untouched)})`);

  await wc.debugger.sendCommand('HeapProfiler.collectGarbage');
  const collected = await settledRss(pid, 10);
  console.log(`  after collectGarbage        : ${collected} MB   (${delta(collected - attached)})`);

  wc.debugger.detach();
  const detached = await settledRss(pid, 10);
  console.log(`  after detach                : ${detached} MB   (${delta(detached - collected)})`);

  const net = detached - untouched;
  console.log(`\n  NET vs doing nothing        : ${delta(net)} MB`);
  console.log(`  CONCLUSION: on this page, forcing a collection ` +
              `${net < 0 ? 'SAVED' : 'COST'} ${Math.abs(net)} MB.`);
  return 0;
});
