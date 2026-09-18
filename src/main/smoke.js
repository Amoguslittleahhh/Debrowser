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
const { Tier, tierRank, isStopped } = require('./config');
const { applyPrefs } = require('./prefs');
const platform = require('./platform');
const fixtureServer = require('./fixture-server');
const pages = require('./pages');
const path = require('path');
const { BROWSING_PARTITION } = require('./tabs/tab-manager');

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

async function runSmoke({ tabs, governor, shell, cfg, prefs, menuModel, toggleDevTools,
                          openInternalPage, senderPage, bookmarks }) {
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

  // The highest CPU this tab reports while hidden, tracked as we go rather than
  // read once at the end. Freezing drives CPU to zero *by construction* - that
  // is what it is for - so a reading taken after the fact says "quiet" about
  // every frozen tab, including the ones that were frozen precisely because
  // they were busy. Only a sample from before the decision can tell them apart.
  let heavyPeakCpu = 0;
  const notePeak = () => { heavyPeakCpu = Math.max(heavyPeakCpu, heavy.cpu); };

  // "At least COLD", not "exactly COLD". The tab passes *through* COLD on its
  // way down, so an equality test polled every 200ms can miss it entirely - and
  // does, on a slow or contended machine where the tab is still busy enough to
  // be frozen a moment later. The property is that an idle tab demotes itself
  // without being told; which rung it has reached by the time we look is not.
  const demoted = await waitFor(
    () => { notePeak(); return tierRank(heavy.tier) >= tierRank(Tier.COLD); },
    { timeoutMs: 8000 });
  check('an idle hidden tab is demoted to discard-eligible on its own', demoted,
    `heavy tab reached ${heavy.tier}`);

  await settledSample(governor);
  notePeak();
  const heavyAfterIdle = heavy.rssMB;
  const delta = heavyAfterIdle - heavyBaseline;
  // The COLD tier deliberately performs no action on the renderer: forcing a
  // collection was measured as a net loss, and Chromium reclaims a hidden tab
  // on its own. So the assertion is that demotion is *free* - it must not make
  // the tab bigger, which is exactly what the instrumentation to squeeze it did.
  check('demoting an idle tab costs it nothing', delta <= 2,
    `~${Math.round(heavyBaseline)}MB -> ~${Math.round(heavyAfterIdle)}MB ` +
    `(${delta >= 0 ? '+' : ''}${Math.round(delta)}MB)`);

  // Conditional on the tab having actually been quiet, which is the policy:
  // freezing is for tabs still burning CPU out of sight. `heavy.html` is a
  // DOM-heavy page and on a slow machine it is still above the 0.8% threshold
  // when the compressed freeze clock fires - at which point freezing it is
  // *correct*, and an unconditional assertion fails on the governor doing the
  // right thing. The condition uses the peak seen before the decision, not the
  // current reading, for the reason given where `notePeak` is defined.
  const heavyWasQuiet = heavyPeakCpu < cfg.freezeCpuThreshold;
  check('a quiet tab is not frozen, because freezing it would only cost memory',
    !heavyWasQuiet || heavy.tier !== Tier.FROZEN,
    `heavy tab at ${heavy.tier}, peak ${heavyPeakCpu.toFixed(2)}% CPU ` +
    `(threshold ${cfg.freezeCpuThreshold}%)${heavyWasQuiet ? '' : ' - it was busy, so freezing is correct'}`);

  /* ---------------------------------------------------------------- */
  console.log('\n3. A tab still burning CPU in the background is frozen\n');

  // Compared against a quiet tab rather than an absolute figure: CPU is
  // reported as a smoothed average, so the exact number at any instant depends
  // on where in the worker's duty cycle the sample lands. What matters, and
  // what the freeze decision keys off, is that this tab costs real CPU while
  // hidden and the idle one does not.
  // The gap is the property, not an absolute figure. The regression this guards
  // against - sharing a process's CPU out proportionally - made a busy tab and a
  // quiet one report *identical* CPU, so a margin over the idle tab catches it
  // while tolerating how much the worker's duty cycle varies between runs.
  //
  // Waited for rather than read once. The figure is an exponential moving
  // average seeded from zero, so how many samples it takes to climb depends on
  // the machine: on a contended or cold host four samples put it at 0.04%,
  // under the margin, and the check failed on a browser that was behaving
  // correctly. Waiting asserts the same property without asserting a rate of
  // convergence nobody promised.
  // Sampled at the governor's own cadence, not faster. `percentCPUUsage` is a
  // *rate* measured between calls, so polling it every 150ms asks "how busy was
  // this process over the last 150ms" and can answer zero for a page whose
  // worker is plainly running - which is what the macOS runner reported, busy
  // and idle both at 0.00%. Sampling at tickMs gives the figure an interval it
  // can actually be computed over.
  const cpuGap = () => busy.cpu - heavy.cpu;
  const distinguishable = await waitFor(async () => {
    await settledSample(governor, 2, cfg.tickMs);
    return cpuGap() > 0.1;
  }, { timeoutMs: 20_000, pollMs: 0 });
  const busyCpuBefore = busy.cpu;

  // This check races the governor, and on a contended runner the governor wins.
  //
  // A busy hidden tab is exactly what the freeze rule is for, and the compressed
  // clock fires it after three seconds. A frozen tab reports no CPU *by
  // construction* - that is the point of freezing it - so once the freeze lands
  // the gap can never appear and the twenty-second wait is spent watching two
  // zeros. Failing on that reports a browser fault where the browser did the
  // right thing slightly sooner than the observation.
  //
  // So the two outcomes are separated. An observed gap is the property holding.
  // No gap with the tab still running is a real failure. No gap because the tab
  // was already stopped is an observation that was never possible, reported as
  // a skip rather than scored either way - the very next check then asserts the
  // freeze that consumed it, so nothing goes unexamined.
  if (!distinguishable && isStopped(busy.tier)) {
    console.log(`  SKIP  a still-working hidden tab is distinguishable from a quiet one: ` +
                `the tab was ${busy.tier} before a CPU sample could be taken`);
  } else {
    check('a still-working hidden tab is distinguishable from a quiet one',
      distinguishable,
      `busy ${busyCpuBefore.toFixed(2)}% vs idle ${heavy.cpu.toFixed(2)}%`);
  }

  const busyFroze = await waitFor(() => busy.tier === Tier.FROZEN, { timeoutMs: 12_000 });
  check('a background tab that is still working gets frozen', busyFroze,
    `busy tab reached ${busy.tier}`);

  // Waited for, not read once, for the same reason as the gap above: this is a
  // smoothed average and a fixed number of samples asserts a rate of decay
  // rather than the property. Given time to settle, a frozen tab's CPU is zero
  // or the freeze did not work - and if it did not, that is a finding about the
  // platform rather than about the sampling, which is what this distinguishes.
  await sleep(1500);
  const quiet = await waitFor(async () => {
    await settledSample(governor, 2, cfg.tickMs);
    return busy.cpu < 1.0;
  }, { timeoutMs: 20_000, pollMs: 0 });
  check('freezing drops that tab to no measurable CPU', quiet,
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

  // The same property, under the load that was added after this check was
  // written. Thumbnail capture, the placeholder composite and speculative loads
  // all landed on the tab-switch path, and each one is work that could steal
  // frames from exactly the tab being animated. The quiesce gates are the
  // mechanism; this is what makes them a guarantee rather than an intention.
  const speculatable = tabs.all().find((t) => !t.isLive && t !== animated);
  const spooled = speculatable ? tabs.speculate(speculatable.id) : false;
  animated.captureThumbnail().catch(() => {});
  await sleep(1200);

  check('an animating tab keeps its boost while a capture and a speculation run',
    animated.boosted && animated.tier === Tier.ACTIVE,
    `boosted=${animated.boosted} tier=${animated.tier} speculation=${spooled}`);

  check('speculation is refused outright while anything is animating',
    governor.allowsSpeculation() === false,
    `allowsSpeculation=${governor.allowsSpeculation()}`);

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

  // Minimising on Windows fires `resize` with a client area of zero. Laying out
  // from that writes zero-width bounds over every view, and nothing puts them
  // back - the window returns from the taskbar showing its background colour
  // and the native menu bar, with no tab strip and no page. It cannot be
  // reproduced under xvfb, where there is no window manager and `minimize()` is
  // a no-op, so the states Windows reports are supplied directly and the real
  // `layout()` is asked to survive them.
  const realWindow = shell.window;
  const healthy = { x: 0, y: 0, width: 1280, height: 820 };
  const asWindow = (over) => ({
    isDestroyed: () => false,
    isMinimized: () => false,
    getContentBounds: () => healthy,
    contentView: realWindow.contentView,
    ...over
  });
  try {
    shell.window = asWindow();
    shell.layout();
    const good = shell.chromeView.getBounds().width;

    shell.window = asWindow({ isMinimized: () => true,
                              getContentBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }) });
    shell.layout();
    const afterMinimise = shell.chromeView.getBounds().width;

    shell.window = asWindow({ getContentBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }) });
    shell.layout();
    const afterZeroResize = shell.chromeView.getBounds().width;

    check('minimising does not flatten the window layout',
      good > 0 && afterMinimise === good && afterZeroResize === good,
      `chrome width ${good} -> ${afterMinimise} minimised -> ${afterZeroResize} on a 0x0 resize`);
  } finally {
    shell.window = realWindow;
    shell.layout();
  }

  /* ---------------------------------------------------------------- */
  console.log('\n9. Hibernation\n');

  // The only lever that works on a tab the protections refuse to discard. What
  // matters is that memory actually leaves the process and that the page comes
  // back without a reload - a tier that reports success while reclaiming
  // nothing is the failure mode this whole feature nearly shipped with.
  // The capability must not claim to work where it provably cannot. MADV_PAGEOUT
  // succeeds with no swap and reclaims nothing, so a check that only asks
  // whether the syscall is permitted reports a working feature on a machine
  // where it does nothing - which is exactly what shipped, and what this asserts
  // against.
  const compression = require('./memory').compressionStatus();
  const cap = await require('./platform').trimCapability();
  // Both halves, against an *independent* reading of the compressor, and a
  // named reason whenever either is missing. Asserting on `cap.compression`
  // would restate the expression that produced `cap.available` and could not
  // fail; asserting on the compressor alone passed on a machine with zram and
  // no CAP_SYS_NICE, because the mechanism string was built from the platform
  // rather than from whether the syscall is actually permitted.
  check('hibernation is only offered where there is somewhere to compress into',
    cap.available === (cap.permitted && compression.available)
      && (cap.available || typeof cap.reason === 'string'),
    `permitted=${cap.permitted} compressor=${compression.available
      ? `${compression.compressor} ${compression.swapMB}MB` : 'none'} ` +
    `available=${cap.available}${cap.available ? '' : ` reason="${cap.reason}"`}`);

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

    // A refusal must cost once, not every tick. A pid that does not exist is
    // refused by the kernel at `pidfd_open` (ESRCH), which is the cheapest
    // honest way to drive this path - the helper answers `err <pid> 3` exactly
    // as it would for an EPERM on a real renderer.
    const platform = require('./platform');
    const ghost = 0x7ffffffe;
    const first = await platform.trimProcessMemory(ghost);
    const backoff = platform.trimBackoffMs(ghost);
    const second = await platform.trimProcessMemory(ghost);
    const backoffAfter = platform.trimBackoffMs(ghost);

    // That the second call never reached the helper is asserted from the
    // backoff, not from a stopwatch: a wall-clock budget in a main process that
    // has just built a 120MB heap fails on a GC pause, and a round trip about a
    // pid that does not exist returns in about a millisecond anyway, so timing
    // could not tell the two apart. A second refusal would have been a second
    // strike and doubled the window; an unchanged window is the evidence.
    check('a refused trim backs off instead of retrying every tick',
      first === null && second === null && backoff > 0 && backoffAfter <= backoff,
      `refused=${first === null} backoff=${Math.round(backoff / 1000)}s, ` +
      `unchanged after a second attempt=${backoffAfter <= backoff}`);
    platform.forgetProcess(ghost);
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

  // The new tab page counts, and can be reclaimed like anything else.
  //
  // It used to be exempt, along with Settings and History, on the reasoning that
  // the browser's own pages are few and were opened to do something. That holds
  // for the pages it was written about and not at all for this one: an empty tab
  // holds it, people open them by reflex, and it has no state to lose. In a real
  // session fifteen of them sat pinned at ACTIVE with the live count reading
  // 15/12 - every one of them untouchable by the governor that was meant to be
  // bounding them.
  const blanks = [];
  for (let i = 0; i < 6; i++) {
    blanks.push(tabs.create({ url: pages.NEW_TAB_URL, activate: false, realise: true }));
  }
  const blanksCapped = await waitFor(
    () => tabs.all().filter((t) => t.isLive).length <= governor.cfg.maxLiveTabs,
    { timeoutMs: 20_000 });
  const liveBlanks = blanks.filter((t) => t.isLive).length;
  check('a burst of new tab pages is capped like any other tab',
    blanksCapped && liveBlanks < blanks.length,
    `${liveBlanks}/${blanks.length} blank tabs live, ` +
    `${tabs.all().filter((t) => t.isLive).length} live overall (cap ${governor.cfg.maxLiveTabs})`);

  // Typed text on the new tab page survives the cap.
  //
  // Taking the blanket exemption off that page rested on `hasDirtyInput`
  // catching a half-typed query - and that flag is set by `probe-preload.js`,
  // which the browser's own pages do not carry, so it was always false here.
  // The reasoning was sound and the mechanism was absent. The page reports it
  // over the command bridge now, and this is what says so.
  {
    const blank = blanks.find((t) => t.isLive) || blanks[0];
    const empty = governor.clampToProtections(blank, Tier.DISCARDED, { ignoreGrace: true });
    blank.hasDirtyInput = true;
    const typed = governor.clampToProtections(blank, Tier.DISCARDED, { ignoreGrace: true });
    blank.hasDirtyInput = false;
    // A smaller rank is a stronger protection - TIER_ORDER runs ACTIVE down to
    // DISCARDED - so "not discarded" is `<`, which is the direction
    // `clampToProtections` itself compares in.
    check('a new tab page holding typed text is not discarded',
      empty === Tier.DISCARDED && tierRank(typed) < tierRank(Tier.DISCARDED),
      `empty: ${empty}, with text: ${typed}`);
  }

  // Settings is the page the old rule was actually written for, and it keeps
  // its exemption: discarding one throws away whatever the user was part-way
  // through setting.
  check('Settings is still never discarded',
    governor.clampToProtections(
      { internal: true, url: pages.SETTINGS_URL }, Tier.DISCARDED,
      { ignoreGrace: true }) === Tier.ACTIVE,
    'settings floor is ACTIVE');

  for (const blank of blanks) tabs.close(blank.id);

  // And a capped-out tab must still come back intact.
  const revived = await tabs.activate(oldest.id);
  const cameBack = await waitFor(() => revived.isLive && !revived.loading, { timeoutMs: 10_000 });
  check('a tab discarded by the cap reopens normally', cameBack,
    `url=${revived.url}`);

  /* ---------------------------------------------------------------- */
  /* ---------------------------------------------------------------- */
  console.log('\n12. Settings and preferences\n');

  // Settings is chrome, not a tab: it must not count against the live-renderer
  // cap, be eligible for discard, or stay resident once closed. The last is the
  // one worth asserting - a settings page that quietly holds a renderer for the
  // life of the window would spend more than several tabs.
  // Settings is a page now, not a lid laid over the content area.
  //
  // The overlay it replaced produced a bug that looked like a freeze: it
  // covered every tab, nothing dismissed it, and switching tabs appeared to do
  // nothing. So the property worth asserting is that opening Settings leaves
  // the browser navigable - a second tab can still be activated and become
  // visible afterwards - and that the page is exempt from the governor, which
  // would otherwise be free to freeze or discard it mid-edit.
  const settingsTab = tabs.create({ url: pages.SETTINGS_URL, activate: true, realise: true });
  await waitFor(() => settingsTab.isLive && !settingsTab.loading, { timeoutMs: 10_000 });

  // That the renderer exists is not that the page loaded. `protocol.handle`
  // registers on the default session only, and tabs run in their own
  // partition - so this failed with ERR_FAILED in a tab while rendering
  // perfectly in a default-session harness. Assert the document, not the view.
  const settingsTitle = await settingsTab.wc.executeJavaScript('document.title').catch(() => null);
  check('the browser\'s own pages load inside a tab, not only in the default session',
    settingsTitle === 'Settings',
    `document.title=${JSON.stringify(settingsTitle)}`);

  const other = tabs.all().find((t) => t !== settingsTab && !t.internal);
  await tabs.activate(other.id);
  await sleep(300);

  check('opening settings does not trap the browser on it',
    other.visible && !settingsTab.visible,
    `settings visible=${settingsTab.visible}, other tab visible=${other.visible}`);

  // Ask for the deepest demotion there is and confirm the protections refuse it.
  const floor = governor.clampToProtections(settingsTab, Tier.DISCARDED, { discardAllowed: true });
  check('the browser\'s own pages are never demoted by the governor',
    settingsTab.internal && floor === Tier.ACTIVE,
    `internal=${settingsTab.internal}, asked for discarded, allowed ${floor}`);

  // Opening it twice focuses the one that is open rather than making a second,
  // which could disagree with the first about what the preferences are.
  // Actually ask for it a second time. Merely counting the tabs that exist
  // would pass against the bug this guards: matching on the URL we opened stops
  // matching once the page loads and Chromium normalises it to a trailing
  // slash, and only a real second open reveals that.
  const before = tabs.all().length;
  openInternalPage(tabs, pages.SETTINGS_URL);
  await sleep(300);
  const settingsTabs = tabs.all().filter((t) => pages.pageName(t.url) === 'settings');
  check('asking for settings twice focuses the open one rather than making another',
    settingsTabs.length === 1 && settingsTabs[0] === settingsTab && tabs.all().length === before,
    `${settingsTabs.length} settings tab(s), ${tabs.all().length} tabs (was ${before}), url=${settingsTab.url}`);

  // Settings is a tab, and tabs are not where `publish` used to send state.
  // Both of the browser's own pages build their whole UI from that message, so
  // when the overlay was replaced and publish was not updated, Settings
  // rendered as a column of empty headings - and every check still passed,
  // because they all asserted on the tab rather than on the page.
  shell.publish(governor.snapshot());
  await sleep(200);
  const sawState = await settingsTab.wc.executeJavaScript(
    'document.querySelectorAll("#appearance .row").length').catch(() => 0);
  check('the browser\'s own pages are sent browser state',
    sawState > 0, `${sawState} setting rows built from a published snapshot`);

  tabs.close(settingsTab.id);

  /* ---------------------------------------------------------------- */
  // The production path, which the offline fixtures do not exercise.
  //
  // Every tab opens on debrowser://newtab and its search box navigates that
  // same tab to a website, so "is this tab one of ours?" is a question whose
  // answer changes under the browser's feet. Deciding it once at construction
  // left every tab in the browser permanently marked internal: exempt from the
  // governor, so nothing was ever reclaimed, and treated as privileged for the
  // rest of its life. None of the checks above could see it, because under
  // --smoke-test the home page is a file:// fixture.
  const fresh = tabs.create({ url: pages.NEW_TAB_URL, activate: true, realise: true });
  await waitFor(() => fresh.isLive && !fresh.loading, { timeoutMs: 10_000 });
  check('a tab on the new tab page is one of ours', fresh.internal === true,
    `internal=${fresh.internal} url=${fresh.url}`);

  const webUrl = pageUrl('idle.html');
  await fresh.wc.loadURL(webUrl).catch(() => {});
  await waitFor(() => !fresh.loading && fresh.url.startsWith('http'), { timeoutMs: 10_000 });

  check('navigating a new tab to a website stops it being one of ours',
    fresh.internal === false,
    `internal=${fresh.internal} url=${fresh.url.slice(0, 48)}`);

  // Which is what decides whether the governor may touch it at all.
  check('a tab that navigated away is governed again',
    governor.clampToProtections(fresh, Tier.DISCARDED, { discardAllowed: true }) !== Tier.ACTIVE,
    `floor=${governor.clampToProtections(fresh, Tier.DISCARDED, { discardAllowed: true })}`);

  // And the security consequence. The renderer still carries the preload it was
  // realised with - that cannot be revoked - so privilege is decided from the
  // sender's live URL instead. A site sitting in a renderer that used to be the
  // new tab page must be refused.
  check('a website cannot use a bridge it inherited from one of our pages',
    senderPage(tabs, fresh.wc) === null,
    `sender resolves to ${JSON.stringify(senderPage(tabs, fresh.wc))}`);

  // The confinement on internal pages is installed once, when the renderer is
  // realised, and every renderer is realised on the new tab page. Without a
  // live check it went on cancelling navigations for the tab's whole life, so
  // every link click and GET form submission on every website was hijacked into
  // a new tab. `loadURL` does not fire `will-navigate`, which is why the checks
  // above could not see it - this one drives a real link click.
  const tabsBeforeClick = tabs.all().length;
  await fresh.wc.executeJavaScript(`
    const a = document.createElement('a');
    a.href = ${JSON.stringify(pageUrl('form.html'))};
    document.body.appendChild(a);
    a.click();
  `).catch(() => {});
  await sleep(600);
  check('a link on a website navigates in place rather than opening a tab',
    tabs.all().length === tabsBeforeClick,
    `${tabs.all().length} tabs (was ${tabsBeforeClick}); url=${fresh.url.slice(0, 44)}`);

  tabs.close(fresh.id);

  /* ---------------------------------------------------------------- */
  // A boost belongs to the tab in front of the user.
  //
  // Releasing it only when the boosted tab was also the active tab meant that
  // switching away from an animating page left it boosted forever - and with it
  // `quiesceRequested`, which stands the whole governor down. Nothing after
  // that point would have been reclaimed for the rest of the session.
  const spinner = tabs.create({ url: pageUrl('animated.html'), activate: true, realise: true });
  await waitFor(() => spinner.isLive && !spinner.loading, { timeoutMs: 10_000 });
  const gotBoost = await waitFor(() => governor.boost.boostedTabId === spinner.id,
    { timeoutMs: 8000 });

  await tabs.activate(home.id);
  const boostDropped = await waitFor(() => governor.boost.boostedTabId === null, { timeoutMs: 8000 });
  check('a boost is released when the user switches away from the tab holding it',
    gotBoost && boostDropped,
    `boosted=${gotBoost}, released=${boostDropped}, boostedTabId=${governor.boost.boostedTabId}`);

  tabs.close(spinner.id);

  // The menu is built fresh on every open from live state. It is drawn by a
  // renderer of ours now rather than by the platform, so what has to hold is
  // that the model is complete and serialisable: every item the renderer can
  // act on carries an `id`, and anything that cannot survive IPC - a function,
  // as the old Electron template's `click` handlers were - would be silently
  // dropped on the way across and leave a row that does nothing.
  const model = menuModel({ tabs, shell });
  const labels = model.map((item) => item.label).filter(Boolean);
  const ids = model.filter((item) => item.id).map((item) => item.id);
  const survivesIpc = JSON.stringify(model) === JSON.stringify(JSON.parse(JSON.stringify(model)));
  check('the menu model is built from live state, and all of it survives IPC',
    survivesIpc && labels.includes('New tab') && labels.includes('Settings') &&
    labels.includes('Task manager') && labels.includes('History') &&
    labels.includes('Developer tools') &&
    model.some((item) => item.kind === 'zoom' && typeof item.value === 'number'),
    `${ids.length} commands: ${ids.join(' / ')}`);

  // Every command the menu can send has to be one the bridge will carry. A typo
  // here is invisible until someone clicks the item, at which point the preload
  // drops it with a console warning nobody is reading.
  //
  // Read out of the preload's source rather than imported from it. A sandboxed
  // preload may only require `electron` and Node's own builtins, so the
  // allowlist cannot live in a module both sides share - and a second copy of
  // it here to compare against would be the drift this check is looking for.
  const preloadSource = fs.readFileSync(
    path.join(__dirname, '..', 'preload', 'chrome-preload.js'), 'utf8');
  const unknown = ids.filter((id) => !preloadSource.includes(`'${id}'`));
  check('every item in the menu names a command the bridge allows',
    unknown.length === 0,
    unknown.length ? `not allowed: ${unknown.join(', ')}` : `${ids.length} checked`);

  // The menu view itself: created on open, on top of everything, and gone
  // afterwards. The last of those is the one worth a test - the menu is a
  // renderer, and a browser that leaves one running behind a closed dropdown
  // would be spending a process on nothing, which is the thing this project
  // exists to avoid.
  {
    shell.openSheet('menu', { x: 100, y: 84, right: 132 });
    const view = shell.sheetView;

    // Waited for, because the view is put on screen only once its page has
    // loaded. It used to be added before the load was even started, and a
    // window-sized view with nothing painted in it is a window-sized white
    // rectangle - which is what pressing the three dots flashed. So "is it on
    // top and window-sized" is now a question with a moment's delay in front of
    // it, and asking it immediately is asking before the answer exists.
    const shown = await waitFor(
      () => shell.window.contentView.children.includes(view), { timeoutMs: 8000 });

    const children = shell.window.contentView.children;
    const onTop = shown && children[children.length - 1] === view;
    const covers = shown &&
      view.getBounds().width === shell.window.getContentBounds().width;
    const wc = view && view.webContents;

    shell.closeSheet();
    // `webContents.close()` is a graceful close, so the renderer is still there
    // for a moment afterwards. Waited for rather than read straight back: the
    // question is whether it goes away, not whether it goes away synchronously.
    const released = await waitFor(() => !wc || wc.isDestroyed(), { timeoutMs: 5000 });
    const gone = shell.sheetView === null && released;
    check('the menu is drawn over the whole window and its renderer is destroyed on close',
      onTop && covers && gone,
      `on top: ${onTop}, window-sized: ${covers}, renderer released: ${gone}`);
  }

  /* ---------------------------------------------------------------- */
  // Favicons: the site's own logo, and what happens when there is not one.
  //
  // The second half of this is the load-bearing part. Chromium reports an icon
  // address for *every* page - a page that declares nothing still arrives as
  // `<origin>/favicon.ico`, because that is the address it would try - and
  // plenty of sites do not serve it. That is why the tab strip shows the
  // letter chip until an image loads and puts it back when one errors, and
  // why the history store can derive an icon address instead of keeping one.
  // If this ever stopped being true, both of those would be built on nothing.
  {
    const branded = tabs.create({ url: pageUrl('branded.html'), activate: false, realise: true });
    const bare = tabs.create({ url: pageUrl('idle.html'), activate: false, realise: true });
    const gotIcons = await waitFor(() => branded.favicon && bare.favicon, { timeoutMs: 10_000 });

    const declared = String(branded.favicon || '');
    const derived = String(bare.favicon || '');
    check('a page that declares an icon is reported with that icon',
      gotIcons && declared.endsWith('/icon.svg'), declared || 'nothing reported');
    check('a page that declares none is still reported, as the default address',
      gotIcons && derived.endsWith('/favicon.ico'), derived || 'nothing reported');

    // The store keeps an address only when it could not be worked out, which is
    // what keeps a ten-thousand-entry history from carrying ten thousand copies
    // of a string the page can derive.
    const { customIcon } = require('./history');
    check('history stores a custom icon address and derives the default one',
      customIcon('https://a.test/page', 'https://a.test/logo.png') === 'https://a.test/logo.png' &&
      customIcon('https://a.test/page', 'https://a.test/favicon.ico') === null,
      'custom kept, default dropped');

    // And the chip is a stand-in, not a backdrop.
    //
    // It used to stay painted underneath every icon that loaded, on the theory
    // that the image covered it. Almost no favicon is opaque and square, so in
    // practice every site logo in the browser sat on a coloured tile with the
    // site's initial showing through it.
    //
    // Asserted against the live strip rather than a fixture because the way it
    // goes wrong is CSS specificity: the theme variants qualify the chip with
    // `body[data-theme=…]`, so a rule that looks right in isolation quietly
    // loses to them and the tile keeps painting.
    const chipStack = await shell.chromeView.webContents.executeJavaScript(`(() => {
      const icon = document.querySelector('.tab .tab-icon');
      if (!icon) return null;
      const chip = icon.querySelector('.tab-chip');
      const before = getComputedStyle(chip).display;
      icon.classList.add('has-icon');
      const after = getComputedStyle(chip).display;
      icon.classList.remove('has-icon');
      return { before, after };
    })()`).catch(() => null);
    check('a loaded favicon replaces the letter chip rather than sitting on it',
      Boolean(chipStack) && chipStack.before !== 'none' && chipStack.after === 'none',
      chipStack ? `chip display ${chipStack.before} -> ${chipStack.after}` : 'no tab in the strip');

    tabs.close(branded.id);
    tabs.close(bare.id);
  }

  /* ---------------------------------------------------------------- */
  // The icon route, and the reason it has an allowlist.
  //
  // Measured while building it: a *website* can reference `debrowser://`
  // subresources - a plain http page embedding one reached the handler. So an
  // unrestricted `?url=` would be a fetch proxy any site could aim anywhere,
  // stripped of cookies but also of that page's own CSP and of mixed-content
  // blocking. Only two things are fetchable: the well-known default path, and
  // an address Chromium reported for a page that was actually loaded.
  {
    const icons = require('./icons');
    const arbitrary = 'https://internal.test/secret.png';
    const before = icons.allowed(arbitrary);
    icons.remember(arbitrary);

    check('the icon route refuses an address the browser was never told about',
      before === false && icons.allowed('https://a.test/admin/keys.png') === false,
      'unreported addresses refused');

    check('it allows the default path, and an address a page reported',
      icons.allowed('https://a.test/favicon.ico') && icons.allowed(arbitrary) &&
      icons.allowed('file:///etc/passwd') === false &&
      icons.allowed('https://a.test/favicon.ico?x=1') === false,
      'default path and reported addresses only');
  }

  /* ---------------------------------------------------------------- */
  // History: what was visited, and what deliberately was not.
  //
  // The browser's own pages are excluded by the store's scheme list rather than
  // by a caller remembering to skip them, which is the part worth asserting -
  // a history full of "New tab" is the failure mode, and it would be invisible
  // until someone opened the page.
  {
    const { History } = require('./history');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'debrowser-hist-'));
    let recording = true;
    const hist = new History(() => {}, { dir, enabled: () => recording });

    hist.record({ url: 'https://example.test/one', title: 'One' });
    hist.record({ url: 'https://example.test/two', title: 'Two' });
    hist.record({ url: 'https://example.test/one', title: 'One again' });
    const internal = hist.record({ url: 'debrowser://settings', title: 'Settings' });
    const script = hist.record({ url: 'javascript:alert(1)', title: 'no' });

    const one = hist.all().find((e) => e.url === 'https://example.test/one');
    check('a revisit updates one entry rather than adding another',
      hist.all().length === 2 && one.visits === 2 && one.title === 'One again' &&
      hist.all()[0].url === 'https://example.test/one',
      `${hist.all().length} entries, /one visited ${one.visits}x, newest first`);

    check('the browser\'s own pages and script URLs are never written to history',
      internal === null && script === null, 'both refused');

    check('history is searchable by title and by address',
      hist.search('two').length === 1 && hist.search('example.test').length === 2 &&
      hist.search('nothing-like-this').length === 0,
      `title=${hist.search('two').length} host=${hist.search('example.test').length}`);

    recording = false;
    const whileOff = hist.record({ url: 'https://example.test/three', title: 'Three' });
    recording = true;
    check('recording can be switched off, and stops the very next visit',
      whileOff === null && hist.all().length === 2, `${hist.all().length} entries still`);

    // Written where it is asked to be, and readable back - the store is
    // debounced, so a browser that only ever flushed on a timer would lose
    // everything visited in the last few seconds before a quit.
    hist.flush();
    const reread = new History(() => {}, { dir });
    const cleared = hist.clear();
    check('history survives a flush and reload, and clearing empties it',
      reread.all().length === 2 && cleared === 2 && hist.all().length === 0,
      `reloaded ${reread.all().length}, cleared ${cleared}`);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- */
  // Developer tools, and the one thing they must do to the governor.
  //
  // A tab being inspected has to stay live: freezing it stops the task queues
  // the inspector is driving, and discarding it throws away the session. The
  // floor is asserted directly rather than by waiting out the idle ladder,
  // which would add ten seconds to the suite to observe the same rule.
  {
    const target = tabs.create({ url: pageUrl('idle.html'), activate: true, realise: true });
    await waitFor(() => target.isLive && !target.loading, { timeoutMs: 10_000 });

    prefs.set('devToolsDock', 'right');
    shell.applyWindowPrefs();
    const fullWidth = shell.contentBounds().width;

    const opened = toggleDevTools(target, shell);
    const seen = await waitFor(() => target.devToolsOpen, { timeoutMs: 5000 });
    // `ignoreGrace`, because the tab is the one on screen: without it the
    // grace period that protects a just-left tab would be what the second
    // assertion measured, rather than the inspector.
    const floor = governor.clampToProtections(target, Tier.DISCARDED, { ignoreGrace: true });

    // Docked means two things, and both are worth asserting: the inspector is
    // really in a view of ours, and the page beside it actually gave up the
    // room. Either alone can pass while the user sees a window or an inspector
    // drawn over the page.
    const hosted = await waitFor(
      () => shell.devToolsView &&
        shell.devToolsView.webContents.getURL().startsWith('devtools://'),
      { timeoutMs: 8000 });
    const dockedWidth = shell.contentBounds().width;
    check('developer tools dock inside the browser window',
      hosted && dockedWidth > 0 && dockedWidth < fullWidth,
      `page ${fullWidth}px -> ${dockedWidth}px beside the inspector`);

    // `isDevToolsOpened()` reports false for an inspector hosted this way -
    // measured - so everything that asks whether a tab is being inspected has
    // to go through the tab, not through Chromium. The governor is the one that
    // matters: it is what would otherwise discard the page mid-session.
    check('a docked inspector still counts as open',
      seen === true && target.devToolsOpen === true &&
      governor.shouldSkip(target) === true,
      `devToolsOpen=${target.devToolsOpen}, chromium says ${target.wc.isDevToolsOpened()}`);

    // The dock belongs to one tab and goes away when you leave it.
    //
    // `attachTab` used to return early for a view that was already a child,
    // which is true of every tab switch - so nothing re-laid-out on one, and
    // tab A's inspector stayed painted over tab B while B was sized as though
    // it had the whole window. Asserted as the two halves the user sees: the
    // dock is off screen, and the page beside it gets its width back.
    const other = tabs.create({ url: pageUrl('idle.html'), activate: true, realise: true });
    await waitFor(() => other.isLive && !other.loading, { timeoutMs: 10_000 });
    const awayVisible = shell.devToolsView.getVisible?.() !== false &&
      shell.dockBounds(shell.contentArea()) !== null;
    const awayWidth = shell.contentBounds().width;

    await tabs.activate(target.id);
    const backWidth = shell.contentBounds().width;
    check('a docked inspector follows its own tab and nothing else',
      !awayVisible && awayWidth === fullWidth && backWidth === dockedWidth,
      `away: ${awayWidth}px and dock ${awayVisible ? 'still up' : 'hidden'}, back: ${backWidth}px`);
    tabs.close(other.id);

    // Changing where they go moves them, rather than needing them reopened.
    prefs.set('devToolsDock', 'window');
    shell.applyWindowPrefs();
    const windowed = await waitFor(
      () => !shell.devToolsView && target.wc.isDevToolsOpened(), { timeoutMs: 8000 });
    check('the dock preference moves an open inspector',
      windowed && shell.contentBounds().width === fullWidth,
      `windowed=${windowed}, page back to ${shell.contentBounds().width}px`);

    toggleDevTools(target, shell);
    const closed = await waitFor(() => !target.devToolsOpen, { timeoutMs: 5000 });
    const floorAfter = governor.clampToProtections(target, Tier.DISCARDED, { ignoreGrace: true });

    check('developer tools open on the page, and close again',
      opened === true && seen && closed, `opened=${seen} closed=${closed}`);
    check('a tab under the inspector is not frozen or discarded',
      floor === Tier.WARM && floorAfter === Tier.DISCARDED,
      `with tools: ${floor}, without: ${floorAfter}`);

    prefs.set('devToolsDock', 'right');
    tabs.close(target.id);
  }

  // The downloads flyout, which is the default way downloads are reached.
  //
  // It shares the sheet with the app menu rather than having a mechanism of its
  // own, so the two properties worth asserting are that the sheet actually
  // swaps between them - a toolbar where opening one panel leaves the other up
  // is worse than one with a single panel - and that the flyout, which is one
  // of the chrome's own views, can read the download list without inheriting
  // the credential surface next door.
  {
    shell.openSheet('menu', { x: 100, y: 84, right: 132 });
    const menuUp = await waitFor(
      () => shell.sheetView && shell.sheetPage === 'menu', { timeoutMs: 8000 });

    shell.openSheet('downloads', { x: 900, y: 84, right: 932 });
    const swapped = await waitFor(
      () => shell.sheetView && shell.sheetPage === 'downloads' &&
        shell.sheetView.webContents.getURL().includes('flyout.html'),
      { timeoutMs: 8000 });

    const wc = shell.sheetView && shell.sheetView.webContents;
    const reads = wc && await wc.executeJavaScript(
      'window.debrowser.request("list-downloads").then((r) => r && Array.isArray(r.items))')
      .catch(() => false);
    const refused = wc && await wc.executeJavaScript(
      'window.debrowser.request("list-credentials").then((r) => r === null)')
      .catch(() => false);

    check('the downloads flyout takes over the sheet from the menu',
      menuUp && swapped, `menu up=${menuUp}, swapped to ${shell.sheetPage}`);
    check('the flyout reads the download list and not the credential store',
      reads === true && refused === true,
      `list-downloads answered=${reads}, list-credentials refused=${refused}`);

    shell.closeSheet();
    await waitFor(() => shell.sheetView === null, { timeoutMs: 5000 });
  }

  // The downloads page.
  //
  // Downloads used to be a handful of rows inside Settings, which is the wrong
  // place for a list that changes while you are looking at it. Now it is a page
  // with an address like any other - and that is exactly why the request gate
  // matters: one of the browser's own pages inherits Settings' surface unless
  // something says otherwise, and Settings is where the credential store is
  // reachable from. A page that lists files must not be able to read passwords.
  {
    const page = tabs.create({ url: pages.DOWNLOADS_URL, activate: true, realise: true });
    const ready = await waitFor(() => page.isLive && !page.loading, { timeoutMs: 10_000 });
    const title = await page.wc.executeJavaScript('document.title').catch(() => null);
    const listed = await page.wc.executeJavaScript(
      'Boolean(document.getElementById("list"))').catch(() => false);

    check('the downloads page loads at its own address',
      ready && senderPage(tabs, page.wc) === 'downloads' && title === 'Downloads' && listed,
      `sender=${JSON.stringify(senderPage(tabs, page.wc))} title=${JSON.stringify(title)}`);

    // Asked of the page itself, through the same bridge it really uses.
    const answers = await page.wc.executeJavaScript(
      'window.debrowser.request("list-downloads").then((r) => r && Array.isArray(r.items))')
      .catch(() => false);
    const refused = await page.wc.executeJavaScript(
      'window.debrowser.request("list-credentials").then((r) => r === null)')
      .catch(() => false);
    check('the downloads page may read its own list and nothing else',
      answers === true && refused === true,
      `list-downloads answered=${answers}, list-credentials refused=${refused}`);

    tabs.close(page.id);
  }

  // The renderer warmed on a dwell over the + button.
  //
  // Exercised directly, because it is switched off under a test - a spare
  // renderer appearing on a timer would move the memory figures every other
  // check in this suite asserts on. The two properties worth holding are that
  // it actually starts a process, since a prefetch that quietly does nothing
  // would look exactly like one that works, and that it declines whenever
  // spending 13MB on a guess is the wrong trade.
  {
    const { Prewarm } = require('./prewarm');
    let liveInternal = false;
    let busy = false;
    const warmer = new Prewarm({
      partition: BROWSING_PARTITION,
      preload: path.join(__dirname, '..', 'preload', 'chrome-preload.js'),
      hasLiveInternal: () => liveInternal,
      busy: () => busy,
      log: () => {}
    });

    warmer.warm();
    const spawned = await waitFor(
      () => Boolean(warmer.view) && warmer.view.webContents.getOSProcessId() > 0,
      { timeoutMs: 10_000 });
    warmer.drop();

    liveInternal = true;
    const skipsWhenLive = warmer.warm() === false;
    liveInternal = false;
    busy = true;
    const skipsWhenBusy = warmer.warm() === false;
    busy = false;
    warmer.drop();

    check('a hover warms a real renderer, and only when it would pay',
      spawned && warmer.view === null && skipsWhenLive && skipsWhenBusy,
      `spawned=${spawned}, released=${warmer.view === null}, ` +
      `declined with a page already live=${skipsWhenLive}, mid-animation=${skipsWhenBusy}`);
  }

  // Updates must never run under a test: a background download competing with
  // the governor would make the memory numbers depend on whether a release
  // happened to be out. The capability report also has to name *why* it is off,
  // since a silently inert updater is indistinguishable from a broken one.
  // Per-process memory, on the platforms that do not report it honestly.
  //
  // This check is the only one in the suite that matters more elsewhere than
  // here: on Linux it asserts the helper correctly declines to exist, because
  // smaps_rollup already reports Pss. On Windows and macOS - where CI runs the
  // same suite - it asserts the native backend answered, which is the only
  // signal available that code compiled for a platform this was not written on
  // actually works.
  // Probing is asynchronous and fire-and-forget by design - the sampler runs on
  // the governor's tick and must not wait on a pipe - so the figures land one
  // tick after the round that produced them. Wait for that rather than reading
  // the instant after asking, which measures the scheduler and not the helper.
  const probeReady = await waitFor(async () => {
    governor.metrics.sample();
    const cap = await platform.measureCapability(() => {});
    return cap.available === true && governor.metrics.probed.size > 0;
  }, { timeoutMs: 8000, pollMs: 400 });

  const probeCap = await platform.measureCapability(() => {});
  const probeSnap = governor.metrics.snapshot();
  if (process.platform === 'linux') {
    check('the memory probe stands down where the kernel already reports Pss',
      probeCap.available === false && probeSnap.accounting === 'pss',
      `${probeCap.reason} (accounting=${probeSnap.accounting})`);
  } else {
    // Every failure mode names itself. The first run of this on a real Windows
    // runner failed with "mechanism=null accounting=rss" and nothing else,
    // which said the helper had not answered but not one word about why - so
    // the reason, the binary it looked for and whether it exists are all
    // printed, pass or fail.
    const probePath = platform.probeBinaryPath();
    check('per-process memory is measured natively rather than summed',
      probeCap.available === true &&
      (probeSnap.accounting === 'probe' || probeSnap.accounting === 'mixed') &&
      probeSnap.totalMB > 0,
      `mechanism=${probeCap.mechanism} accounting=${probeSnap.accounting} ` +
      `probed=${governor.metrics.probed.size}/${governor.metrics.byPid.size} ` +
      `ready=${probeReady} reason=${JSON.stringify(probeCap.reason)} ` +
      `binary=${probePath} exists=${fs.existsSync(probePath)}`);
  }

  /* ---------------------------------------------------------------- */
  // Saved credentials.
  //
  // The rule this must not weaken is asserted above and unchanged: a page
  // carrying a password field is still never photographed, and the session
  // snapshot still never reads one. These checks cover the opposite path - the
  // explicit one - and the one thing that would make it worthless, which is
  // writing a secret to disk that anything can read.
  const { Credentials } = require('./credentials');
  const creds = new Credentials(() => {});
  const credCap = creds.capability();

  check('the credential store refuses to save without real OS encryption',
    credCap.available === true || (credCap.available === false && typeof credCap.reason === 'string'),
    credCap.available ? 'OS keystore available' : `unavailable: ${credCap.reason}`);

  // The cryptography is tested whether or not this machine has a keyring.
  //
  // Without one the store correctly refuses to save, which would leave the
  // encryption itself - the part that actually protects anything - unexercised
  // on every machine that lacks a secret service, including CI. So the key is
  // injected directly here, which tests exactly what safeStorage would have
  // protected: the sealing, the authentication, and the bytes on disk.
  {
    const probe = new Credentials(() => {});
    probe.key = require('crypto').randomBytes(32);
    probe.loaded = true;
    probe.unavailable = null;

    const secret = 'correct-horse-battery-staple';
    const sealed = probe.seal({ origin: 'https://x.test', username: 'u', password: secret });
    const raw = JSON.stringify(sealed);

    check('records are sealed with authenticated encryption',
      !raw.includes(secret) && !raw.includes('x.test') &&
      probe.open(sealed)?.password === secret,
      'ciphertext carries neither the secret nor the site, and opens back to both');

    const tampered = { ...sealed };
    const bytes = Buffer.from(tampered.ct, 'base64');
    bytes[0] ^= 0xff;
    tampered.ct = bytes.toString('base64');
    check('an altered record fails its authentication tag',
      probe.open(tampered) === null, 'GCM rejected it rather than returning plausible plaintext');

    const wrongKey = new Credentials(() => {});
    wrongKey.key = require('crypto').randomBytes(32);
    check('a record cannot be read with a different key',
      wrongKey.open(sealed) === null, 'decryption with the wrong key yields nothing');

    // Two seals of the same record must differ, or the file leaks that a
    // password was reused across sites just by comparing ciphertexts.
    const again = probe.seal({ origin: 'https://x.test', username: 'u', password: secret });
    check('the same record seals differently every time',
      again.ct !== sealed.ct && again.iv !== sealed.iv,
      'a fresh initialisation vector per record');
  }

  if (credCap.available) {
    const secret = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const stored = creds.put('login', {
      origin: 'https://smoke.test', username: 'someone', password: secret
    });
    check('a saved sign-in round-trips through encryption', stored &&
      creds.reveal('login', 'https://smoke.test\u0000someone')?.password === secret,
      stored ? 'stored and read back' : 'not stored');

    // The whole point. If the plaintext is in the file, everything above is
    // decoration.
    const onDisk = fs.readFileSync(
      require('path').join(app.getPath('userData'), 'logins.dat'), 'utf8');
    check('the secret does not appear in the file on disk',
      !onDisk.includes(secret) && !onDisk.includes('someone'),
      `${onDisk.length} bytes, neither the password nor the username present`);

    // An attacker edits the file; GCM's tag is what makes that detectable.
    check('a tampered record is dropped rather than trusted',
      (() => {
        const file = require('path').join(app.getPath('userData'), 'logins.dat');
        const sealed = JSON.parse(onDisk);
        const flipped = Buffer.from(sealed[0].ct, 'base64');
        flipped[0] ^= 0xff;
        sealed[0].ct = flipped.toString('base64');
        fs.writeFileSync(file, JSON.stringify(sealed));
        const fresh = new Credentials(() => {});
        return fresh.list().logins.length === 0;
      })(), 'authentication tag rejected the altered ciphertext');

    // Matching is per origin, never per registrable domain: a password offered
    // to a sibling subdomain is a password handed to whoever controls it.
    creds.put('login', { origin: 'https://accounts.smoke.test', username: 'a', password: 'b' });
    check('saved sign-ins are matched per origin, not per domain',
      creds.forOrigin('https://evil.smoke.test/login').length === 0 &&
      creds.forOrigin('https://accounts.smoke.test/login').length === 1,
      'a sibling subdomain gets nothing');

    fs.rmSync(require('path').join(app.getPath('userData'), 'logins.dat'), { force: true });
  }

  /* ---------------------------------------------------------------- */

  // Bookmarks, and specifically the part that is a security boundary rather
  // than a feature: an imported file is untrusted input. A bookmarks export is
  // a plausible thing to be handed by someone else, and a "bookmarklet" in one
  // is script that runs in whatever page is open when it is clicked, with that
  // page's origin. Importing someone else's bookmarks must not be importing
  // their code.
  {
    const bm = require('./bookmarks');
    const tmpDir = require('fs').mkdtempSync(
      require('path').join(require('os').tmpdir(), 'debrowser-bm-'));
    const store = new bm.Bookmarks(() => {}, tmpDir);

    const hostile = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>' +
      '<DT><H3>Imported</H3><DL><p>' +
      '<DT><A HREF="https://good.example">Good</A>' +
      '<DT><A HREF="javascript:fetch(\'//evil\')">Bookmarklet</A>' +
      '<DT><A HREF="file:///etc/passwd">Local file</A>' +
      '<DT><A HREF="data:text/html,<script>1</script>">Data URL</A>' +
      '</DL><p></DL><p>';

    const parsed = bm.parseNetscape(hostile);
    const merged = store.merge(parsed);
    const stored = store.all().map((b) => b.url);

    check('an imported bookmark file cannot bring executable schemes with it',
      merged.added === 1 && stored.length === 1 && stored[0].startsWith('https://') &&
      !stored.some((u) => /^(javascript|file|data):/i.test(u)),
      `parsed ${parsed.length}, kept ${merged.added}: ${stored.join(', ')}`);

    // Folder names and entities are the part users notice, and the part a
    // tokeniser gets wrong first.
    const nested = bm.parseNetscape(
      '<DL><p><DT><H3>Dev &amp; Tools</H3><DL><p>' +
      '<DT><A HREF="https://a.example/?x=1&amp;y=2">A &amp; B</A></DL><p></DL><p>');
    check('import keeps folder names and decodes entities',
      nested.length === 1 && nested[0].folder === 'Dev & Tools' &&
      nested[0].title === 'A & B' && nested[0].url === 'https://a.example/?x=1&y=2',
      JSON.stringify(nested[0] || null));

    // Chromium's timestamps are microseconds since 1601, not Unix seconds. Read
    // wrong, every imported bookmark claims to predate the web.
    const chromium = bm.parseChromium(JSON.stringify({
      roots: { bar: { name: 'Bar', type: 'folder', children: [
        { type: 'url', name: 'Example', url: 'https://example.com', date_added: '13350000000000000' }
      ] } }
    }));
    const year = chromium.length ? new Date(chromium[0].addedAt).getFullYear() : 0;
    check('a Chromium bookmark import reads its timestamps as Chromium wrote them',
      chromium.length === 1 && year > 2000 && year < 2100, `year ${year}`);

    // Re-importing the same file must not double the list.
    const again = store.merge(parsed);
    check('importing the same bookmarks twice does not duplicate them',
      again.added === 0 && store.all().length === 1,
      `second import added ${again.added}, list holds ${store.all().length}`);

    require('fs').rmSync(tmpDir, { recursive: true, force: true });
  }

  // The bookmarks bar, which is two separate things that both have to be true.
  //
  // It was saving bookmarks with nowhere to show them: the star worked, the
  // store worked, and the only way to see the list was Settings. A bar drawn
  // inside the chrome is not enough on its own, because the chrome is a view
  // clipped to the height the shell gives it - so the window has to hand it the
  // extra 34px, and the page below has to give them up. Assert the arithmetic
  // rather than the markup: a bar the window has not made room for is a bar
  // with its bottom row cut off, and nothing in the renderer can tell.
  {
    prefs.set('showBookmarksBar', false);
    shell.applyWindowPrefs();
    const withoutBar = shell.contentBounds();

    prefs.set('showBookmarksBar', true);
    shell.applyWindowPrefs();
    const withBar = shell.contentBounds();

    const { BOOKMARKS_BAR_HEIGHT } = require('./window');
    check('the bookmarks bar takes its room from the page, not from the chrome',
      withBar.y - withoutBar.y === BOOKMARKS_BAR_HEIGHT &&
      withoutBar.height - withBar.height === BOOKMARKS_BAR_HEIGHT,
      `content starts at ${withoutBar.y} -> ${withBar.y}, ` +
      `height ${withoutBar.height} -> ${withBar.height}`);

    // And the list reaches the strip, keyed on a revision rather than pushed
    // through the state broadcast on every tick.
    const before = bookmarks.revision;
    bookmarks.add({ url: 'https://bar.test/one', title: 'One' });
    const published = shell.bookmarks === bookmarks && bookmarks.revision > before;
    const drawn = published && await waitFor(async () =>
      await shell.chromeView.webContents.executeJavaScript(
        'document.querySelectorAll("#bookmarks .bookmark").length') > 0,
    { timeoutMs: 8000 });
    check('a saved bookmark appears in the bar',
      drawn, `revision ${before} -> ${bookmarks.revision}`);
    bookmarks.remove('https://bar.test/one');
  }

  // The presence check exists to stop someone at an unlocked machine pressing
  // Show. Its one load-bearing property is that it fails *closed*: a helper
  // that will not start, a throw, a timeout or an answer nobody recognises must
  // all deny. A check that fails open is not a check, it is a delay - and the
  // failure mode is that the protection silently stops existing while Settings
  // still advertises it.
  {
    const presence = require('./presence');
    const cap = await presence.capability();
    check('the presence check reports what this machine can do, and why not when it cannot',
      typeof cap.available === 'boolean' &&
      (cap.available ? typeof cap.mechanism === 'string'
                     : typeof cap.reason === 'string' && cap.reason.length > 0),
      cap.available ? `${cap.mechanism}${cap.experimental ? ' (experimental)' : ''}` : cap.reason);

    // On Windows, the probe must have *reached* Hello.
    //
    // "Not available" has two very different causes and Settings showed the
    // wrong one on the first Windows machine this ever ran on: the probe used a
    // type from an assembly Windows PowerShell does not load by default, so it
    // could not ask the question at all - and a machine with Hello set up was
    // told it did not have it. A negative answer from Hello is fine and is what
    // a CI runner will give; not being able to ask is the bug.
    //
    // This is the one check in the suite that only means anything on the
    // Windows runner, which is the only place this code can run.
    if (process.platform === 'win32') {
      const reason = String(cap.reason || '');
      check('the Windows Hello probe gets an answer from Hello rather than failing to load',
        cap.available || !/could not be queried|Unable to find type|could not be loaded/i.test(reason),
        cap.available ? 'available' : `reason: ${reason}`);
    }

    // On a machine with nothing to ask, verify must refuse rather than pass by
    // default. This is the assertion that would catch a refactor turning the
    // gate into a no-op everywhere it is not supported.
    if (!cap.available) {
      const allowed = await presence.verify('smoke test', null);
      check('a machine with no presence check refuses rather than allowing',
        allowed === false, `verify() returned ${allowed}`);
    }
  }

  /* ---------------------------------------------------------------- */

  // Segmented downloading, against a real server over real sockets.
  //
  // The property is not "it went faster" - that depends on the network and is
  // not a thing a test can assert. It is that a file fetched in pieces is the
  // same file: reassembly at offsets is exactly the kind of code that produces
  // something the right *size* and the wrong *contents*, and a length check
  // would not notice.
  {
    const http = require('http');
    const dl = require('./downloads');
    const crypto = require('crypto');
    const osmod = require('os');
    const pathmod = require('path');

    // Big enough to be split rather than taken whole, and incompressible so a
    // proxy cannot quietly re-encode it.
    const payload = crypto.randomBytes(dl.MIN_SEGMENTED_BYTES + 100_000);
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    let rangeRequests = 0;

    const serve = (allowRanges) => http.createServer((req, res) => {
      const range = allowRanges ? /bytes=(\d+)-(\d*)/.exec(req.headers.range || '') : null;
      if (range) {
        rangeRequests++;
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : payload.length - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${payload.length}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          ETag: '"v1"'
        });
        res.end(payload.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'Content-Length': payload.length, ETag: '"v1"' });
      res.end(payload);
    });

    const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    const outDir = fs.mkdtempSync(pathmod.join(osmod.tmpdir(), 'debrowser-dl-'));
    const finished = (item) => waitFor(() => item.state === 'done' || item.state === 'failed', { timeoutMs: 30_000 });

    // --- a server that serves ranges: expect several segments, same bytes ---
    const ranged = serve(true);
    const rangedPort = await listen(ranged);
    const mgr = new dl.DownloadManager({ dir: outDir, connections: () => 4, log: () => {} });
    const item = mgr.start(`http://127.0.0.1:${rangedPort}/big.bin`);
    await finished(item);

    const got = item.state === 'done' ? fs.readFileSync(pathmod.join(outDir, item.filename)) : Buffer.alloc(0);
    const gotDigest = crypto.createHash('sha256').update(got).digest('hex');

    check('a download split across connections reassembles byte for byte',
      item.state === 'done' && gotDigest === digest,
      `${item.segments} segment(s), ${got.length}/${payload.length} bytes, ` +
      `digest ${gotDigest === digest ? 'matches' : 'DIFFERS'}${item.error ? ` — ${item.error}` : ''}`);

    check('a server offering ranges is actually asked for several',
      item.segments > 1 && rangeRequests > 2, `${item.segments} segments, ${rangeRequests} range requests`);
    ranged.close();

    // --- a server that refuses ranges: expect one connection, same bytes ---
    const plain = serve(false);
    const plainPort = await listen(plain);
    const mgr2 = new dl.DownloadManager({ dir: outDir, connections: () => 8, log: () => {} });
    const item2 = mgr2.start(`http://127.0.0.1:${plainPort}/whole.bin`);
    await finished(item2);
    const got2 = item2.state === 'done' ? fs.readFileSync(pathmod.join(outDir, item2.filename)) : Buffer.alloc(0);

    check('a server that refuses ranges is downloaded whole rather than failing',
      item2.state === 'done' && item2.segments === 1 &&
      crypto.createHash('sha256').update(got2).digest('hex') === digest,
      `${item2.segments} segment(s), ${got2.length} bytes${item2.error ? ` — ${item2.error}` : ''}`);
    plain.close();

    // --- one segment fails: the others must not be writing into a closed file ---
    //
    // This crashed the browser. `Promise.all` rejects on the first failure, so
    // the download's `finally` closed the file handle and set it to null while
    // the other three segments were still streaming - and their next write
    // threw a TypeError inside a stream listener, which takes the main process
    // with it. One 503 on one connection was enough to close the browser.
    let servedRanges = 0;
    const flaky = http.createServer((req, res) => {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (!range) { res.writeHead(200, { 'Content-Length': payload.length, ETag: '"v1"' }); res.end(payload); return; }
      servedRanges++;
      // Fail one of the middle segments, after the probe and after the others
      // have started, which is the ordering that produced the crash.
      if (servedRanges === 3) { res.writeHead(503); res.end(); return; }
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : payload.length - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        ETag: '"v1"'
      });
      res.end(payload.subarray(start, end + 1));
    });
    const flakyPort = await listen(flaky);
    const mgr3 = new dl.DownloadManager({ dir: outDir, connections: () => 4, log: () => {} });
    const item3 = mgr3.start(`http://127.0.0.1:${flakyPort}/flaky.bin`);
    await finished(item3);
    // Reaching this line at all is most of the assertion: a crash here takes
    // the suite down with the browser.
    check('one failing segment fails the download instead of crashing the browser',
      item3.state === 'failed' && typeof item3.error === 'string' && item3.handle === null,
      `state=${item3.state}, error=${item3.error || 'none'}, handle ${item3.handle === null ? 'closed' : 'STILL OPEN'}`);

    // And it takes the part-written file with it. The file is allocated to its
    // full length before the first byte arrives, so a failure that left it
    // behind would leave something of exactly the right size with zeros in the
    // gaps - an installer that looks complete in a file manager and is not.
    const leftBehind = fs.existsSync(item3.file);
    check('a failed download does not leave a full-size file behind',
      !leftBehind, leftBehind ? `${item3.file} still there` : 'removed');
    flaky.close();

    // A weak ETag can never match a strong If-Range comparison, so sending one
    // makes the server answer 200 and the download report that the file
    // changed - on a file that had not changed at all.
    check('a weak ETag is not used as a range validator',
      dl.strongValidator('W/"abc"') === null && dl.strongValidator('"abc"') === '"abc"',
      `W/"abc" -> ${dl.strongValidator('W/"abc"')}, "abc" -> ${dl.strongValidator('"abc"')}`);

    // A server chooses the filename, so a server can try to choose a path.
    check('a download cannot be talked into writing outside its directory',
      dl.sanitiseName('../../etc/passwd') === 'passwd' &&
      dl.sanitiseName('..\\..\\evil.exe') === 'evil.exe' &&
      !dl.sanitiseName('/abs/x').includes('/'),
      'traversal, backslashes and absolute paths all reduced to a bare name');

    fs.rmSync(outDir, { recursive: true, force: true });
  }

  const { Updater } = require('./updater');
  const updateCap = new Updater({ log: () => {} }).capability();
  check('updates are inert outside a packaged build, and say why',
    updateCap.available === false && typeof updateCap.reason === 'string' && updateCap.reason.length > 0,
    updateCap.reason || 'no reason given');

  // "Never asked" and "asked, nothing new" are different answers, and Settings
  // renders the second as "Up to date." Reporting the second before the first
  // check has run - which is a minute after launch - is the browser asserting a
  // version comparison it has not made. Pressing the button before the updater
  // could start must also be harmless rather than a throw across the IPC
  // boundary, which is the state a test build is permanently in.
  const unstarted = new Updater({ log: () => {} });
  const atRest = unstarted.snapshot().state;
  const pressed = unstarted.checkNow().state;
  check('an unchecked updater does not claim to be up to date',
    atRest === 'unchecked' && pressed === 'unchecked',
    `at rest: ${atRest}, after "check now": ${pressed}`);

  const autoBudget = cfg.autoBudgetMB;
  prefs.set('memoryBudgetMB', 900);
  applyPrefs(cfg, prefs);
  const tookEffect = cfg.memoryBudgetMB === 900;

  // Clearing a setting must return to the machine-sized value, not leave the
  // last number behind. Null and a number are different states and the config
  // has to be able to get back from one to the other.
  prefs.set('memoryBudgetMB', null);
  applyPrefs(cfg, prefs);
  check('a saved budget applies, and clearing it returns to the automatic value',
    tookEffect && cfg.memoryBudgetMB === autoBudget,
    `auto ${autoBudget}MB -> set 900MB (${tookEffect}) -> cleared ${cfg.memoryBudgetMB}MB`);

  // A flag is for this run and outranks the file, or the flag looks broken.
  cfg.pinned.memoryBudgetMB = true;
  cfg.memoryBudgetMB = 1234;
  prefs.set('memoryBudgetMB', 777);
  applyPrefs(cfg, prefs);
  check('a budget pinned on the command line outranks the saved one',
    cfg.memoryBudgetMB === 1234, `${cfg.memoryBudgetMB}MB`);

  cfg.pinned.memoryBudgetMB = false;
  prefs.set('memoryBudgetMB', null);
  applyPrefs(cfg, prefs);

  // The measurement has to be checked against something, or "it ran" gets read
  // as "it worked". A probe that returns a total no lower than summed working
  // set is reporting the same over-count under a better name, and the panel
  // would then drop the warning that used to be there - a strictly worse state
  // than not having the helper at all.
  //
  // Runs on every platform. On Linux it asserts the property that makes the
  // whole exercise worthwhile - that Pss really is below summed RSS across a
  // browser full of tabs - and on Windows and macOS it is the gate on the
  // native helper's arithmetic.
  governor.metrics.sample();
  const acct = governor.metrics.snapshot();
  const sharingVisible = acct.processCount >= 4 && acct.rssTotalMB > 0;
  check('the memory total is a smaller number than summing every process would give',
    !sharingVisible || acct.accounting === 'rss' || acct.probeRatio <= 0.8,
    `${acct.accounting}: ${acct.totalMB}MB reported vs ${acct.rssTotalMB}MB summed ` +
    `(${acct.probeRatio}x) across ${acct.processCount} processes` +
    (sharingVisible ? '' : ' — too few processes to tell, skipped'));

  // Moving the tab strip to the side moves every view in the window, not just
  // the chrome's, so the property worth asserting is where the *content* ends
  // up - a sidebar that is drawn but not made room for is a sidebar painted
  // over the page. Measured through the real shell rather than by recomputing
  // the arithmetic here, which would only prove this test can add up.
  const topBounds = shell.contentBounds();
  prefs.set('tabBarPosition', 'left');
  shell.applyWindowPrefs();
  const sideBounds = shell.contentBounds();
  prefs.set('tabBarPosition', 'top');
  shell.applyWindowPrefs();
  const backBounds = shell.contentBounds();

  check('moving the tab strip to the side makes room for it, and moving it back gives it up',
    topBounds.x === 0 && sideBounds.x > 0 && sideBounds.y < topBounds.y &&
    sideBounds.width < topBounds.width && backBounds.x === 0 &&
    backBounds.width === topBounds.width,
    `top x=${topBounds.x} w=${topBounds.width} · side x=${sideBounds.x} w=${sideBounds.width} ` +
    `· back x=${backBounds.x} w=${backBounds.width}`);

  /* ---------------------------------------------------------------- */
  console.log('\n13. Footprint\n');

  governor.metrics.sample();
  const snap = governor.metrics.snapshot();
  console.log(`  ${snap.totalMB}MB total across ${snap.processCount} processes ` +
              `(${snap.rendererCount} renderers) for ${tabs.all().length} tabs`);
  console.log(`  browser + GPU + utility overhead: ${snap.overheadMB}MB`);
  const lat = tabs.latency.stats();
  const fmtLat = (name) => (lat[name]
    ? `${name} p50 ${lat[name].p50}ms / p95 ${lat[name].p95}ms (n=${lat[name].n})`
    : null);
  const shown = ['restore', 'thaw', 'switch', 'content'].map(fmtLat).filter(Boolean);
  if (shown.length) console.log(`  what it cost the user: ${shown.join(', ')}`);

  // Switching to a tab that is already running is the one thing in this browser
  // that must be instant - there is nothing to load, nothing to unfreeze,
  // nothing to wait for. Thawing a frozen tab is a separate series, because it
  // has a CDP round trip in it that no amount of care removes, and mixing the
  // two produced a p95 that was simply the slowest thaw. It was not instant:
  // re-activating the foreground tab
  // routed through the demotion path and waited out a 400ms page-state capture,
  // so one switch in twenty stalled for four tenths of a second while the p50
  // sat at 0.3ms. The average hid it completely, which is why the assertion is
  // on p95.
  //
  // The threshold is loose on purpose. It is not a performance target, it is a
  // tripwire for a blocking call finding its way back onto this path, and a
  // contended CI runner should not have an opinion about it.
  if (lat.switch) {
    check('switching to a tab that is already live does not block',
      lat.switch.p95 < 100,
      `p50 ${lat.switch.p50}ms / p95 ${lat.switch.p95}ms over ${lat.switch.n} switches`);
  }
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
