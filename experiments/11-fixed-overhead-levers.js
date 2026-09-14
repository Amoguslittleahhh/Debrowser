#!/usr/bin/env node
'use strict';
/**
 * M7: can fixed overhead be reduced?
 *
 * M1 measured ~238MB of fixed overhead against a 300MB budget at 30 tabs, so
 * every megabyte freed here is worth more than a megabyte saved per tab. Each
 * variant below collapses or removes one of the auxiliary processes. All are
 * measured at the same tab count with the governor off.
 *
 * Several of these weaken process isolation. None is a default; this run only
 * establishes what they are worth.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const TABS = Number(process.env.TABS || 6);
const REPS = Number(process.env.REPS || 2);

const VARIANTS = [
  { name: 'baseline',            flags: [] },
  { name: 'in-process-gpu',      flags: ['--in-process-gpu'] },
  { name: 'no-zygote',           flags: ['--no-zygote'] },
  { name: 'network-in-process',  flags: ['--enable-features=NetworkServiceInProcess'] },
  { name: 'all three',           flags: ['--in-process-gpu', '--no-zygote',
                                         '--enable-features=NetworkServiceInProcess'] }
];

function runOnce(flags) {
  return new Promise((resolve, reject) => {
    const args = ['.', '--bench-test', '--no-governor', `--tabs=${TABS}`,
                  '--settle=6000', '--mix=noforms', '--distinct-origins',
                  '--disable-gpu', '--no-sandbox', ...flags];
    const child = spawn(ELECTRON, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('__BENCH__'));
      if (!line) return resolve(null);           // variant failed to start
      resolve(JSON.parse(line.slice('__BENCH__'.length)));
    });
  });
}

(async () => {
  console.log(`\nM7 - fixed overhead levers (${TABS} tabs, governor off, ${REPS} reps)\n`);
  console.log(`  ${'variant'.padEnd(22)}${'total'.padStart(9)}${'renderers'.padStart(11)}   breakdown`);
  console.log(`  ${'-'.repeat(78)}`);
  const results = [];
  for (const v of VARIANTS) {
    const runs = [];
    for (let i = 0; i < REPS; i++) {
      const r = await runOnce(v.flags);
      if (r) runs.push(r);
    }
    if (!runs.length) {
      console.log(`  ${v.name.padEnd(22)}${'FAILED'.padStart(9)}   (did not start)`);
      results.push({ name: v.name, failed: true });
      continue;
    }
    const total = Math.round(runs.reduce((s, r) => s + r.settledMB, 0) / runs.length);
    const last = runs[runs.length - 1];
    console.log(`  ${v.name.padEnd(22)}${String(total + ' MB').padStart(9)}` +
                `${String(last.liveRenderers).padStart(11)}   ${JSON.stringify(last.breakdown)}`);
    results.push({ name: v.name, total, breakdown: last.breakdown, flags: v.flags });
  }
  const base = results.find((r) => r.name === 'baseline');
  console.log(`\n  ${'variant'.padEnd(22)}${'delta vs baseline'.padStart(20)}`);
  console.log(`  ${'-'.repeat(44)}`);
  for (const r of results) {
    if (r.failed || r.name === 'baseline') continue;
    const d = r.total - base.total;
    console.log(`  ${r.name.padEnd(22)}${String((d >= 0 ? '+' : '') + d + ' MB').padStart(20)}`);
  }
  fs.writeFileSync(path.join(__dirname, 'm7-results.json'), JSON.stringify(results, null, 2));
  console.log('');
})().catch((e) => { console.error(e.message); process.exit(1); });
