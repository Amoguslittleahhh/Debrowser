#!/usr/bin/env node
'use strict';

/**
 * Memory benchmark.
 *
 * Runs the same tab workload twice - once with the resource governor and once
 * with every tab left fully resident - and prints the difference. This is the
 * only honest way to state what the governor is worth, and it is why the
 * numbers in the README are reproducible rather than asserted.
 *
 *   node bench/bench.js [--tabs=12] [--profile=balanced|economy|performance]
 *
 * On a headless machine, wrap with xvfb-run:
 *   xvfb-run -a node bench/bench.js
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const TABS = Number(arg('tabs', 12));
const PROFILE = arg('profile', 'balanced');
const SETTLE = Number(arg('settle', 8000));
const BUDGET = arg('budget', null);   // MB; constrains the governed run only
const LIVE = arg('live', null);       // max live renderers; governed run only
/**
 * Origins default to distinct (t1.test, t2.test, …) because that is what real
 * browsing looks like to Chromium's process model. With `--origins=file` every
 * fixture is a file:// URL, which is a *single* site - so one-renderer-per-site
 * collapses them all into a couple of processes and the saving looks far larger
 * than anyone would actually see. Kept available, but not the default.
 */
const ORIGINS = arg('origins', 'distinct');
const MIX = arg('mix', 'default');

function runOnce(withGovernor) {
  return new Promise((resolve, reject) => {
    const args = [
      '.',
      '--bench-test',
      `--tabs=${TABS}`,
      `--settle=${SETTLE}`,
      `--profile=${PROFILE}`,
      '--disable-gpu'
    ];
    // Applied to both halves: the comparison is only fair if the baseline faces
    // the same process model as the governed run.
    if (ORIGINS === 'distinct') args.push('--distinct-origins');
    args.push(`--mix=${MIX}`);
    if (!withGovernor) args.push('--no-governor');
    // The budget only means anything to the governed run; the baseline has no
    // governor to enforce it, which is exactly the comparison being drawn.
    if (withGovernor && BUDGET) args.push(`--budget=${BUDGET}`);
    if (withGovernor && LIVE) args.push(`--max-live-tabs=${LIVE}`);
    // Containers and CI images run as root, where Chromium refuses to start
    // sandboxed. A normal desktop run never needs this.
    if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
      args.push('--no-sandbox');
    }

    const child = spawn(ELECTRON, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => { /* Chromium is noisy; the result is on stdout */ });

    child.on('error', reject);
    child.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('__BENCH__'));
      if (!line) return reject(new Error(`no benchmark result (governor=${withGovernor})`));
      try {
        resolve(JSON.parse(line.slice('__BENCH__'.length)));
      } catch (err) {
        reject(new Error(`unparseable benchmark result: ${err.message}`));
      }
    });
  });
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

(async () => {
  console.log('\nDebrowser memory benchmark');
  console.log(`  host     : ${os.platform()} ${os.arch()}, ${os.cpus().length} cores, ` +
              `${Math.round(os.totalmem() / 1024 / 1024)} MB RAM`);
  console.log(`  workload : ${TABS} tabs, ${PROFILE} profile, ${SETTLE}ms settle` +
              `${BUDGET ? `, ${BUDGET} MB budget` : ''}` +
              `${LIVE ? `, ${LIVE} live cap` : ''}`);
  console.log(`  origins  : ${ORIGINS === 'distinct' ? 'one site per tab (realistic)' : 'all file:// (one site)'}`);
  console.log(`  mix      : ${MIX}`);

  process.stdout.write('  running baseline (no governor)... ');
  const off = await runOnce(false);
  console.log(`${off.settledMB} MB`);

  process.stdout.write('  running with governor...          ');
  const on = await runOnce(true);
  console.log(`${on.settledMB} MB\n`);

  console.log(`  memory   : ${on.accounting === 'pss' ? 'proportional set size (shared pages counted once)' : 'RSS - shared pages counted per process, so over-stated'}\n`);

  const saved = off.settledMB - on.settledMB;
  const pct = off.settledMB ? (saved / off.settledMB) * 100 : 0;

  console.log(`  ${pad('', 22)}${padL('baseline', 12)}${padL('governed', 12)}${padL('delta', 12)}`);
  console.log(`  ${'-'.repeat(58)}`);
  row('total resident', `${off.settledMB} MB`, `${on.settledMB} MB`,
      `${saved >= 0 ? '-' : '+'}${Math.abs(saved)} MB`);
  row('per tab', `${off.perTabMB} MB`, `${on.perTabMB} MB`,
      `${(off.perTabMB - on.perTabMB).toFixed(1)} MB`);
  row('renderer processes', off.liveRenderers, on.liveRenderers,
      on.liveRenderers - off.liveRenderers);
  row('peak during load', `${off.peakMB} MB`, `${on.peakMB} MB`,
      `${on.peakMB - off.peakMB >= 0 ? '+' : ''}${on.peakMB - off.peakMB} MB`);
  row('live renderer cap', '—', on.maxLiveTabs ? String(on.maxLiveTabs) : 'off', '');
  row('live tabs', String(off.liveTabs), String(on.liveTabs), '');
  if (on.protectedLive) {
    console.log(`\n  note: ${on.protectedLive} of the ${on.liveTabs} live tabs are held by a ` +
                `protection (unsaved input or audio),\n        so they are immune to the cap by ` +
                `design. Use --mix=noforms to measure the cap alone.`);
  }

  // The system-wide reading, beside the per-process one. A trim that only moves
  // pages into the compressor's own accounting is not a saving, and the totals
  // above cannot show that on their own.
  const sys = on.system || {};
  if (sys.availableMB != null) {
    const before = off.system && off.system.availableMB;
    row('system available', before != null ? `${before} MB` : '—', `${sys.availableMB} MB`,
        before != null ? `${sys.availableMB - before >= 0 ? '+' : ''}${sys.availableMB - before} MB` : '');
  }
  if (sys.zramPhysicalMB != null) {
    // The delta column carries signed deltas on every other row, and this is
    // not one, so the ratio goes in a note rather than being squeezed into
    // twelve characters under a heading that says "delta".
    row('compressor holding', '—', `${sys.zramPhysicalMB} MB`, '');
    if (sys.zramStoredMB > 0) {
      const ratio = (sys.zramStoredMB / sys.zramPhysicalMB).toFixed(1);
      console.log(`\n  note: ${sys.zramStoredMB} MB left the renderers and ${sys.zramPhysicalMB} MB came back` +
                  ` as the compressor's own\n        allocation (${ratio}:1), so the net saving is` +
                  ` the total above, not the per-process figure.`);
    }
  }
  if (on.compression && !on.compression.available) {
    console.log(`\n  note: no swap or zram configured, so hibernation is inert on this host.`);
  }

  console.log(`\n  saving: ${pct.toFixed(1)}%`);
  console.log(`  governed tab states: ${JSON.stringify(on.tiers)}\n`);

  function row(label, a, b, d) {
    console.log(`  ${pad(label, 22)}${padL(a, 12)}${padL(b, 12)}${padL(d, 12)}`);
  }
})().catch((err) => {
  console.error(`\nbenchmark failed: ${err.message}\n`);
  process.exit(1);
});
