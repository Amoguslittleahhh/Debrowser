'use strict';

/**
 * Q: Is `getAppMetrics().memory.workingSetSize`, summed across processes, a
 *    truthful measure of how much memory this browser uses?
 *
 * Why it mattered: every number this project produced for weeks was that sum.
 * It is resident set size, and RSS counts every page a process has resident -
 * *including pages shared with other processes*. The largest mapping in a
 * Chromium browser is the executable itself, mapped into every renderer. So
 * summing RSS counts one copy of Chromium once per renderer.
 *
 * Result, six tabs of a trivial page:
 *
 *     summed RSS    810 MB
 *     summed PSS    247 MB
 *     per tab       85.9 MB RSS  ->  19.8 MB PSS  (10.0 MB private)
 *
 * The reported footprint was roughly three times the real one. Worse, the
 * governor compared that inflated figure against its memory budget, so it
 * believed it was over budget at a third of the real usage and reclaimed far
 * more aggressively than it needed to.
 *
 * PSS (proportional set size) divides each shared page by the number of
 * processes mapping it, so summing it corresponds to physical memory. It is a
 * Linux figure, from /proc/<pid>/smaps_rollup; macOS and Windows have no cheap
 * equivalent and the browser falls back to RSS there, labelled as such.
 *
 * The private figure is the one to reason about when asking "what does one more
 * tab cost": about 10MB for a light page, the rest being that tab's share of
 * Chromium.
 *
 * Run: xvfb-run -a npx electron experiments/07-rss-vs-pss.js --no-sandbox --disable-gpu \
 *        --host-resolver-rules="MAP *.test 127.0.0.1" [--page=heavy.html] [--n=6]
 */

const fs = require('fs');
const { run, makeWindow, openPage, sleep, arg, app } = require('./lib');
const fixtureServer = require('../src/main/fixture-server');

/** Per-process breakdown straight from the kernel. */
function smaps(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const field = (key) => {
      const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
      return m ? Number(m[1]) / 1024 : 0;
    };
    return {
      rss: field('Rss'),
      pss: field('Pss'),
      priv: field('Private_Clean') + field('Private_Dirty'),
      shared: field('Shared_Clean') + field('Shared_Dirty')
    };
  } catch {
    return null;
  }
}

run(`07 - is summed RSS a truthful footprint? (page=${arg('page', 'idle.html')})`, async () => {
  if (process.platform !== 'linux') {
    console.log('  PSS is a Linux figure; this experiment needs /proc/pid/smaps_rollup.');
    return 0;
  }

  const page = arg('page', 'idle.html');
  const count = Number(arg('n', '6'));

  const fixtures = await fixtureServer.start();
  const win = makeWindow();

  // Distinct sites, so each tab owns a renderer and the per-tab figures are
  // exactly attributable rather than a share of somebody else's process.
  for (let i = 0; i < count; i++) {
    const { view } = await openPage(win, fixtures.url(page, i), { show: i === count - 1 });
    if (i !== count - 1) view.setVisible(false);
  }
  await sleep(5000);

  let electronRss = 0;
  let rss = 0;
  let pss = 0;
  let priv = 0;
  let renderers = 0;
  let appRss = 0;
  let appPss = 0;

  for (const proc of app.getAppMetrics()) {
    const detail = smaps(proc.pid);
    if (!detail) continue;
    appRss += detail.rss;
    appPss += detail.pss;
    if (proc.type !== 'Tab') continue;
    renderers += 1;
    electronRss += (proc.memory?.workingSetSize || 0) / 1024;
    rss += detail.rss;
    pss += detail.pss;
    priv += detail.priv;
  }

  console.log(`  renderers                 : ${renderers}`);
  console.log(`  Electron workingSetSize   : ${Math.round(electronRss)} MB  (what was reported)`);
  console.log(`  kernel Rss                : ${Math.round(rss)} MB  (agrees - same metric)`);
  console.log(`  kernel Pss                : ${Math.round(pss)} MB  (actual physical memory)`);
  console.log(`  kernel Private            : ${Math.round(priv)} MB  (marginal cost of these tabs)`);
  console.log('');
  console.log(`  per tab: RSS ${(rss / renderers).toFixed(1)} MB  ` +
              `PSS ${(pss / renderers).toFixed(1)} MB  private ${(priv / renderers).toFixed(1)} MB`);
  console.log(`  whole app: RSS ${Math.round(appRss)} MB  PSS ${Math.round(appPss)} MB`);

  const ratio = pss ? rss / pss : 0;
  console.log(`\n  CONCLUSION: summed RSS overstates the real footprint by ${ratio.toFixed(1)}x here.`);

  await fixtures.close();
  return 0;
});
