#!/usr/bin/env node
'use strict';
/*
 * 8b: is the 238MB of fixed overhead partly caches sized from host RAM?
 *
 * M7 already showed that collapsing processes saves nothing. This asks a
 * different question: not how many processes, but how big the caches inside
 * them are. Each variant is one bench run at a fixed tab count with the
 * governor off, so only the flags differ.
 */
const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const TABS = Number(process.env.TABS || 6);
const REPS = Number(process.env.REPS || 2);

const VARIANTS = [
  { name: 'baseline',           flags: [] },
  { name: 'disk-cache=1MB',     flags: ['--disk-cache-size=1048576'] },
  { name: 'media-cache=1MB',    flags: ['--media-cache-size=1048576'] },
  { name: 'v8 code cache off',  flags: ['--v8-cache-options=none'] },
  { name: 'main-process V8',    flags: ['--js-flags=--optimize-for-size --max-old-space-size=64'] },
  { name: 'all four',           flags: ['--disk-cache-size=1048576', '--media-cache-size=1048576',
                                        '--v8-cache-options=none',
                                        '--js-flags=--optimize-for-size --max-old-space-size=64'] }
];

function runOnce(flags) {
  return new Promise((resolve, reject) => {
    const args = ['.', '--bench-test', '--no-governor', `--tabs=${TABS}`, '--settle=6000',
                  '--mix=noforms', '--distinct-origins', '--disable-gpu', '--no-sandbox', ...flags];
    const child = spawn(ELECTRON, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('__BENCH__'));
      resolve(line ? JSON.parse(line.slice('__BENCH__'.length)) : null);
    });
  });
}

(async () => {
  console.log(`\n8b - are the caches RAM-sized? (${TABS} tabs, governor off, ${REPS} reps)\n`);
  console.log(`  ${'variant'.padEnd(22)}${'total'.padStart(9)}${'delta'.padStart(9)}   breakdown`);
  console.log(`  ${'-'.repeat(76)}`);
  let base = null;
  for (const v of VARIANTS) {
    const runs = [];
    for (let i = 0; i < REPS; i++) { const r = await runOnce(v.flags); if (r) runs.push(r); }
    if (!runs.length) { console.log(`  ${v.name.padEnd(22)}   FAILED to start`); continue; }
    const total = Math.round(runs.reduce((s, r) => s + r.settledMB, 0) / runs.length);
    if (base === null) base = total;
    const d = total - base;
    console.log(`  ${v.name.padEnd(22)}${String(total + ' MB').padStart(9)}` +
                `${String((d > 0 ? '+' : '') + d).padStart(9)}   ${JSON.stringify(runs[runs.length - 1].breakdown)}`);
  }
  console.log('');
})().catch((e) => { console.error(e.message); process.exit(1); });
