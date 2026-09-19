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
const fs = require('fs');
const { footprintMB, accountingMode, unreportedProcessesMB,
        compressionStatus } = require('./memory');

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
  noforms: ['heavy.html', 'idle.html', 'animated.html', 'busy.html'],
  // Pages carrying cross-site subframes, as most real pages do. This is the
  // only mix that shows what site isolation costs; see test/pages/embeds.html.
  embeds: ['embeds.html'],
  // Pages holding a few hundred megabytes of live JavaScript, which is what an
  // application tab looks like. The only mix that reaches the hibernation
  // threshold: the others are light enough that the 30MB private floor
  // correctly excludes them, so a run on `noforms` shows the tier never firing
  // and says nothing about whether it works.
  bigheap: ['bigheap.html?mb=200', 'bigheap.html?mb=120']
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
    // Compressed for the same reason as the rest of the ladder. Left at its
    // real three minutes, hibernation simply never fires inside a benchmark
    // run, and the tier would look like it does nothing rather than like it was
    // never reached.
    cfg.hibernate.afterMs = 5000;
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
    breakdown,
    system: systemMemory(),
    compression: compressionStatus(),
    retained: retainedState(tabs)
  };
}

/**
 * What the browser process is holding on behalf of tabs that are not live.
 *
 * The one term in the memory model nobody had measured. `total(n) = 238MB
 * fixed + 0.6MB x tabs_open + 13.2MB x live` - the middle term is this, and it
 * is the only one that grows without bound in the workload this project exists
 * for: a discarded tab keeps every navigation entry it ever had, plus whatever
 * the page had typed into it.
 *
 * Measured as bytes of JSON rather than as heap, deliberately. What a V8 string
 * costs in memory depends on its representation - a nav entry's URL may be a
 * slice of a larger string, or interned - so heap accounting would be a guess
 * dressed as a number. Serialised bytes are what the data *is*, they are what
 * a compressor would work on, and they are reproducible.
 */
function retainedState(tabs) {
  let bytes = 0;
  let entries = 0;
  let biggest = 0;
  let withState = 0;

  for (const tab of tabs.all()) {
    const held = tab.suspendedState;
    if (!held) continue;
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(held));
    } catch { continue; }   // circular or unserialisable: not ours to measure
    bytes += size;
    biggest = Math.max(biggest, size);
    entries += Array.isArray(held.entries) ? held.entries.length : 0;
    if (held.state) withState++;
  }

  return {
    kb: Math.round(bytes / 1024),
    perTabKB: tabs.all().length ? Math.round((bytes / tabs.all().length) / 102.4) / 10 : 0,
    biggestKB: Math.round(biggest / 1024),
    navEntries: entries,
    tabsWithPageState: withState
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
  const known = new Set();
  for (const proc of app.getAppMetrics()) {
    known.add(proc.pid);
    const key = proc.type || 'unknown';
    out[key] = (out[key] || 0) + footprintMB(proc.pid, (proc.memory?.workingSetSize || 0) / 1024);
  }
  // Processes Electron does not list at all - the Linux zygotes, ~29MB of pure
  // fixed overhead. See unreportedProcessesMB in memory.js.
  for (const proc of unreportedProcessesMB(known).processes) {
    out[proc.type] = (out[proc.type] || 0) + proc.pssMB;
  }
  for (const key of Object.keys(out)) out[key] = Math.round(out[key]);
  return out;
}

/**
 * What the whole machine has spare, and what the compressor is holding.
 *
 * The guard against this project's highest-risk measurement error. Trimming a
 * renderer moves pages out of that process's accounting and into the
 * compressor's - measured at 2.1:1 - so a per-process figure alone overstates
 * the saving by roughly double. Reporting a system-wide number beside the total
 * makes that visible automatically rather than depending on someone remembering
 * to check it by hand, which is how the one correct trim measurement in this
 * project was obtained.
 *
 * Linux only; returns nulls elsewhere, where the totals are unaffected anyway.
 */
function systemMemory() {
  const out = { availableMB: null, zramStoredMB: null, zramPhysicalMB: null };
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = /MemAvailable:\s+(\d+) kB/.exec(info);
    if (m) out.availableMB = Math.round(Number(m[1]) / 1024);
  } catch { /* not Linux, or not readable */ }
  try {
    // mm_stat: orig_data_size compr_data_size mem_used_total ...
    const cols = fs.readFileSync('/sys/block/zram0/mm_stat', 'utf8').trim().split(/\s+/).map(Number);
    if (cols.length >= 3 && cols[0] > 0) {
      out.zramStoredMB = Math.round(cols[0] / 1048576);
      out.zramPhysicalMB = Math.round(cols[2] / 1048576);
    }
  } catch { /* no zram */ }
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
    const metrics = app.getAppMetrics();
    total = metrics.reduce(
      (sum, p) => sum + footprintMB(p.pid, (p.memory?.workingSetSize || 0) / 1024), 0);
    // getAppMetrics is not the whole browser: it omits Chromium's zygotes, and
    // they are fixed overhead, so leaving them out understates every figure by
    // a constant ~29MB. Measured, see memory.js.
    total += unreportedProcessesMB(new Set(metrics.map((p) => p.pid))).mb;
    await sleep(gapMs);
  }
  return Math.round(total);
}

module.exports = { runBench };
