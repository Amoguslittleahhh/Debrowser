'use strict';

/**
 * In-process benchmark scenario.
 *
 * Opens a fixed set of tabs, leaves them to settle, and reports the browser's
 * total resident memory. Run once with the governor enabled and once without
 * (`--no-governor`) and the difference is the governor's actual contribution,
 * measured rather than asserted.
 *
 * Driven by `bench/bench.js`, which runs both halves and prints the comparison.
 * Emits a single JSON line on stdout so the parent can parse it unambiguously.
 */

const fixtureServer = require('./fixture-server');
const { footprintMB, accountingMode } = require('./memory');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Page shapes, cycled to reach the requested tab count.
 *
 * `default` includes a form page holding unsubmitted input, which the governor
 * refuses to discard - so a quarter of the tabs are deliberately immune to
 * reclaim. That is the right stress test for the protections, but it sets a
 * floor on how far any cap can get, so `noforms` exists to measure the cap
 * itself against tabs that are all actually reclaimable.
 */
const MIXES = {
  default: ['heavy.html', 'idle.html', 'animated.html', 'form.html'],
  noforms: ['heavy.html', 'idle.html', 'animated.html', 'busy.html']
};

async function runBench({ tabs, governor, app, cfg, tabCount, settleMs, coldMs, freezeMs, distinctOrigins, mix = 'default' }) {
  const MIX = MIXES[mix] || MIXES.default;
  // Compress the idle ladder so a benchmark run takes seconds rather than the
  // half hour the real timings imply. The policy is identical; only the clock
  // moves, and the no-governor run is unaffected either way.
  //
  // `coldMs`/`freezeMs` are overridable so a run can hold tabs at a chosen
  // tier - setting them beyond the run length keeps every tab WARM, which
  // isolates the governor's fixed overhead from the cost of what it does.
  if (governor) {
    cfg.coldAfterMs = coldMs ?? 2000;
    cfg.freezeAfterMs = freezeMs ?? 4000;
    cfg.minLifetimeMs = 1500;
    cfg.tickMs = 500;
    governor.stop();
    governor.start();
  }

  // One distinct site per tab, or plain file:// URLs. See startFixtureServer.
  let fixtures = null;
  let urlFor = (i) => fixtureServer.fileUrl(MIX[i % MIX.length]);
  if (distinctOrigins) {
    fixtures = await fixtureServer.start();
    urlFor = (i) => fixtures.url(MIX[i % MIX.length], i);
  }

  // Reuse the tab the browser opened with, then add the rest.
  const first = tabs.all()[0];
  await first.wc.loadURL(urlFor(0)).catch(() => {});

  for (let i = 1; i < tabCount; i++) {
    tabs.create({ url: urlFor(i), activate: false, realise: true });
    // Stagger slightly so a dozen renderers do not all start at once, which
    // would distort the peak reading without changing the settled one.
    await sleep(250);
  }

  // Wait for every tab to finish loading before the clock starts.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (tabs.all().every((t) => !t.isLive || (!t.loading && t.pid))) break;
    await sleep(250);
  }

  const peak = await measure(app);
  await sleep(settleMs);
  const settled = await measure(app);
  const breakdown = byProcessType(app);

  const live = tabs.all().filter((t) => t.isLive).length;
  const byTier = {};
  for (const tab of tabs.all()) byTier[tab.tier] = (byTier[tab.tier] || 0) + 1;

  const renderers = new Set();
  for (const proc of app.getAppMetrics()) if (proc.type === 'Tab') renderers.add(proc.pid);

  // Why each surviving renderer survived. Without this, a governed run that
  // lands above its cap is indistinguishable from a cap that does not work -
  // the difference is whether the remaining tabs are protected, and by what.
  const liveDetail = tabs.all()
    .filter((t) => t.isLive)
    .map((t) => ({
      id: t.id,
      tier: t.tier,
      visible: t.visible,
      audible: t.audible,
      dirty: t.hasDirtyInput,
      loading: t.loading,
      cpu: Math.round((t.cpu || 0) * 100) / 100,
      url: String(t.url).split('/').pop()
    }));

  if (fixtures) await fixtures.close();

  return {
    governor: Boolean(governor),
    accounting: accountingMode(),
    profile: cfg.profile,
    distinctOrigins: Boolean(distinctOrigins),
    maxLiveTabs: cfg.maxLiveTabs,
    tabCount,
    peakMB: peak,
    settledMB: settled,
    perTabMB: Math.round((settled / tabCount) * 10) / 10,
    liveRenderers: renderers.size,
    liveTabs: live,
    tiers: byTier,
    mix,
    protectedLive: liveDetail.filter((t) => !t.visible && (t.dirty || t.audible)).length,
    liveDetail,
    breakdown
  };
}

/**
 * Split resident memory by process role.
 *
 * Aggregate totals hide where a regression lives: a governor that saves memory
 * in every renderer can still lose overall by spending it in the browser
 * process. This breakdown is what makes that visible.
 */
function byProcessType(app) {
  const out = {};
  for (const proc of app.getAppMetrics()) {
    const key = proc.type || 'unknown';
    out[key] = (out[key] || 0) + footprintMB(proc.pid, (proc.memory?.workingSetSize || 0) / 1024);
  }
  for (const key of Object.keys(out)) out[key] = Math.round(out[key]);
  return out;
}

/**
 * Total memory across every process in this browser.
 *
 * Proportional set size where the platform offers it, not RSS. Summing RSS
 * across processes counts the Chromium binary once per renderer and overstated
 * this figure by roughly 3x - see ../memory.js.
 */
async function measure(app, samples = 8, gapMs = 250) {
  let total = 0;
  for (let i = 0; i < samples; i++) {
    total = app.getAppMetrics().reduce(
      (sum, p) => sum + footprintMB(p.pid, (p.memory?.workingSetSize || 0) / 1024), 0);
    await sleep(gapMs);
  }
  return Math.round(total);
}

module.exports = { runBench };
