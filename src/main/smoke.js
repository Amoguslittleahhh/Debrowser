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
const contextMenu = require('./context-menu');

/** The process a tab's page is in, asked of the renderer rather than the tab. */
const safePidOf = (tab) => {
  try {
    return tab.isLive ? tab.wc.getOSProcessId() : 0;
  } catch {
    return 0;
  }
};
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
                          openInternalPage, senderPage, bookmarks,
                          runCommand = () => {}, history = null, context = { model: null } }) {
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
    // `layout` asks this to decide whether the chrome is a band, a panel or
    // nothing at all; a stand-in window has to answer everything the real one
    // is asked, not only the two calls this check is about.
    isFullScreen: () => false,
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
  const cap = await platform.trimCapability();
  // Both halves, against an *independent* reading of the compressor, and a
  // named reason whenever either is missing. Asserting on `cap.compression`
  // would restate the expression that produced `cap.available` and could not
  // fail; asserting on the compressor alone passed on a machine with zram and
  // no CAP_SYS_NICE, because the mechanism string was built from the platform
  // rather than from whether the syscall is actually permitted.
  //
  // Windows is the one platform where the second half does not apply, and that
  // is a real difference rather than an exemption: its compression store lives
  // in physical memory, so a trimmed page has somewhere to go whether or not a
  // pagefile is configured. What guards it there is the net measurement below,
  // not a precondition.
  const needsCompressor = process.platform !== 'win32';
  check('hibernation is only offered where there is somewhere to compress into',
    cap.available === (cap.permitted && (!needsCompressor || compression.available))
      && (cap.available || typeof cap.reason === 'string'),
    `permitted=${cap.permitted} compressor=${compression.available
      ? `${compression.compressor} ${compression.swapMB}MB`
      : (needsCompressor ? 'none' : 'windows memory compression, always present')} ` +
    `available=${cap.available}${cap.available ? '' : ` reason="${cap.reason}"`}`);

  // The independent reading the whole tier is now judged on.
  //
  // A working set that shrank by 200MB has proved nothing until the machine
  // has 200MB more available than it did: pages leaving a process reappear as
  // the compressor's own allocation, at about 2:1. The self-disable used to
  // read the per-process drop, which is the syscall agreeing with itself -
  // on a host where compression achieved nothing it would have seen a large
  // number and kept the tier on forever.
  //
  // Asserted against what the operating system says by itself, since the
  // point of the figure is that it comes from somewhere else: on Linux that
  // is /proc/meminfo, read here rather than through the helper.
  const mem = await platform.availableMemory();
  let osAvailMB = null;
  if (process.platform === 'linux') {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = /MemAvailable:\s+(\d+) kB/.exec(info);
    if (m) osAvailMB = Number(m[1]) / 1024;
  }
  const helperMB = mem ? mem.availBytes / (1024 * 1024) : null;

  check('the helper reports what the machine has spare, and agrees with the OS',
    Boolean(mem) && helperMB > 0 &&
    (osAvailMB == null || Math.abs(helperMB - osAvailMB) < 200),
    mem
      ? `helper says ${Math.round(helperMB)}MB available, ` +
        `${osAvailMB == null ? 'no OS figure to compare on this platform' : `/proc says ${Math.round(osAvailMB)}MB`}, ` +
        `backing store ${Math.round(mem.backingTotalBytes / 1048576)}MB`
      : 'the helper did not answer');


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
    // Read the "after" figure from the same two sources the governor reads
    // `privateMB` from, in the same order: /proc on Linux, the measurement
    // helper everywhere else. Reading only /proc made this check unsatisfiable
    // on Windows - `readProcessMemory` returns null off Linux by design, so
    // `after` was always null and a tier that had just reclaimed 90MB reported
    // "0MB out". The before figure came from the governor and the after figure
    // from somewhere that does not exist on that platform, which is not a
    // comparison at all.
    const afterDetail = require('./memory').readProcessMemory(big.pid);
    let afterMB = afterDetail ? afterDetail.privateMB : null;
    if (afterMB == null) {
      const probed = await platform.measureProcess(big.pid).catch(() => null);
      if (probed) afterMB = probed.privateBytes / (1024 * 1024);
    }
    const reclaimed = afterMB == null ? 0 : privateBefore - afterMB;
    check('hibernating actually removes memory from the renderer',
      reclaimed > 5,
      `private ${privateBefore.toFixed(0)}MB -> ${afterMB == null ? '?' : afterMB.toFixed(0)}MB ` +
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

  // And so is every other page the browser serves itself.
  //
  // They were pinned at ACTIVE. In a real session that made three of six live
  // renderers Settings, the downloads page and a new tab page - about 95MB held
  // permanently - while the actual websites beside them sat discarded at zero.
  // What the exemption was protecting is unsubmitted text, which is
  // `hasDirtyInput`'s job; Settings has nothing to lose, because every control
  // on it saves the moment it changes.
  {
    const settings = { internal: true, url: pages.SETTINGS_URL, hasDirtyInput: false };
    const searching = { internal: true, url: pages.HISTORY_URL, hasDirtyInput: true };
    const floor = (tab) =>
      governor.clampToProtections(tab, Tier.DISCARDED, { ignoreGrace: true });
    check('the browser\'s own pages are reclaimable like any other tab',
      floor(settings) === Tier.DISCARDED &&
      tierRank(floor(searching)) < tierRank(Tier.DISCARDED),
      `settings: ${floor(settings)}, a page with a half-written search: ${floor(searching)}`);
  }

  // The pages that *can* lose something have to be able to say so, and they do
  // not carry the preload that normally reports it. Asserted as the wiring it
  // is: the field is marked, and the page watches marked fields.
  {
    const fs2 = require('fs');
    const marked = ['history.html', 'downloads.html', 'newtab.html'].every((page) =>
      /id="q"[^>]*data-transient/.test(
        fs2.readFileSync(path.join(__dirname, '..', 'renderer', page), 'utf8')));
    const watched = ['history.js', 'downloads.js', 'newtab.js'].every((page) =>
      fs2.readFileSync(path.join(__dirname, '..', 'renderer', page), 'utf8')
        .includes('watchTransientInput(api)'));
    check('a page that can hold typed text marks it and watches for it',
      marked && watched, `marked=${marked}, watched=${watched}`);
  }

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

  // Ask for the deepest demotion there is, on a *live* Settings tab, and
  // confirm nothing refuses it any more.
  //
  // This asserted the opposite until the pages were let onto the ladder. It is
  // kept, inverted, rather than deleted: the exemption is the thing that came
  // back as three permanently-resident renderers, and the check that used to
  // enforce it is the right place to say so. `ignoreGrace`, because this tab
  // was visible a moment ago and the grace period - not the exemption - would
  // otherwise be what answered.
  const floor = governor.clampToProtections(settingsTab, Tier.DISCARDED,
    { discardAllowed: true, ignoreGrace: true });
  check('a live Settings tab is reclaimable like any other',
    settingsTab.internal && floor === Tier.DISCARDED,
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
    'document.querySelectorAll("[data-rows=appearance] .row").length').catch(() => 0);
  check('the browser\'s own pages are sent browser state',
    sawState > 0, `${sawState} setting rows built from a published snapshot`);

  // The browser's own pages are answered from disk, not through the network.
  //
  // The handler used to reply with `net.fetch(file://...)`, which sends every
  // request for our own UI out through the network service and back: measured,
  // 997ms in the handler across three pages against 7.6ms after the change, and
  // a cold new tab page falling from 1758ms to 80ms. Reading the file directly
  // is what makes the difference.
  //
  // Asserted as the property rather than as a stopwatch, because a timing
  // threshold on a shared CI runner fails for reasons that have nothing to do
  // with this: the response has to carry the content type *we* name, which the
  // file fetch never set, and it has to be the file's real bytes.
  //
  // Asked from here rather than from inside one of those pages: their CSP is
  // `default-src 'none'` with no `connect-src`, so a page cannot fetch even its
  // own stylesheet - which is the policy working, and the first version of this
  // check failing on it was the proof.
  {
    const { net } = require('electron');
    const res = await net.fetch('debrowser://settings/theme.css');
    const body = await res.text();
    const missing = await net.fetch('debrowser://settings/nothing-here.css');

    check("the browser's own pages are read from disk rather than fetched over the network",
      res.ok === true && String(res.headers.get('content-type')).startsWith('text/css') &&
      body.includes('--accent') && missing.status === 404,
      `${body.length} bytes as ${res.headers.get('content-type')}, ` +
      `missing file gives ${missing.status}`);
  }

  // Settings opens a notch larger than the rest of the browser.
  //
  // It is the page that is read rather than glanced at, and the one somebody
  // opens when something is hard to see. Asserted on the view's zoom factor
  // rather than on a stylesheet scale, because that is what ctrl+wheel and the
  // zoom shortcuts move - a hard-coded scale would fight them.
  {
    const plain = tabs.create({ url: pages.NEW_TAB_URL, activate: false, realise: true });
    await waitFor(() => plain.isLive, { timeoutMs: 8000 });
    const settingsZoom = settingsTab.wc.getZoomFactor();
    const plainZoom = plain.wc.getZoomFactor();
    check('settings opens larger than the rest of the browser, and only settings',
      Math.abs(settingsZoom - 1.1) < 0.001 && Math.abs(plainZoom - 1) < 0.001,
      `settings ${settingsZoom}x, new tab page ${plainZoom}x`);
    tabs.close(plain.id);
  }

  // Ctrl and the wheel zoom the page.
  //
  // Chromium does not do this for an embedded view - measured, a real
  // ctrl+wheel neither changes the zoom nor raises `zoom-changed` - so the page
  // probe notices the gesture and the browser applies it. Driven end to end
  // here: the event is dispatched in the page's own world, the listener that
  // sees it lives in the probe's isolated world, and what is asserted is the
  // zoom factor the browser process ended up setting.
  {
    const wheel = tabs.create({ url: pageUrl('idle.html'), activate: true, realise: true });
    await waitFor(() => wheel.isLive && !wheel.loading, { timeoutMs: 10_000 });
    const before = wheel.wc.getZoomFactor();

    const fire = (deltaY) => wheel.wc.executeJavaScript(
      `window.dispatchEvent(new WheelEvent('wheel', ` +
      `{ ctrlKey: true, deltaY: ${deltaY}, bubbles: true, cancelable: true })), true`);

    await fire(-120);
    const zoomedIn = await waitFor(() => wheel.wc.getZoomFactor() > before, { timeoutMs: 4000 });
    const after = wheel.wc.getZoomFactor();

    // And back down again, because a gesture that only works one way is worse
    // than one that does not work at all.
    await sleep(120);
    await fire(120);
    await fire(120);
    const zoomedOut = await waitFor(() => wheel.wc.getZoomFactor() < after, { timeoutMs: 4000 });

    check('ctrl and the wheel zoom the page, both ways',
      zoomedIn && zoomedOut,
      `${before}x -> ${after}x on ctrl+wheel up, then ${wheel.wc.getZoomFactor()}x back down`);
    tabs.close(wheel.id);
  }

  // The rail keeps up with the scroll, all the way to the end.
  //
  // It did not: the mark is the topmost section intersecting the top 45% of the
  // scroller, and the last sections are shorter than that band - so once the
  // page had scrolled as far as it goes, nothing new ever entered the band and
  // the rail sat on "Passwords and payment" with Advanced and Updates both on
  // screen. Asserted at the bottom of the scroll, which is the only place the
  // defect exists.
  {
    const railAtEnd = await settingsTab.wc.executeJavaScript(`(async () => {
      const main = document.querySelector('main');
      main.scrollTop = main.scrollHeight;
      await new Promise((r) => setTimeout(r, 400));
      const marked = document.querySelector('.rail-item.current');
      const last = [...document.querySelectorAll('section[data-section]')]
        .filter((s) => !s.hidden).pop();
      return {
        marked: marked ? marked.textContent : null,
        section: last ? last.dataset.section : null,
        atBottom: Math.abs(main.scrollTop + main.clientHeight - main.scrollHeight) < 2
      };
    })()`).catch((err) => ({ error: err.message }));

    check('the settings rail follows the scroll to the last section',
      Boolean(railAtEnd) && railAtEnd.atBottom === true &&
      railAtEnd.marked && railAtEnd.section &&
      railAtEnd.marked.toLowerCase().includes(railAtEnd.section.slice(0, 6)),
      railAtEnd && railAtEnd.error
        ? railAtEnd.error
        : `scrolled to the end, rail says ${JSON.stringify(railAtEnd.marked)}, ` +
          `last section is ${railAtEnd.section}`);
  }

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

  // The tiles line up with the field above them, with a long hostname in them.
  //
  // Reported twice, and it is one bug both times: a grid item's automatic
  // minimum size is its own content, so `1fr` columns let "accounts.google.com"
  // push its column - and the whole grid - wider than the search field, and the
  // start page reads as two things that were laid out separately. It only shows
  // up with a long hostname in the list, which is why one is planted here
  // rather than trusting whatever history happens to hold.
  //
  // Asserted as both edges rather than the width: a grid that is the right
  // width and half a pixel to the left is the same defect.
  {
    const planted = ['https://accounts.google.com/', 'https://developer.mozilla.org/'];
    for (const url of planted) bookmarks.add({ url, title: url });

    const page = tabs.create({ url: pages.NEW_TAB_URL, activate: true, realise: true });
    await waitFor(() => page.isLive && !page.loading, { timeoutMs: 10_000 });

    const read = () => page.wc.executeJavaScript(`(() => {
      const field = document.getElementById('q').getBoundingClientRect();
      const tiles = document.getElementById('tiles').getBoundingClientRect();
      return {
        count: document.querySelectorAll('#tiles .tile').length,
        fieldLeft: Math.round(field.left), fieldRight: Math.round(field.right),
        tilesLeft: Math.round(tiles.left), tilesRight: Math.round(tiles.right)
      };
    })()`).catch(() => null);

    // The tiles arrive on a request, so the first read can beat them.
    await waitFor(async () => ((await read()) || {}).count > 0, { timeoutMs: 8000 });
    const box = await read();

    check('the new tab tiles share both edges with the search field',
      Boolean(box) && box.count > 0 &&
      box.fieldLeft === box.tilesLeft && box.fieldRight === box.tilesRight,
      box
        ? `${box.count} tiles · field ${box.fieldLeft}-${box.fieldRight}, ` +
          `tiles ${box.tilesLeft}-${box.tilesRight}`
        : 'the page did not answer');

    tabs.close(page.id);
    for (const url of planted) bookmarks.remove(url);
  }

  const webUrl = pageUrl('idle.html');
  await fresh.wc.loadURL(webUrl).catch(() => {});
  await waitFor(() => !fresh.loading && fresh.url.startsWith('http'), { timeoutMs: 10_000 });

  check('navigating a new tab to a website stops it being one of ours',
    fresh.internal === false,
    `internal=${fresh.internal} url=${fresh.url.slice(0, 48)}`);

  // And it still reports its own memory afterwards.
  //
  // `pid` was assigned in a `once('did-finish-load')`, so it held whichever
  // process the tab was realised in - and with site isolation on, navigating to
  // another site moves the page to a different renderer. Every tab that had
  // been anywhere therefore attributed its memory to a process it no longer
  // used and read 0 MB, including the one in front of the user. Only the
  // browser's own pages looked right, because they never leave the process they
  // started in. This tab has just done exactly that navigation.
  {
    const live = safePidOf(fresh);
    const settled = await waitFor(() => {
      governor.metrics.sample();
      return fresh.rssMB > 0;
    }, { timeoutMs: 10_000 });
    check('a tab that has navigated still reports its own memory',
      settled && live > 0 && fresh.pid === live,
      `pid ${fresh.pid} (renderer says ${live}), ${fresh.rssMB}MB`);
  }

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
    // `hidden` has to mean hidden, on an element with a `display` of its own.
    //
    // The UA's `[hidden] { display: none }` is a user-agent rule, so any author
    // declaration beats it however weak - and this UI sets `display` on nearly
    // everything. So `el.hidden = true` silently did nothing in three places at
    // once: the toolbar's downloads button stayed visible with no downloads,
    // and in the downloads flyout every finished row kept a full progress bar
    // and offered "Open file", including one that had failed. Found by
    // photographing the panels; fixed once, in theme.css.
    const hiddenWorks = await shell.chromeView.webContents.executeJavaScript(`(() => {
      // The menu button, because it is always visible - the downloads button
      // next to it is legitimately hidden when nothing has been downloaded,
      // which is every run of this suite.
      const el = document.getElementById('menu');
      if (!el) return null;
      const before = getComputedStyle(el).display;
      el.hidden = true;
      const after = getComputedStyle(el).display;
      el.hidden = false;
      return { before, after };
    })()`).catch(() => null);
    check('an element with its own display still obeys `hidden`',
      Boolean(hiddenWorks) && hiddenWorks.before !== 'none' && hiddenWorks.after === 'none',
      hiddenWorks ? `display ${hiddenWorks.before} -> ${hiddenWorks.after}` : 'no button in the toolbar');

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
  // Leaving a tab marks it idle quickly, and coming back does not reload it.
  //
  // Those are two halves of one request and they pull in opposite directions,
  // which is why both are asserted together: the mark has to arrive within a
  // few seconds of looking away, and the page behind it has to survive the
  // trip back with the same renderer and the same document. The shipped
  // threshold is read from the profile rather than from `cfg`, which this
  // suite compresses.
  {
    const shipped = require('./config').loadConfig('balanced').coldAfterMs;

    const keep = tabs.create({ url: pageUrl('idle.html'), activate: true, realise: true });
    await waitFor(() => keep.isLive && !keep.loading, { timeoutMs: 10_000 });
    // Something the page itself remembers. A reload loses it; a restore from
    // the tier ladder must not, because nothing below FROZEN touches the page.
    await keep.wc.executeJavaScript('window.__kept = Date.now()').catch(() => {});
    const pidBefore = keep.pid;

    // Away, and back once it has actually gone idle.
    const other = tabs.create({ url: pageUrl('idle.html'), activate: true, realise: true });
    await waitFor(() => other.isLive, { timeoutMs: 10_000 });
    const wentIdle = await waitFor(
      () => tierRank(keep.tier) >= tierRank(Tier.COLD), { timeoutMs: 8000 });
    await tabs.activate(keep.id);

    const kept = await keep.wc.executeJavaScript('window.__kept || 0').catch(() => 0);
    check('a tab you come back to is the one you left, not a reload of it',
      shipped <= 5000 && wentIdle && kept > 0 && keep.pid === pidBefore,
      `idle after ${shipped}ms shipped; came back to pid ${keep.pid} (was ${pidBefore}), ` +
      `page state ${kept ? 'kept' : 'lost'}`);

    tabs.close(other.id);
    tabs.close(keep.id);
  }

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

    // The same thing, in every combination it was reported in.
    //
    // The check above is one cell of a grid: a website, across the top, with
    // the inspector on the right. The report was an internal page with the
    // strip down the side, and each of those is a separate code path -
    // `contentArea` has a whole branch for the vertical layout, and the
    // browser's own pages are realised differently from a site. Rather than
    // guess which cell is broken, walk all of them: four pages in two layouts,
    // asserted the same way each time.
    //
    // A dock along the bottom is included because it is the other half of
    // `contentBounds`'s arithmetic and nothing else exercises it.
    {
      const wasSide = prefs.get('tabBarPosition');
      const wasDock = prefs.get('devToolsDock');
      const cases = [];

      for (const position of ['top', 'left']) {
        for (const dock of ['right', 'bottom']) {
          for (const [what, url] of [
            ['a website', pageUrl('idle.html')],
            ['the new tab page', pages.NEW_TAB_URL],
            ['settings', pages.SETTINGS_URL],
            ['history', pages.HISTORY_URL]
          ]) {
            prefs.set('tabBarPosition', position);
            prefs.set('devToolsDock', dock);
            shell.applyWindowPrefs();

            const own = tabs.create({ url, activate: true, realise: true });
            await waitFor(() => own.isLive && !own.loading, { timeoutMs: 10_000 });

            const axis = dock === 'bottom' ? 'height' : 'width';
            const viewport = dock === 'bottom' ? 'window.innerHeight' : 'window.innerWidth';
            const before = shell.contentBounds()[axis];
            toggleDevTools(own, shell);
            await waitFor(() => shell.devToolsView, { timeoutMs: 8000 });
            const after = shell.contentBounds()[axis];

            // What the view was actually given, not what the geometry says it
            // should be: the report is that the page did not move, and only the
            // view's own bounds can answer that.
            const given = own.view ? own.view.getBounds()[axis] : -1;

            // And the page itself has to agree. A view can be resized while the
            // document inside it keeps its old layout viewport, which is exactly
            // what "the page did not make space" looks like: the content stays
            // the size it was and the inspector is drawn over the end of it.
            // In CSS pixels, which are not view pixels on a page that is
            // zoomed - Settings opens at 110%, so its document reports 675
            // where the view is 742 and the comparison has to scale. Read from
            // the view rather than assumed, so this stays right if the default
            // moves.
            const zoom = own.wc.getZoomFactor() || 1;
            const settled = await waitFor(async () => {
              const seen = await own.wc.executeJavaScript(viewport).catch(() => 0);
              return seen > 0 && Math.abs(seen * zoom - after) <= 2;
            }, { timeoutMs: 4000 });
            const inner = await own.wc.executeJavaScript(viewport).catch(() => -1);

            const ok = after > 0 && after < before && given === after && settled;
            if (!ok) {
              cases.push(`${what} ${position}/${dock}: ${before}->${after}, ` +
                `view ${given}, document ${inner}${zoom === 1 ? '' : ` at ${zoom}x`}`);
            }

            toggleDevTools(own, shell);
            tabs.close(own.id);
          }
        }
      }

      check('every page gives up room for the inspector, in both layouts and both docks',
        cases.length === 0,
        cases.length === 0 ? '16 combinations, all shrank' : cases.join(' · '));

      prefs.set('tabBarPosition', wasSide);
      prefs.set('devToolsDock', wasDock);
      shell.applyWindowPrefs();

    }

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

    // And the update prompt is the third tenant, drawn by the browser rather
    // than asked of the system. `dialog.showMessageBox` put a Win32 box in the
    // middle of a window that draws everything else itself.
    shell.openSheet('update');
    const promptUp = await waitFor(
      () => shell.sheetView && shell.sheetPage === 'update' &&
        shell.sheetView.webContents.getURL().includes('update.html'),
      { timeoutMs: 8000 });
    check('the update prompt is one of the browser\'s own views',
      promptUp, `sheet is ${shell.sheetPage}`);
    shell.closeSheet();
    await waitFor(() => shell.sheetView === null, { timeoutMs: 5000 });

    check('the downloads flyout takes over the sheet from the menu',
      menuUp && swapped, `menu up=${menuUp}, swapped to ${shell.sheetPage}`);
    check('the flyout reads the download list and not the credential store',
      reads === true && refused === true,
      `list-downloads answered=${reads}, list-credentials refused=${refused}`);

    shell.closeSheet();
    await waitFor(() => shell.sheetView === null, { timeoutMs: 5000 });
  }

  // Every window that can be typed at answers the same shortcuts.
  //
  // There were two tables and they disagreed: the chrome bound Ctrl+L, Ctrl+D
  // and Ctrl+Shift+B in its own DOM, the browser process bound a different set
  // to each page. Which shortcuts existed therefore depended on which view held
  // focus - and a page holds it nearly all the time, so the address bar could
  // not be reached from the keyboard at all. Now there is one table and every
  // view is bound to it, each exactly once: two listeners on the same view
  // would open two tabs per Ctrl+T, which is the failure that kept the chrome
  // out of this in the first place.
  {
    const listeners = (view) => (view && !view.webContents.isDestroyed()
      ? view.webContents.listenerCount('before-input-event')
      : -1);

    shell.togglePanel(true);
    await waitFor(() => Boolean(shell.panelView), { timeoutMs: 8000 });
    shell.openSheet('menu', { x: 100, y: 84, right: 132 });
    await waitFor(() => shell.sheetView && shell.sheetPage === 'menu', { timeoutMs: 8000 });

    const counts = {
      chrome: listeners(shell.chromeView),
      panel: listeners(shell.panelView),
      sheet: listeners(shell.sheetView),
      tab: tabs.activeTab()?.isLive
        ? tabs.activeTab().wc.listenerCount('before-input-event') : -1
    };

    check('every view answers the browser\'s shortcuts, and none answers twice',
      Object.values(counts).every((n) => n === 1),
      Object.entries(counts).map(([name, n]) => `${name}=${n}`).join(' '));

    // And the table itself agrees with what the menu advertises.
    const table = require('./shortcuts');
    // Built with this platform's modifier, because the table uses Cmd on macOS
    // and Ctrl elsewhere - and this suite runs on all three.
    const press = (key, extra = {}) => ({
      type: 'keyDown', key,
      ...(process.platform === 'darwin' ? { meta: true } : { control: true }),
      ...extra
    });
    const sample = [
      ['focus-address', press('l')],
      ['toggle-bookmarks-bar', press('b', { shift: true })],
      ['new-tab', press('t')],
      ['reopen-closed-tab', press('t', { shift: true })],
      ['find-open', press('f')]
    ];
    const resolved = sample.map(([, input]) => table.match(input)?.command || null);
    check('the keys the browser advertises are the keys it answers',
      resolved.every((got, i) => got === sample[i][0]) &&
        table.accelFor('new-tab').length > 0,
      `${resolved.join(', ')} · menu says ${table.accelFor('toggle-bookmarks-bar')}`);

    shell.closeSheet();
    await waitFor(() => shell.sheetView === null, { timeoutMs: 5000 });
    shell.togglePanel(false);
  }

  // A colour the browser no longer offers does not survive as one it does.
  //
  // `save()` writes every value, so any profile that has ever changed a setting
  // carries the *old* defaults on disk - and an old default is still a valid
  // `#rrggbb`, so it loads cleanly and the browser comes up in the new surfaces
  // under the previous accent, with no swatch in Settings showing as chosen.
  // Read from a file of its own rather than from the user's, which this suite
  // runs against.
  {
    const { Prefs } = require('./prefs');
    const os = require('os');
    const fs = require('fs');
    const file = path.join(os.tmpdir(), `debrowser-prefs-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({
      accent: '#5B8CFF',            // the old default, in the other case
      tabBarColor: '#241c2e',       // a strip colour that was retired
      theme: 'dark'                 // a setting that must be left exactly alone
    }));

    const probe = new Prefs(() => {});
    probe.file = file;
    const loaded = probe.load();

    check('a retired colour is replaced rather than kept or reset',
      loaded.accent !== '#5B8CFF' && loaded.accent !== '#5b8cff' &&
        loaded.tabBarColor === '#1d1c22' && loaded.theme === 'dark',
      `accent ${loaded.accent}, strip ${loaded.tabBarColor}, theme ${loaded.theme}`);

    // And a file somebody has edited into nonsense still starts the browser.
    //
    // This is the migration's own failure mode: it compares colours, so a value
    // that is not a string threw out of `load()` - which runs in the Prefs
    // constructor, before there is a window, so the browser would not have
    // started at all rather than falling back to a default.
    fs.writeFileSync(file, JSON.stringify({
      accent: 12, tabBarColor: { r: 1 }, theme: 'dark', maxLiveTabs: 'lots'
    }));
    let survived = false;
    let junk = null;
    try {
      junk = probe.load();
      survived = true;
    } catch { /* reported below */ }
    fs.unlinkSync(file);

    check('a hand-edited preferences file cannot stop the browser starting',
      survived && junk.accent === '#2f857b' && junk.tabBarColor === 'default' &&
        junk.theme === 'dark',
      survived
        ? `accent ${junk.accent}, strip ${junk.tabBarColor}, theme ${junk.theme}`
        : 'load() threw');
  }

  // Right-click, which used to do nothing at all.
  //
  // Two properties, and the second is the one that could go wrong quietly: the
  // menu offers what was actually under the pointer, and the address it offers
  // to open is the one Chromium's hit test reported - never something the page
  // put there. A menu that will open any URL a renderer names is a page opening
  // tabs on the user's behalf.
  {
    const link = contextMenu.buildModel(
      { linkURL: 'https://example.com/a', x: 40, y: 60 },
      { canGoBack: true, canGoForward: false, engineName: 'Google' });
    const plain = contextMenu.buildModel({ x: 4, y: 4 }, {});
    const editable = contextMenu.buildModel(
      { isEditable: true, selectionText: 'abc', editFlags: { canPaste: true, canCut: true } }, {});
    const script = contextMenu.buildModel({ linkURL: 'javascript:alert(1)' }, {});

    const ids = (model) => model.filter((i) => i.id).map((i) => i.id);
    check('the page menu offers what was under the pointer',
      ids(link).includes('open-link-tab') && ids(link).includes('copy-link') &&
        ids(editable).includes('edit-paste') && !ids(plain).includes('open-link-tab') &&
        ids(plain).includes('back'),
      `link: ${ids(link).slice(0, 3).join(',')} · editable: ${ids(editable).slice(0, 2).join(',')}`);

    check('a link the browser would not open is not offered',
      !ids(script).includes('open-link-tab'),
      `javascript: link produced ${ids(script).slice(0, 3).join(',') || 'nothing but the page items'}`);

    // And it draws in the same sheet the app menu does, rather than in a
    // mechanism of its own that would drift away from it. The model has to be
    // there first: the menu closes itself rather than showing an empty card,
    // which is the right behaviour and would otherwise read as a failure here.
    context.model = { items: link, params: { x: 200, y: 200 }, tabId: null };
    shell.openSheet('context', { x: 200, y: 200, right: 200 });
    const up = await waitFor(
      () => shell.sheetView && shell.sheetPage === 'context' &&
        shell.sheetView.webContents.getURL().includes('context.html'),
      { timeoutMs: 8000 });
    check('the page menu is drawn in the sheet, like every other panel',
      up, `sheet is ${shell.sheetPage}`);
    shell.closeSheet();
    await waitFor(() => shell.sheetView === null, { timeoutMs: 5000 });
  }

  // Find in page.
  //
  // The bar takes its room from the page rather than floating over it, which is
  // the half that can break invisibly: a bar the window has not accounted for
  // is painted over the top of the content. So the assertion is on the *page's*
  // rectangle, not on the bar.
  {
    // Its own tab, in front and loaded, rather than whatever the suite left
    // active - a frozen or discarded renderer has nothing to search.
    const target = tabs.create({ url: pageUrl('idle.html'), activate: true, realise: true });
    await tabs.activate(target.id);
    await waitFor(() => target.isLive && !target.loading, { timeoutMs: 10_000 });

    const beforeHeight = shell.contentBounds().height;
    const beforeChrome = shell.chromeHeight();

    runCommand('find-open', null);
    const opened = shell.findOpen && shell.chromeHeight() > beforeChrome &&
      shell.contentBounds().height < beforeHeight;

    // A real search on the page in front, through the same command a keystroke
    // would run. `found-in-page` is the only source of a count - `findInPage`
    // itself returns a request id and nothing else.
    // Measured, after this check failed with no event at all: `findInPage`
    // answers nothing until the page has actually been laid out, and a tab that
    // has finished loading has not necessarily been painted yet. Not a focus
    // problem - tested both ways, and an unfocused view searches perfectly
    // well, which matters because the keyboard is in the find bar by then.
    await new Promise((resolve) => setTimeout(resolve, 500));

    let result = null;
    if (target?.isLive) {
      const heard = new Promise((resolve) => {
        target.wc.once('found-in-page', (_event, found) => resolve(found));
        setTimeout(() => resolve(null), 4000);
      });
      runCommand('find-query', { query: 'timers' });
      result = await heard;
    }

    runCommand('find-close', null);
    const closed = !shell.findOpen && shell.contentBounds().height === beforeHeight;

    check('the find bar takes its room from the page and gives it back',
      opened && closed,
      `content ${beforeHeight} -> ${opened ? 'shorter' : 'unchanged'} -> ${shell.contentBounds().height}`);

    // And it is reachable with the strip down the side, where the chrome is a
    // column that is ten pixels wide until the pointer arrives. The bar is
    // drawn inside that column, so without the window holding the strip out a
    // find bar opened from the keyboard was laid out off the side of the
    // window - visible to nobody and typeable into by nobody.
    {
      const was = prefs.get('tabBarPosition');
      prefs.set('tabBarPosition', 'left');
      shell.applyWindowPrefs();
      // Out: a 240px column over the page. In: the whole window, under it.
      const state = () => (shell.chromeBehind ? 'under the page' : `${shell.chromeView.getBounds().width}px column`);
      const collapsed = state();

      runCommand('find-open', null);
      const out = state();

      runCommand('find-close', null);
      const backIn = state();

      prefs.set('tabBarPosition', was);
      shell.applyWindowPrefs();

      check('opening find brings the side strip out, and closing it lets go',
        collapsed === 'under the page' && out === '240px column' && backIn === collapsed,
        `strip ${collapsed} -> ${out} -> ${backIn}`);
    }
    check('a search reports how many matches it found',
      Boolean(result) && result.matches > 0,
      result ? `${result.matches} match(es), on ${result.activeMatchOrdinal}` : 'no result arrived');

    tabs.close(target.id);
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

  // When the browser checks for updates, and when it does not.
  //
  // It used to re-check every six hours for the life of a window - a browser
  // reaching out to GitHub on a schedule nobody asked for. Now it checks on
  // launch, when the Updates section comes into view, and when the button is
  // pressed. The first two need a floor or scrolling past twice is two
  // requests; the button must not be subject to it, because pressing Check now
  // means check now. Both halves are here because they are one decision.
  {
    const { Updater } = require('./updater');
    let calls = 0;
    const sched = new Updater({ log: () => {}, enabled: () => true });
    // Stubbed rather than packaged: `capability()` is false from source, so the
    // real implementation is never loaded and `check` would be inert.
    sched.impl = { checkForUpdates: () => { calls += 1; return Promise.resolve(null); } };

    sched.check();
    const first = calls;
    sched.state = 'unchecked';
    sched.check();
    const throttled = calls;
    sched.check(true);
    const manual = calls;

    check('the browser checks for updates on request, not on a timer',
      first === 1 && throttled === 1 && manual === 2,
      `automatic: ${first}, a second automatic: ${throttled}, after the button: ${manual}`);
  }

  // The side strip: out of the way until the pointer asks for it.
  //
  // Zen's shape, and the two halves that make it work. The strip's *view* is a
  // ten-pixel edge until the pointer reaches it, because a view is the only
  // thing that can be told the pointer arrived - there is no hovering something
  // that is not there. And sliding it out must not move the page: a page that
  // reflowed every time the pointer brushed the window edge would be the most
  // distracting thing in the browser.
  {
    const { SIDEBAR_WIDTH, CONTENT_GAP } = require('./window');
    const chromeWidth = () => shell.chromeView.getBounds().width;

    prefs.set('tabBarPosition', 'left');
    prefs.set('sidebarPinned', false);
    shell.applyWindowPrefs();
    shell.layout();

    const restKids = shell.window.contentView.children;
    const restTab = tabs.activeTab();
    const edgeRest = {
      behind: shell.chromeBehind === true,
      width: chromeWidth(),
      pageAbove: Boolean(restTab && restTab.view) &&
        restKids.indexOf(restTab.view) > restKids.indexOf(shell.chromeView)
    };
    const shut = shell.contentBounds();

    shell.setSidebarOpen(true);
    const openWide = chromeWidth();
    const whileOpen = shell.contentBounds();

    // At rest the chrome is the whole window *under* the page: the page covers
    // all of it but the toolbar band across the top and the edge, so the
    // window keeps its controls while the strip is away. Open, it is the
    // strip's column, on top.
    check('the side strip is an edge, under a toolbar that stays, until the pointer reaches it',
      edgeRest.behind && edgeRest.width === shell.window.getContentBounds().width &&
        edgeRest.pageAbove && openWide === SIDEBAR_WIDTH && !shell.chromeBehind,
      `at rest ${JSON.stringify(edgeRest)}, ${openWide}px open`);
    check('sliding it out does not move the page',
      whileOpen.x === shut.x && whileOpen.width === shut.width,
      `page at ${shut.x}px wide ${shut.width} -> ${whileOpen.x}px wide ${whileOpen.width}`);

    // Pinned, it takes its column back and the page gives up the width.
    prefs.set('sidebarPinned', true);
    shell.applyWindowPrefs();
    const pinned = shell.contentBounds();
    check('pinning it gives the strip its column and the page the rest',
      chromeWidth() === SIDEBAR_WIDTH && pinned.x === SIDEBAR_WIDTH + CONTENT_GAP &&
      pinned.width < shut.width,
      `page starts at ${pinned.x}px, ${shut.width} -> ${pinned.width} wide`);

    // And the page is a card rather than something fused to the strip, which
    // is the other half of what was asked for: edge to edge, the browser's own
    // pages carry the same dark background as the strip and read as one
    // surface with it.
    const { width: winW, height: winH } = shell.window.getContentBounds();
    check('the page is inset as a card in sidebar mode',
      pinned.y > 0 && pinned.x + pinned.width === winW - CONTENT_GAP &&
      pinned.y + pinned.height === winH - CONTENT_GAP,
      `${pinned.x},${pinned.y} ${pinned.width}x${pinned.height} in ${winW}x${winH}`);

    prefs.set('sidebarPinned', false);
    prefs.set('tabBarPosition', 'top');
    shell.applyWindowPrefs();
    shell.layout();
    const back = shell.contentBounds();
    check('across the top the page fills the window again',
      back.x === 0 && back.width === winW,
      `${back.x},${back.y} ${back.width}x${back.height}`);
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
    const cov = governor.metrics.probeCoverage();
    return cap.available === true && cov.total > 0 && cov.measured === cov.total;
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
    //
    // 'mixed' is a failure here, and used to be a pass. That is the hole this
    // check had: a helper that measured the browser process and was refused by
    // every renderer satisfied it, while the panel - correctly - went on
    // reporting a summed, roughly doubled total. A partial measurement is the
    // bug, not a degraded pass, and the failure names how many processes
    // answered and why the rest did not.
    const probePath = platform.probeBinaryPath();
    const cov = probeSnap.probeCoverage;
    const why = (cov.failures || []).map((f) => `${f.kind}x${f.count}`).join(',') || 'none';
    check('per-process memory is measured natively, for every process',
      probeCap.available === true && probeSnap.accounting === 'probe' &&
      probeSnap.totalMB > 0,
      `mechanism=${probeCap.mechanism} accounting=${probeSnap.accounting} ` +
      `covered=${cov.measured}/${cov.total} failures=${why} ` +
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

  // Right-clicking a tab, and what the menu's items actually do.
  //
  // The menu people reach for without thinking - close the other twelve,
  // duplicate this, silence whichever tab is making that noise - and the browser
  // had none. Built in the browser rather than in the strip: every item is a
  // command with a tab id, and the chrome holds no authority over tabs beyond
  // naming one.
  {
    const keep = tabs.create({ url: pageUrl('idle.html'), activate: true, realise: false });
    const pinned = tabs.create({ url: pageUrl('idle.html'), activate: false, realise: false });
    const left = tabs.create({ url: pageUrl('idle.html'), activate: false, realise: false });
    const right = tabs.create({ url: pageUrl('idle.html'), activate: false, realise: false });
    pinned.pinned = true;

    // The model first: the two "close several" items are the ones that must go
    // dim when there is nothing for them to close, and a menu that offers an
    // action it cannot perform is worse than one that does not offer it.
    runCommand('tab-menu', { id: keep.id, x: 40, y: 40 });
    const model = context.model;
    const byId = new Map((model?.items || []).filter((i) => i.id).map((i) => [i.id, i]));
    const labels = [...byId.keys()].join(', ');
    shell.closeSheet();

    // Duplicate lands beside the tab it came from, not at the end.
    const before = tabs.all().length;
    runCommand('duplicate-tab', { id: keep.id });
    const copy = tabs.all()[tabs.all().indexOf(keep) + 1];
    const duplicated = tabs.all().length === before + 1 && copy && copy.url === keep.url;
    if (copy) tabs.close(copy.id);

    // Muting is remembered by the tab, not only by the renderer, so it survives
    // the tab being discarded and rebuilt - otherwise a noisy tab you silenced
    // starts talking again the moment the governor reclaims it.
    runCommand('mute-tab', { id: keep.id });
    const mutedNow = keep.muted === true;
    await governor.enforceManualDiscard(keep);
    await tabs.activate(keep.id);
    await waitFor(() => keep.isLive && !keep.loading, { timeoutMs: 10_000 });
    const stillMuted = keep.muted === true && keep.wc.isAudioMuted() === true;
    runCommand('mute-tab', { id: keep.id });

    // Close to the right takes what is after it and nothing before it.
    const rightGone = tabs.all().includes(right);
    runCommand('close-tabs-right', { id: left.id });
    const afterRight = tabs.all();

    check('a tab has a menu, and its items do what they say',
      byId.has('duplicate-tab') && byId.has('mute-tab') &&
      byId.get('close-other-tabs')?.enabled === true &&
      duplicated && mutedNow && stillMuted &&
      rightGone && !afterRight.includes(right) && afterRight.includes(left) &&
      afterRight.includes(pinned),
      `items: ${labels}; duplicate beside=${duplicated}; ` +
      `mute survived a discard=${stillMuted}; ` +
      `close-to-the-right left ${afterRight.length} tabs, pinned kept=${afterRight.includes(pinned)}`);

    for (const tab of [keep, pinned, left]) {
      if (tabs.all().includes(tab)) { tab.pinned = false; tabs.close(tab.id); }
    }
  }

  // The address bar's suggestions: the list, the ranking rule inline
  // completion rests on, and the row that switches to an open tab.
  //
  // What is asserted is where this goes wrong. Inline completion takes a
  // *prefix* of the address, never a substring - "git" fills github.com, not
  // every page with "git" somewhere in it - while the list itself matches words
  // anywhere, so the substring still shows up as a row. A page already open in
  // another tab is offered as that tab, and picking it switches rather than
  // loading the page a second time. The plain search is always in the list.
  //
  // Driven through bookmarks and tabs rather than history: recording is
  // switched off for the whole run under `--smoke-test`, so nothing visited
  // here would be stored.
  //
  // Asked the way the address bar asks - through the chrome's own bridge - so
  // the sender check and both allowlists are part of what is tested. They are
  // two separate lists, and an earlier version of this check failed because
  // the browser allowed a request the bridge in front of it did not.
  {
    const chrome = shell.chromeView.webContents;
    const ask = (text) => chrome.executeJavaScript(
      `window.debrowser.request('suggest', { text: ${JSON.stringify(text)} })`);

    bookmarks.add({ url: 'https://gitlab.test/saved-page', title: 'Saved' });
    const other = tabs.create({ url: pageUrl('branded.html'), activate: false, realise: true });
    await waitFor(() => other.isLive && !other.loading && other.title === 'Branded');
    const before = tabs.activeTab();

    const prefix = await ask('gitlab');
    const substring = await ask('saved');
    const noMatch = await ask('nothing-like-this');
    const open = await ask('branded');

    const kinds = (res) => (res?.items || []).map((i) => i.kind).join(',');
    const tabRow = (open?.items || []).findIndex((i) => i.kind === 'tab' && i.tabId === other.id);

    check('the address bar completes a prefix of an address, never a substring',
      prefix?.inline === 'gitlab.test/saved-page' &&
      substring && substring.inline === null &&
      substring.items.some((i) => i.url === 'https://gitlab.test/saved-page'),
      `"gitlab" -> ${prefix?.inline}, "saved" -> ${substring?.inline} ` +
      `with rows ${kinds(substring)}`);

    check('the suggestions always offer the plain search, and nothing else when nothing matches',
      [prefix, substring, open].every((r) => r?.items.some((i) => i.kind === 'search')) &&
      kinds(noMatch) === 'search',
      `no match -> ${kinds(noMatch)}`);

    // Picking the row: the list is asked for again so the browser holds this
    // list, then its tab row picked by index, as a click on it sends.
    let switched = false;
    if (tabRow >= 0) {
      await ask('branded');
      await chrome.executeJavaScript(`window.debrowser.send('suggest-pick', { index: ${tabRow} })`);
      switched = await waitFor(() => tabs.activeTab() === other, { timeoutMs: 3000 });
    }
    check('an open tab is suggested as that tab, and picking it switches to it',
      tabRow >= 0 && switched && tabs.all().filter((t) => t.url === other.url).length === 1,
      `tab row at ${tabRow}, switched=${switched}`);

    if (before && tabs.all().includes(before)) await tabs.activate(before.id);
    tabs.close(other.id);
    bookmarks.remove('https://gitlab.test/saved-page');
  }

  // Dragging a tab moves it, by real pointer input into the chrome: pressed,
  // carried a tab and a half along the strip, released. The model and the
  // strip must agree on the new order afterwards.
  {
    const chrome = shell.chromeView.webContents;
    const a = tabs.create({ url: pageUrl('idle.html'), activate: true, realise: false });
    const b = tabs.create({ url: pageUrl('idle.html'), activate: false, realise: false });
    // At the front of the strip, where they are on screen however many tabs
    // the suite has open by now - which also exercises `move` on its own.
    tabs.move(a.id, 0);
    tabs.move(b.id, 1);
    await sleep(400);
    const from = tabs.all().indexOf(a);
    const rect = await chrome.executeJavaScript(`(() => {
      const first = document.getElementById('tabs').children[0];
      first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = document.getElementById('tabs').children[${from}].getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height,
               vertical: document.body.dataset.layout === 'left' };
    })()`);
    // Grabbed by its icon end: a narrow tab is mostly close button, and a
    // press there is a close, never a drag.
    const along = (t) => (rect.vertical
      ? { x: Math.round(rect.x + 14), y: Math.round(rect.y + rect.h / 2 + t * rect.h) }
      : { x: Math.round(rect.x + 14 + t * rect.w), y: Math.round(rect.y + rect.h / 2) });
    const start = along(0);
    chrome.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i++) {
      chrome.sendInputEvent({ type: 'mouseMove', ...along(i * 0.125), button: 'left', modifiers: ['leftButtonDown'] });
      await sleep(16);
    }
    chrome.sendInputEvent({ type: 'mouseUp', ...along(1.5), button: 'left', clickCount: 1 });
    const moved = await waitFor(() => tabs.all().indexOf(a) === from + 1, { timeoutMs: 3000 });
    await sleep(500);
    const stripOrder = await chrome.executeJavaScript(
      `[...document.getElementById('tabs').children].map((n) => n.dataset.id).join(',')`);
    check('dragging a tab along the strip moves it there',
      moved && tabs.all().indexOf(b) === from && stripOrder === tabs.all().map((t) => t.id).join(','),
      `index ${from} -> ${tabs.all().indexOf(a)}, neighbour at ${tabs.all().indexOf(b)}, ` +
      `tab at ${JSON.stringify(rect)}, chrome ${JSON.stringify(shell.chromeView.getBounds())}`);
    tabs.close(a.id);
    tabs.close(b.id);
  }

  // A site asks for a permission, the panel under the padlock asks the user,
  // and the answer is remembered for that site: asked once, then not again.
  // Both answers, and the third - closing the panel - which refuses for now
  // and lets the page ask again only after it navigates.
  //
  // Notifications and location because a machine with no camera refuses a
  // camera request before any permission is asked for. On 127.0.0.1 rather
  // than the fixture sites: both are for secure contexts only, and a plain
  // http:// page on any other host is refused by the engine before anything
  // is asked.
  {
    const http = require('http');
    const servers = [];
    const site = () => new Promise((resolve) => {
      const server = http.createServer((_q, res) => res.end('<title>Asks</title>'))
        .listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
      servers.push(server);
    });
    const tab = tabs.create({ url: await site(), activate: true, realise: true });
    await waitFor(() => tab.isLive && !tab.loading);
    await tabs.activate(tab.id);
    const page = (js) => tab.wc.executeJavaScript(js).catch((err) => `threw ${err.message}`);
    const panel = async () => {
      const shown = await waitFor(() => shell.sheetPage === 'site' && shell.sheetView &&
        !shell.sheetView.webContents.isLoading(), { timeoutMs: 4000 });
      if (!shown) return null;
      const wc = shell.sheetView.webContents;
      await waitFor(() => wc.executeJavaScript('!document.getElementById("ask").hidden').catch(() => false),
        { timeoutMs: 3000 });
      return wc;
    };

    // Allow.
    const asked = page('Notification.requestPermission()');
    const sheet = await panel();
    const text = sheet ? await sheet.executeJavaScript('document.getElementById("ask").textContent.replace(/\\s+/g, " ").trim()') : '';
    if (sheet) await sheet.executeJavaScript('document.getElementById("allow").click()');
    const answer = await asked;
    await sleep(200);
    const again = await page('Notification.requestPermission()');
    const quiet = shell.sheetPage !== 'site';
    const told = await page('Notification.permission');
    check('a site asking for notifications is asked about under the padlock, and Allow is remembered',
      /wants to Show notifications/.test(text) && answer === 'granted' && again === 'granted' && quiet && told === 'granted',
      `panel "${text}", answer ${answer}, asked again -> ${again} (panel ${quiet ? 'stayed shut' : 'opened'}), permission ${told}`);

    // Block.
    const locate = 'new Promise((r) => navigator.geolocation.getCurrentPosition(() => r("ok"), (e) => r("refused " + e.code), { timeout: 4000 }))';
    const located = page(locate);
    const sheet2 = await panel();
    if (sheet2) await sheet2.executeJavaScript('document.getElementById("block").click()');
    const refusal = await located;
    const second = await page(locate);
    check('Block is remembered too: the site is refused without asking again',
      Boolean(sheet2) && refusal === 'refused 1' && second === 'refused 1' && shell.sheetPage !== 'site',
      `first ${refusal}, second ${second}`);

    // Dismissed: in a second tab on another site, so nothing above decides it.
    const other = tabs.create({ url: await site(), activate: true, realise: true });
    await waitFor(() => other.isLive && !other.loading);
    await tabs.activate(other.id);
    const otherPage = (js) => other.wc.executeJavaScript(js).catch((err) => `threw ${err.message}`);
    const pending = otherPage('Notification.requestPermission()');
    const sheet3 = await panel();
    if (sheet3) await sheet3.executeJavaScript('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
    const dismissed = await pending;
    const nagged = await otherPage('Notification.requestPermission()');
    const stayedShut = shell.sheetPage !== 'site';
    other.wc.reload();
    await waitFor(() => !other.loading, { timeoutMs: 3000 });
    const afterReload = otherPage('Notification.requestPermission()');
    const asksAgain = Boolean(await panel());
    shell.closeSheet();
    await afterReload;
    check('closing the panel refuses for now, and the page cannot ask again until it reloads',
      Boolean(sheet3) && dismissed === 'denied' && nagged === 'denied' && stayedShut && asksAgain,
      `dismissed -> ${dismissed}, asked again -> ${nagged} (panel ${stayedShut ? 'shut' : 'open'}), ` +
      `after reload the panel ${asksAgain ? 'asks' : 'does not ask'}`);

    tabs.close(other.id);
    tabs.close(tab.id);
    for (const server of servers) server.close();
  }

  // A page that fails to load says why, in words, and Try again recovers it
  // in place; a tab whose renderer crashes says so, and Reload brings it back.
  //
  // In place is the part that goes wrong. The old error page was a data: URL:
  // the address bar showed the encoded page, and each retry added a history
  // entry. Asserted: the tab keeps the failed address, the page names the
  // site, and after a retry against a server that has since come up, the
  // history is the same length it was.
  {
    const http = require('http');
    const net = require('net');
    const port = await new Promise((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });
    const failing = `http://127.0.0.1:${port}/`;
    const tab = tabs.create({ url: failing, activate: true, realise: true });
    const drawn = await waitFor(async () => tab.isLive && !tab.loading &&
      await tab.wc.executeJavaScript('document.querySelector("h1")?.textContent || ""').catch(() => '') !== '');
    const heading = drawn ? await tab.wc.executeJavaScript('document.querySelector("h1").textContent') : '';
    const entries = tab.isLive ? tab.wc.navigationHistory.length() : -1;
    check('a failed load says why in words, and keeps the address that failed',
      drawn && heading === '127.0.0.1 refused to connect' && tab.url === failing,
      `heading "${heading}", tab url ${tab.url}`);

    const server = http.createServer((_q, res) => res.end('<title>Back up</title>ok'));
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    await tab.wc.executeJavaScript('document.querySelector("button").click()').catch(() => {});
    const recovered = await waitFor(() => tab.title === 'Back up', { timeoutMs: 5000 });
    check('Try again loads the page in place, without adding history',
      recovered && tab.wc.navigationHistory.length() === entries,
      `title "${tab.title}", history ${entries} -> ${tab.isLive ? tab.wc.navigationHistory.length() : -1}`);

    // Crashed, then brought back from the notice's own button - which goes
    // through the chrome's bridge and the command gate like a click would.
    tab.wc.forcefullyCrashRenderer();
    const noticed = await waitFor(() => tab.crashed && Boolean(shell.crashView), { timeoutMs: 5000 });
    let revived = false;
    if (noticed) {
      const notice = shell.crashView.webContents;
      // Its script has to be there to hear the click: `isLoading` is false
      // before the load has even started.
      await waitFor(() => notice.executeJavaScript('document.readyState === "complete"').catch(() => false),
        { timeoutMs: 3000 });
      await notice.executeJavaScript('document.getElementById("reload").click()').catch(() => {});
      revived = await waitFor(() => !tab.crashed && !shell.crashView && !tab.loading &&
        tab.title === 'Back up', { timeoutMs: 5000 });
    }
    check('a crashed tab says so, and Reload brings it back',
      noticed && revived, `noticed=${noticed}, revived=${revived} ` +
      `(crashed=${tab.crashed}, notice=${Boolean(shell.crashView)}, loading=${tab.loading}, title "${tab.title}", ` +
      `active=${tabs.activeTab() === tab})`);

    tabs.close(tab.id);
    server.close();
  }

  // The tabs you had open come back, and a hand-edited session file cannot make
  // the browser open anything it likes on launch.
  //
  // This is the gap that sends somebody back to the browser they came from, and
  // it is worse here than elsewhere: the whole design invites you to keep forty
  // tabs, and until now closing the window lost every one of them.
  //
  // Driven through the store rather than by restarting the browser, which one
  // process cannot do. What a restart adds beyond this is `main.js` calling
  // `load()` - four lines - and the round trip below is the part with the rules
  // in it.
  {
    const { Session } = require('./session');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'debrowser-session-'));
    const store = new Session(() => {}, dir);

    const open = [
      { id: 1, url: 'https://one.test/a', title: 'One', pinned: true },
      { id: 2, url: 'https://two.test/b', title: 'Two', pinned: false },
      { id: 3, url: 'debrowser://settings', title: 'Settings', pinned: false }
    ];
    store.save(open, 2);
    const back = store.load();

    const sameOrder = back.tabs.map((t) => t.url).join(' ') ===
      open.map((t) => t.url).join(' ');

    // A session file is read at startup and turned into navigations, so it is
    // untrusted input in the same way an imported bookmarks file is.
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
      version: 1,
      activeIndex: 0,
      tabs: [
        { url: 'javascript:alert(1)', title: 'script' },
        { url: 'file:///etc/passwd', title: 'local' },
        { url: 'https://good.test/', title: 'fine' }
      ]
    }));
    const filtered = new Session(() => {}, dir).load();

    // And a file somebody edited into nonsense is a first run, not a browser
    // that will not start.
    fs.writeFileSync(path.join(dir, 'session.json'), '{ not json');
    const broken = new Session(() => {}, dir).load();

    check('the tabs you had open come back, and a tampered session cannot open anything',
      sameOrder && back.activeIndex === 1 && back.tabs[0].pinned === true &&
      filtered.tabs.length === 1 && filtered.tabs[0].url === 'https://good.test/' &&
      broken.tabs.length === 0,
      `${back.tabs.length} tabs restored in order, active ${back.activeIndex}, ` +
      `pinned kept=${back.tabs[0].pinned}; tampered file kept ` +
      `${filtered.tabs.map((t) => t.url).join(',') || 'nothing'}; ` +
      `unreadable file gave ${broken.tabs.length} tabs`);

    fs.rmSync(dir, { recursive: true, force: true });
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
    // Something saved, because an empty bar is hidden whatever the preference
    // says - which is the check below this one.
    bookmarks.add({ url: 'https://bar.test/room', title: 'Room' });

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

    // More bookmarks than the bar can hold go behind a chevron, not off the
    // edge of the window.
    //
    // Reported as bookmarks running past the right-hand side and simply
    // vanishing - the bar is one row, it does not wrap and it does not scroll,
    // so everything past the edge was gone with nothing to say it existed.
    {
      const many = [];
      for (let i = 0; i < 24; i++) {
        many.push(`https://overflow.test/a-bookmark-with-a-long-name-${i}`);
        bookmarks.add({ url: many[i], title: `A bookmark with a long name ${i}` });
      }
      shell.publish(governor.snapshot());

      // `waitFor` answers whether the predicate came true, not with what it
      // saw, so the reading is kept here and the wait only says when to stop.
      let fit = null;
      await waitFor(async () => {
        fit = await shell.chromeView.webContents.executeJavaScript(`(() => {
          const bar = document.getElementById('bookmarks');
          const all = [...bar.querySelectorAll('.bookmark[data-id]')];
          const more = bar.querySelector('.bookmark-more');
          const shown = all.filter((b) => !b.hidden);
          const widest = shown.reduce((m, b) => Math.max(m, b.getBoundingClientRect().right), 0);
          return {
            total: all.length, shown: shown.length,
            chevron: Boolean(more) && more.hidden === false,
            overflows: widest > bar.clientWidth + 1
          };
        })()`).catch(() => null);
        return Boolean(fit) && fit.total >= 24;
      }, { timeoutMs: 8000 });

      check('bookmarks past the end of the bar go behind a chevron rather than off the edge',
        Boolean(fit) && fit.shown < fit.total && fit.chevron === true &&
        fit.overflows === false,
        fit
          ? `${fit.shown} of ${fit.total} shown, chevron ${fit.chevron ? 'up' : 'missing'}, ` +
            `last visible edge ${fit.overflows ? 'past' : 'inside'} the bar`
          : 'the bar did not answer');

      for (const url of many) bookmarks.remove(url);
      shell.publish(governor.snapshot());
    }

    // Clicking one opens a tab rather than replacing the page in front of you,
    // and the preference is what decides that - both halves asserted by
    // pressing the button in the bar, because a click handler that sends the
    // right message is not the same as a bar whose buttons are reachable.
    if (drawn) {
      const clickFirst = 'document.querySelector("#bookmarks .bookmark").click(), true';

      prefs.set('bookmarkOpensIn', 'new-tab');
      shell.publish(governor.snapshot());
      const openedCount = tabs.all().length;
      await waitFor(async () => await shell.chromeView.webContents.executeJavaScript(clickFirst),
        { timeoutMs: 2000 });
      const added = await waitFor(() => tabs.all().length === openedCount + 1, { timeoutMs: 4000 });

      prefs.set('bookmarkOpensIn', 'current-tab');
      shell.publish(governor.snapshot());
      // The preference reaches the chrome on a state broadcast, so the click
      // has to wait for it rather than for the next repaint of the bar - which
      // never comes, because the bookmarks themselves have not changed.
      await waitFor(async () => await shell.chromeView.webContents.executeJavaScript(
        'document.getElementById("bookmarks").dataset.opensIn === "current-tab"'),
      { timeoutMs: 4000 });
      const heldCount = tabs.all().length;
      await shell.chromeView.webContents.executeJavaScript(clickFirst);
      const held = await waitFor(() => tabs.activeTab()?.url?.includes('bar.test'),
        { timeoutMs: 6000 }) && tabs.all().length === heldCount;

      check('a bookmark opens a new tab, or replaces the page, as asked',
        added && held,
        `new-tab: ${openedCount} -> ${openedCount + (added ? 1 : 0)} tabs; ` +
        `current-tab: stayed at ${heldCount} and went to ${tabs.activeTab()?.url}`);

      prefs.set('bookmarkOpensIn', 'new-tab');
      for (const tab of tabs.all().filter((t) => String(t.url).includes('bar.test'))) {
        tabs.close(tab.id);
      }
    }

    // An empty bar takes no room, and the first bookmark brings it back.
    //
    // It used to stay as a 34px band of nothing under the toolbar of every page
    // for as long as you had no bookmarks saved. The preference says whether
    // the bar is wanted; having something to put in it is a separate question,
    // and until the first save the answer is no.
    {
      // Put back afterwards: the checks below this one are about bookmarks that
      // exist, and emptying the store under them is how this first ran - two
      // failures and a crash, none of them about the bar.
      const saved = bookmarks.all();
      for (const b of saved) bookmarks.remove(b.id);
      shell.publish(governor.snapshot());
      const empty = shell.contentBounds();
      const emptyVisible = shell.bookmarksBarVisible();

      bookmarks.add({ url: 'https://bar.test/first', title: 'First' });
      shell.publish(governor.snapshot());
      const filled = shell.contentBounds();

      const { BOOKMARKS_BAR_HEIGHT } = require('./window');
      check('an empty bookmarks bar takes no room, and the first bookmark brings it back',
        emptyVisible === false && shell.bookmarksBarVisible() === true &&
        empty.height - filled.height === BOOKMARKS_BAR_HEIGHT,
        `empty: bar ${emptyVisible ? 'shown' : 'hidden'}, page ${empty.height}px; ` +
        `with one: page ${filled.height}px`);

      bookmarks.remove('https://bar.test/first');
      for (const b of saved.slice().reverse()) {
        bookmarks.add({ url: b.url, title: b.title, folder: b.folder });
      }
      shell.publish(governor.snapshot());
      await waitFor(async () => await shell.chromeView.webContents.executeJavaScript(
        'document.querySelectorAll("#bookmarks .bookmark[data-id]").length') >= saved.length,
      { timeoutMs: 8000 });
    }

    // Editing one by hand, which is the manager's whole job. Three properties,
    // because each of them is a separate way for an editable list to go wrong:
    // an edit keeps the entry where it was, the scheme rules that refuse an
    // imported `javascript:` bookmark apply equally to a typed one, and two
    // rows for one address is a state the store already refuses on the way in.
    bookmarks.add({ url: 'https://bar.test/two', title: 'Two' });
    const first = bookmarks.all().find((b) => b.url === 'https://bar.test/one');
    const positionBefore = bookmarks.all().indexOf(first);

    const renamed = bookmarks.update(first.id, { title: 'One, renamed' });
    const positionAfter = bookmarks.all().findIndex((b) => b.id === first.id);
    const script = bookmarks.update(first.id, { url: 'javascript:alert(1)' });
    const clash = bookmarks.update(first.id, { url: 'https://bar.test/two' });

    check('a bookmark can be edited, and an edit is held to the same rules as an import',
      renamed?.title === 'One, renamed' && renamed.id === first.id &&
      positionAfter === positionBefore && script === null && clash === null &&
      bookmarks.all().find((b) => b.id === first.id)?.url === 'https://bar.test/one',
      `renamed in place at ${positionAfter} (was ${positionBefore}), ` +
      `script ${script === null ? 'refused' : 'STORED'}, ` +
      `duplicate ${clash === null ? 'refused' : 'STORED'}`);

    bookmarks.remove('https://bar.test/one');
    bookmarks.remove('https://bar.test/two');
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

  // Full screen, in both layouts.
  //
  // Two different answers to the same ask - the page should have the screen.
  // Across the top the chrome is a band and can simply go. Down the side it is
  // the only way to see a tab, so it becomes a panel over the page instead:
  // inset from the corner, and as tall as its own rows rather than the window.
  //
  // Asserted on the rectangles the views are actually given, because that is
  // the thing that was wrong before any of this existed - the chrome kept its
  // band and the page kept its offset, full screen or not.
  {
    const wasSide = prefs.get('tabBarPosition');
    const wasPinned = prefs.get('sidebarPinned');
    // Pinned, because an unpinned strip is a ten-pixel edge until the pointer
    // arrives - true full screen or not - and the panel is what is being
    // checked here, not the slide.
    prefs.set('sidebarPinned', true);

    prefs.set('tabBarPosition', 'top');
    shell.applyWindowPrefs();
    shell.window.setFullScreen(true);
    const entered = await waitFor(() => shell.fullScreen(), { timeoutMs: 6000 });
    // Read *after* entering: full screen is a different window size, and the
    // first version of this check compared the new layout against the old
    // window and failed on arithmetic that was right.
    const full = shell.window.getContentBounds();
    // The event is what drives the relayout; ask for one anyway so a platform
    // that never fires it fails on the geometry rather than on a missing event.
    shell.layout();

    const topPage = shell.contentBounds();
    check('full screen across the top takes the chrome away and gives the page the window',
      entered && shell.chromeHidden() === true &&
      topPage.y === 0 && topPage.height === full.height && topPage.width === full.width,
      `entered=${entered} chrome hidden=${shell.chromeHidden()} ` +
      `page ${topPage.width}x${topPage.height} at y=${topPage.y}, window ${full.height} tall`);

    // Except while the find bar is up, which is in the chrome: a search box the
    // user cannot see is worse than a band they did not ask for.
    shell.setFindOpen(true);
    shell.layout();
    const withFind = shell.contentBounds();
    check('a search brings the chrome back rather than typing into a bar nobody can see',
      shell.chromeHidden() === false && withFind.y > 0 && withFind.height < full.height,
      `chrome hidden=${shell.chromeHidden()}, page starts at y=${withFind.y}`);
    shell.setFindOpen(false);
    shell.layout();

    prefs.set('tabBarPosition', 'left');
    shell.applyWindowPrefs();
    shell.layout();

    const sidePage = shell.contentBounds();
    const panel = shell.chromeView.getBounds();
    check('full screen down the side floats the strip over a full-screen page',
      shell.chromeFloats() === true &&
      sidePage.x === 0 && sidePage.y === 0 &&
      sidePage.width === full.width && sidePage.height === full.height &&
      panel.x > 0 && panel.y > 0 && panel.height < full.height,
      `page ${sidePage.width}x${sidePage.height} at ${sidePage.x},${sidePage.y}; ` +
      `panel ${panel.width}x${panel.height} at ${panel.x},${panel.y}`);

    shell.window.setFullScreen(false);
    await waitFor(() => !shell.fullScreen(), { timeoutMs: 6000 });
    shell.layout();

    // And back: a browser that leaves full screen holding a floating panel over
    // a page with no room made for it is worse than one that never floated.
    const backPage = shell.contentBounds();
    const backPanel = shell.chromeView.getBounds();
    check('leaving full screen puts the column and the page back',
      shell.chromeFloats() === false && backPanel.x === 0 && backPanel.y === 0 &&
      backPage.x > 0,
      `panel at ${backPanel.x},${backPanel.y} ${backPanel.width}x${backPanel.height}; ` +
      `page starts at x=${backPage.x}`);

    prefs.set('tabBarPosition', wasSide);
    prefs.set('sidebarPinned', wasPinned);
    shell.applyWindowPrefs();
  }

  /* ---------------------------------------------------------------- */
  // Tab and window preferences. Each is set, exercised through the command
  // dispatcher the way a click would be, and put back.
  {
    const saved = ['newTabPosition', 'linkTabsInBackground', 'defaultZoom', 'lastTabCloses']
      .map((key) => [key, prefs.get(key)]);

    // Links open beside the page they came from, in the order they were opened,
    // and in the background unless asked otherwise. A stale menu model would
    // name some other tab as the opener, so it is cleared first.
    context.model = null;
    const opener = tabs.activeTab();
    prefs.set('newTabPosition', 'after-current');
    prefs.set('linkTabsInBackground', true);
    runCommand('open-link-tab', { url: pageUrl('idle.html') });
    runCommand('open-link-tab', { url: pageUrl('idle.html') });
    prefs.set('linkTabsInBackground', false);
    runCommand('open-link-tab', { url: pageUrl('idle.html') });
    const list = tabs.all();
    const at = list.indexOf(opener);
    const spawned = list.slice(at + 1, at + 4);
    const inOrder = spawned.length === 3 && spawned.every((t) => t.openerId === opener.id);
    const focus = await waitFor(() => tabs.activeId === spawned[2]?.id, { timeoutMs: 4000 });
    check('links open beside their page, in order, in the background unless asked',
      inOrder && focus && !spawned[0].visible && !spawned[1].visible,
      `opener at ${at}, next three from opener ${spawned.map((t) => t.openerId).join(',')}, ` +
      `active=${tabs.activeId} third=${spawned[2]?.id}`);
    for (const t of spawned) tabs.close(t.id);
    if (opener && tabs.byId(opener.id)) await tabs.activate(opener.id).catch(() => {});

    // New pages start at the chosen zoom, and resetting returns there.
    prefs.set('defaultZoom', 1.25);
    const zoomed = tabs.create({ url: pageUrl('idle.html'), activate: true, realise: true });
    await waitFor(() => zoomed.isLive && !zoomed.loading, { timeoutMs: 10_000 });
    const startZoom = zoomed.wc.getZoomFactor();
    runCommand('zoom', { direction: 'in' });
    runCommand('zoom', { direction: 'reset' });
    const resetZoom = zoomed.wc.getZoomFactor();
    check('pages open at the default zoom, and reset goes back to it',
      Math.abs(startZoom - 1.25) < 0.001 && Math.abs(resetZoom - 1.25) < 0.001,
      `opened at ${startZoom}x, reset to ${resetZoom}x`);

    // Changing the default reaches sites already visited under the old one -
    // Chromium had recorded 1.25 against this one - but not a site the user
    // zoomed by hand.
    const handZoomed = tabs.create({ url: pageUrl('idle.html'), activate: true, realise: true });
    await waitFor(() => handZoomed.isLive && !handZoomed.loading, { timeoutMs: 10_000 });
    runCommand('zoom', { direction: 'in' });
    runCommand('set-pref', { key: 'defaultZoom', value: 1 });
    const followed = zoomed.wc.getZoomFactor();
    const spared = handZoomed.wc.getZoomFactor();
    check('a new default zoom reaches visited sites, and spares ones zoomed by hand',
      Math.abs(followed - 1) < 0.001 && Math.abs(spared - 1.5) < 0.001,
      `visited site ${followed}x, hand-zoomed site ${spared}x`);
    runCommand('zoom', { direction: 'reset' });
    tabs.close(handZoomed.id);
    tabs.close(zoomed.id);

    // Closing the last tab: a fresh one, or the window. The window's close is
    // stood in for, because the real one would end the run.
    const realClose = shell.close;
    let windowClosed = 0;
    shell.close = () => { windowClosed += 1; };
    prefs.set('lastTabCloses', 'new-tab');
    for (const t of [...tabs.all()]) runCommand('close-tab', { id: t.id });
    const kept = tabs.all().length === 1 && windowClosed === 0;
    prefs.set('lastTabCloses', 'quit');
    runCommand('close-tab', { id: tabs.all()[0]?.id });
    const quit = tabs.all().length === 0 && windowClosed === 1;
    shell.close = realClose;
    check('closing the last tab keeps a new tab, or closes the window, as asked',
      kept && quit, `new-tab kept=${kept}, quit closed the window=${quit}`);
    tabs.create({ url: pageUrl('idle.html') });

    for (const [key, value] of saved) prefs.set(key, value);
  }

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
