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

const path = require('path');

const PAGES = path.join(__dirname, '..', '..', 'test', 'pages');
const pageUrl = (name) => `file://${path.join(PAGES, name)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mix of page shapes, cycled to reach the requested tab count. */
const MIX = ['heavy.html', 'idle.html', 'animated.html', 'form.html'];

async function runBench({ tabs, governor, app, cfg, tabCount, settleMs, coldMs, freezeMs }) {
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

  // Reuse the tab the browser opened with, then add the rest.
  const first = tabs.all()[0];
  await first.wc.loadURL(pageUrl(MIX[0])).catch(() => {});

  for (let i = 1; i < tabCount; i++) {
    tabs.create({ url: pageUrl(MIX[i % MIX.length]), activate: false, realise: true });
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

  return {
    governor: Boolean(governor),
    profile: cfg.profile,
    tabCount,
    peakMB: peak,
    settledMB: settled,
    perTabMB: Math.round((settled / tabCount) * 10) / 10,
    liveRenderers: renderers.size,
    liveTabs: live,
    tiers: byTier,
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
    out[key] = (out[key] || 0) + (proc.memory?.workingSetSize || 0) / 1024;
  }
  for (const key of Object.keys(out)) out[key] = Math.round(out[key]);
  return out;
}

/** Total resident memory across every process in this browser. */
async function measure(app, samples = 8, gapMs = 250) {
  let total = 0;
  for (let i = 0; i < samples; i++) {
    total = app.getAppMetrics().reduce((sum, p) => sum + (p.memory?.workingSetSize || 0) / 1024, 0);
    await sleep(gapMs);
  }
  return Math.round(total);
}

module.exports = { runBench };
