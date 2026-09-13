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
const BUDGET = arg('budget', null); // MB; constrains the governed run only

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
    if (!withGovernor) args.push('--no-governor');
    // The budget only means anything to the governed run; the baseline has no
    // governor to enforce it, which is exactly the comparison being drawn.
    if (withGovernor && BUDGET) args.push(`--budget=${BUDGET}`);
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
              `${BUDGET ? `, ${BUDGET} MB budget` : ''}\n`);

  process.stdout.write('  running baseline (no governor)... ');
  const off = await runOnce(false);
  console.log(`${off.settledMB} MB`);

  process.stdout.write('  running with governor...          ');
  const on = await runOnce(true);
  console.log(`${on.settledMB} MB\n`);

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
  row('peak during load', `${off.peakMB} MB`, `${on.peakMB} MB`, '');

  console.log(`\n  saving: ${pct.toFixed(1)}%`);
  console.log(`  governed tab states: ${JSON.stringify(on.tiers)}\n`);

  function row(label, a, b, d) {
    console.log(`  ${pad(label, 22)}${padL(a, 12)}${padL(b, 12)}${padL(d, 12)}`);
  }
})().catch((err) => {
  console.error(`\nbenchmark failed: ${err.message}\n`);
  process.exit(1);
});
