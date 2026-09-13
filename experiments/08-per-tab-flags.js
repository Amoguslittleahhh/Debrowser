'use strict';

/**
 * Q: Which Chromium/V8 flags actually reduce what one tab costs?
 *
 * Why it mattered: the request was to make each tab cheaper rather than to
 * limit how many tabs can be open. Every "make Electron use less RAM" list
 * offers the same handful of flags; none of them had been measured here, and
 * one of them (`--max-semi-space-size`) was already shipping on the strength of
 * a plausible-sounding argument alone.
 *
 * Flags are process-wide and read at startup, so each candidate needs its own
 * launch. Pass one configuration per run and compare the printed per-tab PSS.
 *
 * Results on a DOM-heavy page, six tabs, per tab, in PSS:
 *
 *     (none)                     37.9 - 41.2 MB   (varies run to run)
 *     --js-flags=--optimize-for-size   33.0 MB   <- the only real win,
 *                                                  13-20% depending on the run
 *     --enable-low-end-device-mode    32.9 MB   same saving, does not stack
 *                                               (33.5 MB combined), and also
 *                                               shrinks image caches
 *     --max-semi-space-size=2         38.4 MB   no effect
 *     --max-semi-space-size=16        38.4 MB   no effect
 *     --num-raster-threads=1          40.4 MB   worse
 *     --disable-features=BackForwardCache       no effect
 *     spellcheck: false                         no effect (0.1 MB)
 *
 * Conclusion: ship `--optimize-for-size`, drop the semi-space flag that had
 * been set on an assumption, and do not pay low-end-device-mode's quality cost
 * for a saving already obtained.
 *
 * Note this is measured in PSS. Under RSS every one of these rows reads
 * 85-113 MB and the differences vanish into the shared-page noise, which is how
 * an ineffective flag survived in the codebase - see experiment 07.
 *
 * Run (one config per launch):
 *   xvfb-run -a npx electron experiments/08-per-tab-flags.js --no-sandbox --disable-gpu \
 *     --host-resolver-rules="MAP *.test 127.0.0.1" --label=optsize \
 *     --js-flags=--optimize-for-size
 */

const fs = require('fs');
const { run, makeWindow, openPage, sleep, arg, app } = require('./lib');
const fixtureServer = require('../src/main/fixture-server');

function pssOf(pid) {
  try {
    const m = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+) kB/m);
    return m ? Number(m[1]) / 1024 : 0;
  } catch {
    return 0;
  }
}
function privateOf(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const f = (k) => {
      const m = text.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'));
      return m ? Number(m[1]) / 1024 : 0;
    };
    return f('Private_Clean') + f('Private_Dirty');
  } catch {
    return 0;
  }
}

run(`08 - per-tab cost under flags (label=${arg('label', 'none')})`, async () => {
  if (process.platform !== 'linux') {
    console.log('  Needs /proc/pid/smaps_rollup for PSS; see experiment 07.');
    return 0;
  }

  const page = arg('page', 'heavy.html');
  const count = Number(arg('n', '6'));
  // Electron honours this per-WebContents, so it is a constructor option here
  // rather than a command-line switch like the rest.
  const spellcheck = !process.argv.includes('--no-spellcheck');

  const fixtures = await fixtureServer.start();
  const win = makeWindow();

  for (let i = 0; i < count; i++) {
    const { view } = await openPage(win, fixtures.url(page, i),
      { show: i === count - 1, spellcheck });
    if (i !== count - 1) view.setVisible(false);
  }
  await sleep(5000);

  let pss = 0;
  let priv = 0;
  let rss = 0;
  let renderers = 0;
  for (const proc of app.getAppMetrics()) {
    if (proc.type !== 'Tab') continue;
    renderers += 1;
    pss += pssOf(proc.pid);
    priv += privateOf(proc.pid);
    rss += (proc.memory?.workingSetSize || 0) / 1024;
  }

  console.log(`  page=${page} renderers=${renderers} spellcheck=${spellcheck}`);
  console.log(`  per tab : PSS ${(pss / renderers).toFixed(1)} MB  ` +
              `private ${(priv / renderers).toFixed(1)} MB  ` +
              `RSS ${(rss / renderers).toFixed(1)} MB`);
  console.log(`\n  Compare PSS against other launches. RSS is shown only to make the point` +
              `\n  that it cannot distinguish these configurations.`);

  await fixtures.close();
  return 0;
});
