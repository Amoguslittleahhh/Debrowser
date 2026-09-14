'use strict';

/**
 * Headless end-to-end check of the governor.
 *
 * This is not a unit test of the policy arithmetic - it drives the real
 * browser, with real renderers and real pages, and asserts on measured
 * memory. The claims this project makes are all empirical, so the test that
 * backs them has to be too.
 *
 * Run with: npm run smoke
 */

const fs = require('fs');
const { app } = require('electron');
const { Tier } = require('./config');
const fixtureServer = require('./fixture-server');

/**
 * Fixtures are served on distinct sites (t1.test, t2.test, …) rather than as
 * `file://` URLs.
 *
 * This is not incidental. With one-renderer-per-site enabled by default, every
 * file:// fixture lands in a single shared renderer - so the suite would be
 * testing a world where no tab owns its process, per-tab CPU is an estimate,
 * and a tab's measured memory is a share of someone else's. Distinct sites are
 * both what real browsing looks like and the configuration in which the
 * assertions below mean what they say.
 */
let fixtures = null;
let pageUrl = (name) => fixtureServer.fileUrl(name);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Take a settled memory reading.
 *
 * `Metrics` smooths its samples, which is right for policy - it stops the
 * governor reacting to a single spike - but wrong for a measurement we are
 * about to assert on. Sampling repeatedly lets the average converge on the
 * current reality before we read it.
 */
async function settledSample(governor, samples = 6, gapMs = 180) {
  for (let i = 0; i < samples; i++) {
    governor.metrics.sample();
    await sleep(gapMs);
  }
  governor.metrics.attribute();
}

/** Wait until a predicate holds, or give up. */
async function waitFor(predicate, { timeoutMs = 10_000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(pollMs);
  }
  return false;
}

async function runSmoke({ tabs, governor, shell, cfg }) {
  console.log('\n=== Debrowser smoke test ===\n');

  fixtures = await fixtureServer.start();
  let siteIndex = 0;
  pageUrl = (name) => fixtures.url(name, siteIndex++);

  // Compress the idle ladder so the test exercises hours of behaviour in
  // seconds. Policy is unchanged; only the clock is.
  cfg.coldAfterMs = 1500;
  cfg.hibernate.afterMs = 3500;
  cfg.freezeAfterMs = 3000;
  cfg.minLifetimeMs = 1000;
  cfg.tickMs = 500;
  cfg.boost.decayMs = 800;
  cfg.boost.settleAfterMs = 800;
  governor.stop();
  governor.start();

  /* ---------------------------------------------------------------- */
  console.log('1. Opening tabs\n');

  const home = tabs.all()[0];
  await home.wc.loadURL(pageUrl('idle.html')).catch(() => {});

  const heavy = tabs.create({ url: pageUrl('heavy.html'), activate: false, realise: true });
  const animated = tabs.create({ url: pageUrl('animated.html'), activate: false, realise: true });
  const form = tabs.create({ url: pageUrl('form.html'), activate: false, realise: true });
  const busy = tabs.create({ url: pageUrl('busy.html'), activate: false, realise: true });

  const opened = [home, heavy, animated, form, busy];
  const allLoaded = await waitFor(() =>
    opened.every((t) => t.isLive && !t.loading && t.pid));
  check('all tabs load and get renderer processes', allLoaded,
    `pids: ${opened.map((t) => t.pid).join(', ')}`);

  await sleep(1500);
  await settledSample(governor);

  const heavyBaseline = heavy.rssMB;
  check('memory is attributed per tab', heavyBaseline > 0,
    `heavy tab measured at ~${Math.round(heavyBaseline)}MB`);

  // Guard against silently reverting to RSS. Summing RSS across processes
  // counts the Chromium binary once per renderer and overstated this project's
  // figures by roughly 3x; the fix is easy to undo by accident, and the symptom
  // is merely "the numbers look big" rather than anything that breaks.
  const { accountingMode } = require('./memory');
  const mode = accountingMode();
  const naiveRssMB = Math.round(
    require('electron').app.getAppMetrics()
      .reduce((sum, p) => sum + (p.memory?.workingSetSize || 0) / 1024, 0));
  const reported = governor.metrics.snapshot().totalMB;
  if (mode === 'pss') {
    check('memory is counted proportionally, not as summed RSS',
      reported < naiveRssMB * 0.75,
      `${reported}MB proportional vs ${naiveRssMB}MB summed RSS`);
  } else {
    // No PSS on this platform; the fallback is expected to match RSS exactly.
    check('memory accounting falls back to RSS and says so',
      mode === 'rss' && reported > 0, `mode=${mode}, ${reported}MB`);
  }

  /* ---------------------------------------------------------------- */
  console.log('\n2. Idle ladder: hidden tabs demote on their own\n');

  const demoted = await waitFor(() => heavy.tier === Tier.COLD, { timeoutMs: 8000 });
  check('an idle hidden tab is demoted to discard-eligible on its own', demoted,
    `heavy tab reached ${heavy.tier}`);

  await settledSample(governor);
  const heavyAfterIdle = heavy.rssMB;
  const delta = heavyAfterIdle - heavyBaseline;
  // The COLD tier deliberately performs no action on the renderer: forcing a
  // collection was measured as a net loss, and Chromium reclaims a hidden tab
  // on its own. So the assertion is that demotion is *free* - it must not make
  // the tab bigger, which is exactly what the instrumentation to squeeze it did.
  check('demoting an idle tab costs it nothing', delta <= 2,
    `~${Math.round(heavyBaseline)}MB -> ~${Math.round(heavyAfterIdle)}MB ` +
    `(${delta >= 0 ? '+' : ''}${Math.round(delta)}MB)`);

  check('a quiet tab is not frozen, because freezing it would only cost memory',
    heavy.tier !== Tier.FROZEN, `heavy tab at ${heavy.tier}`);

  /* ---------------------------------------------------------------- */
  console.log('\n3. A tab still burning CPU in the background is frozen\n');

  await settledSample(governor, 4);
  const busyCpuBefore = busy.cpu;
  // Compared against a quiet tab rather than an absolute figure: CPU is
  // reported as a smoothed average, so the exact number at any instant depends
  // on where in the worker's duty cycle the sample lands. What matters, and
  // what the freeze decision keys off, is that this tab costs real CPU while
  // hidden and the idle one does not.
  // The gap is the property, not an absolute figure. The regression this guards
  // against - sharing a process's CPU out proportionally - made a busy tab and a
  // quiet one report *identical* CPU, so a margin over the idle tab catches it
  // while tolerating how much the worker's duty cycle varies between runs.
  check('a still-working hidden tab is distinguishable from a quiet one',
    busyCpuBefore > heavy.cpu + 0.1,
    `busy ${busyCpuBefore.toFixed(2)}% vs idle ${heavy.cpu.toFixed(2)}%`);

  const busyFroze = await waitFor(() => busy.tier === Tier.FROZEN, { timeoutMs: 12_000 });
  check('a background tab that is still working gets frozen', busyFroze,
    `busy tab reached ${busy.tier}`);

  await sleep(1500);
  await settledSample(governor, 4);
  check('freezing drops that tab to no measurable CPU', busy.cpu < 1.0,
    `${busyCpuBefore.toFixed(1)}% -> ${busy.cpu.toFixed(2)}% CPU`);
  check('a frozen tab keeps its renderer and its state', busy.isLive && busy.rssMB > 0,
    `still resident at ~${Math.round(busy.rssMB)}MB`);

  /* ---------------------------------------------------------------- */
  console.log('\n4. Animation boost on the foreground tab\n');

  await tabs.activate(animated.id);
  await waitFor(() => animated.visible && animated.tier === Tier.ACTIVE);
  check('a frozen tab is unfrozen before it is presented, not after',
    animated.isLive && !animated.crashed, animated.crashed ? 'renderer crashed on present' : 'ok');

  const boosted = await waitFor(() => animated.boosted, { timeoutMs: 6000 });
  check('an animating foreground tab is boosted', boosted,
    `demand=${animated.demand}, reported=${animated.reportedDemand}`);

  check('the boosted tab is never demoted while animating',
    animated.tier === Tier.ACTIVE, `tier=${animated.tier}`);

  check('the governor defers stalling work while an animation runs',
    governor.boost.quiesceRequested, 'quiesce requested');

  /* ---------------------------------------------------------------- */
  console.log('\n5. Resources are handed back when the animation ends\n');

  // Stop the page animating, exactly as a real page would when its transition
  // finishes, and confirm the boost decays and a trim is queued.
  await animated.wc.executeJavaScript(`
    document.querySelector('.spinner').style.animation = 'none';
    document.querySelector('.bar').style.animation = 'none';
    window.__stopFrames = true;
    const c = document.getElementById('c');
    c.remove();
    true;
  `).catch(() => {});

  // The canvas loop reschedules itself; remove its driver too.
  await animated.wc.executeJavaScript(
    'window.requestAnimationFrame = function () { return 0; }; true;'
  ).catch(() => {});

  const released = await waitFor(() => !animated.boosted, { timeoutMs: 8000 });
  check('boost is released once the animation stops', released,
    `demand=${animated.demand}`);

  check('CPU is handed back as soon as the animation ends',
    animated.priority === cfg.boost.niceForeground && !animated.boosted,
    `priority=${animated.priority}, boosted=${animated.boosted}`);

  /* ---------------------------------------------------------------- */
  console.log('\n6. Protections\n');

  // Force the worst case: a budget far below what is resident.
  await tabs.activate(home.id);
  await sleep(300);
  governor.cfg.memoryBudgetMB = 1;
  await sleep(2500);

  check('unsubmitted input is never discarded',
    form.tier !== Tier.DISCARDED,
    `form tab held at ${form.tier} under critical pressure`);

  check('the visible tab is never demoted under any pressure',
    home.tier === Tier.ACTIVE, `home tab at ${home.tier}`);

  check('pressure is reported as critical when far over budget',
    governor.pressure === 'critical', `pressure=${governor.pressure}`);

  const discardedSomething = governor.stats.discards > 0 ||
    tabs.all().some((t) => t.tier === Tier.DISCARDED);
  check('the governor reclaims from the least valuable tabs under pressure',
    discardedSomething || governor.stats.freezes > 0,
    `${governor.stats.freezes} frozen, ${governor.stats.discards} discarded`);

  /* ---------------------------------------------------------------- */
  console.log('\n7. Discard and restore round trip\n');

  governor.cfg.memoryBudgetMB = 4096; // relieve pressure
  const victim = tabs.all().find((t) => t !== home && t !== form) || heavy;
  const victimUrl = victim.url;

  await governor.enforceManualDiscard(victim);
  const isDiscarded = victim.tier === Tier.DISCARDED;
  check('a discarded tab releases its renderer entirely',
    isDiscarded && !victim.isLive && victim.rssMB === 0,
    isDiscarded ? 'renderer destroyed, 0MB' : `tier=${victim.tier}`);

  await tabs.activate(victim.id);
  const restored = await waitFor(() => victim.isLive && !victim.loading && victim.url === victimUrl,
    { timeoutMs: 10_000 });
  check('activating a discarded tab restores it to the same page', restored,
    `url=${victim.url}`);

  // The guard rail. Every memory lever in this browser is a trade against
  // responsiveness, and a restore is the only reclaim the user can feel, so the
  // cost of one is asserted beside the megabytes it saved.
  //
  // The assertion is that a restore was measured at all, and that its p95 is
  // within a ceiling loose enough to survive a loaded CI machine. It is not a
  // performance target - the real target lives in the bench, where the machine
  // is not also running a browser test suite. What this catches is a change that
  // stops recording the series, or that makes a restore take seconds.
  const restoreLatency = tabs.latency.percentiles('restore');
  check('a restore is measured, and is not pathologically slow',
    restoreLatency !== null && restoreLatency.n > 0 && restoreLatency.p95 < 5000,
    restoreLatency
      ? `n=${restoreLatency.n} p50=${restoreLatency.p50}ms p95=${restoreLatency.p95}ms`
      : 'no restore samples recorded');

  /* ---------------------------------------------------------------- */
  console.log('\n8. Restore placeholder\n');

  // A discard the user can see is a discard the reclaim policy cannot afford to
  // make often. These checks cover the mechanism that hides it, and the privacy
  // rule that mechanism is bounded by.
  const shot = tabs.create({ url: pageUrl('heavy.html'), activate: true, realise: true });
  await waitFor(() => shot.isLive && !shot.loading, { timeoutMs: 10_000 });
  await tabs.activate(home.id);                       // switch away: captures
  await waitFor(() => shot.thumbPath !== null, { timeoutMs: 5000 });

  const hasThumb = Boolean(shot.thumbPath) && fs.existsSync(shot.thumbPath || '');
  const thumbKB = hasThumb ? Math.round(fs.statSync(shot.thumbPath).size / 1024) : 0;
  check('leaving a tab photographs it, cheaply',
    hasThumb && thumbKB > 0 && thumbKB < 250,
    hasThumb ? `${thumbKB}KB on disk` : 'no thumbnail written');

  check('the thumbnail lives outside userData, so a crash leaves nothing behind',
    hasThumb && shot.thumbPath.startsWith(app.getPath('temp')),
    hasThumb ? shot.thumbPath.replace(app.getPath('temp'), '<temp>') : 'n/a');

  // The privacy rule. A screenshot of a logged-in page on disk would defeat the
  // existing refusal to read credential fields into the session store at all.
  const login = tabs.create({ url: pageUrl('login.html'), activate: true, realise: true });
  await waitFor(() => login.isLive && !login.loading, { timeoutMs: 10_000 });
  await tabs.activate(home.id);
  await sleep(1200);
  check('a page carrying a password field is never photographed',
    login.hasSensitiveFields && login.thumbPath === null,
    `sensitive=${login.hasSensitiveFields} thumbnail=${login.thumbPath || 'none'}`);

  // And the placeholder actually goes up on the restore path.
  await governor.enforceManualDiscard(shot);
  const covered = shell.showPlaceholder(shot);
  shell.hidePlaceholder();
  check('a discarded tab with a thumbnail can be covered while it reloads',
    covered === true, `placeholder shown=${covered}`);

  /* ---------------------------------------------------------------- */
  console.log('\n9. Hibernation\n');

  // The only lever that works on a tab the protections refuse to discard. What
  // matters is that memory actually leaves the process and that the page comes
  // back without a reload - a tier that reports success while reclaiming
  // nothing is the failure mode this whole feature nearly shipped with.
  if (!governor.trimAvailable) {
    console.log(`  SKIP  hibernation unavailable here: ${governor.trimReason}`);
  } else {
    const big = tabs.create({ url: pageUrl('bigheap.html?mb=120'), activate: false, realise: true });
    await waitFor(() => big.isLive && !big.loading, { timeoutMs: 30_000 });
    // Let the heap finish building and the governor take a private-bytes reading.
    await waitFor(() => big.privateMB != null && big.privateMB > governor.cfg.hibernate.minPrivateMB,
      { timeoutMs: 30_000 });

    const privateBefore = big.privateMB;
    const hibernated = await waitFor(() => big.tier === Tier.HIBERNATED, { timeoutMs: 20_000 });
    check('an idle tab hibernates rather than being discarded',
      hibernated && big.isLive,
      `tier=${big.tier} live=${big.isLive}`);

    await sleep(1500);
    const after = require('./memory').readProcessMemory(big.pid);
    const reclaimed = after ? privateBefore - after.privateMB : 0;
    check('hibernating actually removes memory from the renderer',
      reclaimed > 5,
      `private ${privateBefore.toFixed(0)}MB -> ${after ? after.privateMB.toFixed(0) : '?'}MB ` +
      `(${reclaimed.toFixed(0)}MB out)`);

    // The whole point: no reload, no lost state.
    const urlBefore = big.url;
    await tabs.activate(big.id);
    const woke = await waitFor(() => big.tier === Tier.ACTIVE, { timeoutMs: 10_000 });
    const stateIntact = big.isLive
      ? await big.wc.executeJavaScript('!!window.__retained && window.__retained.length > 0')
          .catch(() => false)
      : false;
    check('a hibernated tab wakes with its page state intact, no reload',
      woke && stateIntact && big.url === urlBefore,
      `tier=${big.tier} retained-state=${stateIntact}`);
  }

  /* ---------------------------------------------------------------- */
  console.log('\n10. Speculative restore\n');

  // Speculation is the one mechanism here that can add memory rather than
  // reclaim it, so what is checked is mostly that it refuses to.
  governor.cfg.maxLiveTabs = 0;          // the cap is exercised in the next section
  const spec = tabs.create({ url: pageUrl('idle.html'), activate: false, realise: true });
  await waitFor(() => spec.isLive && !spec.loading, { timeoutMs: 10_000 });
  await governor.enforceManualDiscard(spec);

  const started = tabs.speculate(spec.id);
  check('resting on a discarded tab starts restoring it',
    started === true && spec.isLive, `speculated=${started} live=${spec.isLive}`);

  // At most one in flight: a pointer swept across the strip must not rebuild
  // every renderer it passes.
  const second = tabs.all().find((t) => !t.isLive && t !== spec);
  const alsoStarted = second ? tabs.speculate(second.id) : false;
  check('only one speculation runs at a time',
    alsoStarted === false, `second speculation accepted=${alsoStarted}`);

  // And the leash: a guess the user never acted on is taken back. Waiting for
  // the load to finish first is not test hygiene but the actual contract - the
  // ladder never interrupts a loading tab, so an expired speculation is
  // reclaimed on the first tick after it settles rather than mid-request.
  await waitFor(() => spec.isLive && !spec.loading, { timeoutMs: 10_000 });
  spec.speculativeUntil = Date.now() - 1;
  spec.everVisible = false;
  await governor.runIdleLadder();
  check('a speculation the user ignored is discarded again',
    !spec.isLive && spec.tier === Tier.DISCARDED,
    `tier=${spec.tier} live=${spec.isLive}`);

  /* ---------------------------------------------------------------- */
  console.log('\n11. Live renderer cap\n');

  // The cap is what bounds memory for someone who opens tabs in bursts: the
  // budget cannot help them, because on a large machine thirty tabs never reach
  // it. Use a deliberately small cap so the behaviour is unambiguous.
  governor.cfg.maxLiveTabs = 3;
  governor.cfg.minLifetimeMs = 500;

  const burst = [];
  for (let i = 0; i < 6; i++) {
    burst.push(tabs.create({ url: pageUrl('idle.html'), activate: false, realise: true }));
  }

  const settledUnderCap = await waitFor(() => {
    const live = tabs.all().filter((t) => t.isLive).length;
    return live <= governor.cfg.maxLiveTabs;
  }, { timeoutMs: 20_000 });

  const liveNow = tabs.all().filter((t) => t.isLive).length;
  check('a burst of tabs is held at the live renderer cap', settledUnderCap,
    `${tabs.all().length} tabs open, ${liveNow} live (cap ${governor.cfg.maxLiveTabs})`);

  check('the visible tab survives the cap',
    tabs.activeTab()?.isLive === true, `active tab live=${tabs.activeTab()?.isLive}`);

  // The cap must reclaim least-recently-used first, so the newest burst tab
  // should outlive the oldest.
  const oldest = burst[0];
  const newest = burst[burst.length - 1];
  check('the cap discards least-recently-used first',
    !oldest.isLive || newest.isLive,
    `oldest live=${oldest.isLive}, newest live=${newest.isLive}`);

  // And a capped-out tab must still come back intact.
  const revived = await tabs.activate(oldest.id);
  const cameBack = await waitFor(() => revived.isLive && !revived.loading, { timeoutMs: 10_000 });
  check('a tab discarded by the cap reopens normally', cameBack,
    `url=${revived.url}`);

  /* ---------------------------------------------------------------- */
  console.log('\n12. Footprint\n');

  governor.metrics.sample();
  const snap = governor.metrics.snapshot();
  console.log(`  ${snap.totalMB}MB total across ${snap.processCount} processes ` +
              `(${snap.rendererCount} renderers) for ${tabs.all().length} tabs`);
  console.log(`  browser + GPU + utility overhead: ${snap.overheadMB}MB`);
  const lat = tabs.latency.stats();
  const fmtLat = (name) => (lat[name]
    ? `${name} p50 ${lat[name].p50}ms / p95 ${lat[name].p95}ms (n=${lat[name].n})`
    : null);
  const shown = ['restore', 'switch', 'content'].map(fmtLat).filter(Boolean);
  if (shown.length) console.log(`  what it cost the user: ${shown.join(', ')}`);
  console.log(`  reclaimed so far: ~${Math.round(governor.stats.reclaimedMB)}MB ` +
              `across ${governor.stats.freezes} freezes and ` +
              `${governor.stats.discards} discards`);

  /* ---------------------------------------------------------------- */
  if (fixtures) await fixtures.close();

  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===\n`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    console.log('');
  }

  return failed.length ? 1 : 0;
}

module.exports = { runSmoke };
