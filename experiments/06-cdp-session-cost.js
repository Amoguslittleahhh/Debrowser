'use strict';

/**
 * Q: What does keeping a debugger session open cost, does freezing need
 *    `Page.enable`, and does a page stay frozen once the debugger detaches?
 *
 * Why it mattered: the governor holds a CDP session on every tab it manages,
 * and most tabs spend most of their life frozen. If the session is expensive
 * and unnecessary, that is pure waste multiplied by the tab count. And if
 * freezing survives a detach, the session does not need to be held at all.
 *
 * Result:
 *
 *     debugger.attach              +3 MB per renderer
 *     Page.setWebLifecycleState    works WITHOUT Page.enable
 *     Page.enable                  +0 MB here, but instantiates page
 *                                  instrumentation for no benefit
 *     after detach                 page STAYS frozen (CPU ~0)
 *
 * Three changes came out of this: `Page.enable` was dropped from the freeze
 * path, the session is detached once a tab is frozen, and it is detached again
 * when a tab is promoted to active - so the one page the user is looking at
 * has nothing attached to it.
 *
 * Run: xvfb-run -a npx electron experiments/06-cdp-session-cost.js --no-sandbox --disable-gpu
 */

const { run, makeWindow, openPage, pageUrl, sleep, settledRss, cpu, delta } = require('./lib');

run('06 - cost of holding a CDP session', async () => {
  const win = makeWindow();
  // An animating page, so "still frozen?" can be answered from CPU alone.
  const { view, wc } = await openPage(win, pageUrl('animated'));
  await sleep(2000);
  const pid = wc.getOSProcessId();

  view.setVisible(false);
  await sleep(1000);

  const before = await settledRss(pid);
  console.log(`  hidden, no CDP              : ${before} MB`);

  wc.debugger.attach('1.3');
  const attached = await settledRss(pid);
  console.log(`  after debugger.attach       : ${attached} MB   (${delta(attached - before)})`);

  // Freeze without enabling the Page domain first.
  let freezeWorked = true;
  try {
    await wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' });
  } catch (err) {
    freezeWorked = false;
    console.log(`  freeze without Page.enable  : FAILED (${err.message})`);
  }
  if (freezeWorked) console.log('  freeze without Page.enable  : works');

  const frozen = await settledRss(pid);
  console.log(`  after freeze                : ${frozen} MB   (${delta(frozen - attached)})`);

  await wc.debugger.sendCommand('Page.enable');
  const enabled = await settledRss(pid);
  console.log(`  after Page.enable           : ${enabled} MB   (${delta(enabled - frozen)})`);

  wc.debugger.detach();
  const detached = await settledRss(pid);
  console.log(`  after detach                : ${detached} MB   (${delta(detached - enabled)})`);

  // If the page thawed on detach, this animating page would spin its rAF loop.
  await sleep(2000);
  const cpuAfterDetach = cpu(pid);
  const stillFrozen = cpuAfterDetach < 1.0;

  console.log(`\n  CPU after detach            : ${cpuAfterDetach.toFixed(2)}%`);
  console.log(`  CONCLUSION: session costs ${delta(enabled - before)} MB; ` +
              `freeze needs Page.enable: ${freezeWorked ? 'no' : 'yes'}; ` +
              `stays frozen after detach: ${stillFrozen ? 'yes' : 'NO'}.`);
  return 0;
});
