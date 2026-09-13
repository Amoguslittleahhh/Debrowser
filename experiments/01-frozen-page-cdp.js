'use strict';

/**
 * Q: Can a frozen page still answer DevTools protocol commands, and can it be
 *    unfrozen again?
 *
 * Why it mattered: the whole FROZEN tier depends on the answer. If a frozen
 * renderer cannot service CDP, then freezing is a one-way door and the tier is
 * unusable - and at the time this was written, tab activation was hanging
 * exactly where it awaited an unfreeze, so a deadlock looked likely.
 *
 * Result: a frozen page answers CDP normally, including `Runtime.evaluate`,
 * and unfreezes cleanly. The hang was our own bug, not a protocol limitation -
 * which is what sent the investigation towards experiment 04.
 *
 * Run: xvfb-run -a npx electron experiments/01-frozen-page-cdp.js --no-sandbox --disable-gpu
 */

const { run, makeWindow, openPage, pageUrl, sleep } = require('./lib');

/** Never let a wedged renderer hang the experiment itself. */
const withTimeout = (promise, ms, label) => Promise.race([
  promise.then((value) => ({ ok: true, value })),
  new Promise((r) => setTimeout(() => r({ ok: false, timedOut: true, label }), ms))
]);

run('01 - does a frozen page answer CDP?', async () => {
  const win = makeWindow();
  const { wc } = await openPage(win, pageUrl('animated'));
  wc.debugger.attach('1.3');

  let result = await withTimeout(
    wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' }), 3000, 'freeze');
  console.log(`  freeze                    : ${result.ok ? 'ok' : 'TIMED OUT'}`);

  await sleep(1500);

  result = await withTimeout(
    wc.debugger.sendCommand('Runtime.evaluate', { expression: '1 + 1' }), 3000, 'evaluate');
  console.log(`  Runtime.evaluate (frozen) : ${result.ok ? `ok, returned ${result.value.result.value}` : 'TIMED OUT'}`);
  const answeredWhileFrozen = result.ok;

  result = await withTimeout(
    wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' }), 3000, 'unfreeze');
  console.log(`  unfreeze                  : ${result.ok ? 'ok' : 'TIMED OUT'}`);
  const unfroze = result.ok;

  result = await withTimeout(
    wc.debugger.sendCommand('Runtime.evaluate', { expression: '2 + 2' }), 3000, 'evaluate2');
  console.log(`  Runtime.evaluate (thawed) : ${result.ok ? `ok, returned ${result.value.result.value}` : 'TIMED OUT'}`);

  console.log(`\n  CONCLUSION: a frozen renderer ${answeredWhileFrozen ? 'DOES' : 'does NOT'} answer CDP; ` +
              `unfreeze ${unfroze ? 'works' : 'FAILED'}.`);
  return answeredWhileFrozen && unfroze ? 0 : 1;
});
