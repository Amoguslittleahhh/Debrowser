#!/usr/bin/env node
'use strict';

/**
 * M1: fixed overhead and the marginal cost of one renderer.
 *
 * Runs the existing --bench-test harness with the governor OFF (so every tab
 * stays resident) at several tab counts, and fits
 *
 *     total = fixed + n * per_tab
 *
 * by least squares. `fixed` is the number that decides whether <10MB per open
 * tab is reachable at all: it does not shrink with tab count, so it is pure
 * overhead against the target.
 *
 * Also records the per-process-type breakdown at each point, and system-wide
 * available memory, so a later trim measurement has a baseline to compare to.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const COUNTS = (process.env.COUNTS || '1,2,4,8,16,30').split(',').map(Number);
const MIX = process.env.MIX || 'noforms';
const SETTLE = process.env.SETTLE || '8000';

function systemAvailableMB() {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = /MemAvailable:\s+(\d+) kB/.exec(info);
    return kb ? Math.round(Number(kb[1]) / 1024) : null;
  } catch { return null; }
}

function runOnce(tabCount) {
  return new Promise((resolve, reject) => {
    const args = [
      '.', '--bench-test', '--no-governor',
      `--tabs=${tabCount}`, `--settle=${SETTLE}`, `--mix=${MIX}`,
      '--distinct-origins', '--disable-gpu', '--no-sandbox'
    ];
    const child = spawn(ELECTRON, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('__BENCH__'));
      if (!line) return reject(new Error(`no result at ${tabCount} tabs`));
      resolve(JSON.parse(line.slice('__BENCH__'.length)));
    });
  });
}

/** Least-squares fit of total = fixed + n * per_tab. */
function fit(points) {
  const n = points.length;
  const sx = points.reduce((s, p) => s + p.tabs, 0);
  const sy = points.reduce((s, p) => s + p.total, 0);
  const sxx = points.reduce((s, p) => s + p.tabs * p.tabs, 0);
  const sxy = points.reduce((s, p) => s + p.tabs * p.total, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { perTab: slope, fixed: (sy - slope * sx) / n };
}

(async () => {
  console.log('\nM1 - fixed overhead and marginal renderer cost');
  console.log(`  host    : ${os.platform()} ${os.arch()}, ${os.cpus().length} cores, ${Math.round(os.totalmem()/1048576)} MB RAM`);
  console.log(`  workload: governor OFF, distinct origins, mix=${MIX}, settle=${SETTLE}ms`);
  console.log(`  sysavail: ${systemAvailableMB()} MB before run\n`);

  const points = [];
  for (const tabs of COUNTS) {
    process.stdout.write(`  ${String(tabs).padStart(3)} tabs ... `);
    const r = await runOnce(tabs);
    points.push({ tabs, total: r.settledMB, renderers: r.liveRenderers, breakdown: r.breakdown });
    console.log(`${String(r.settledMB).padStart(5)} MB   ${String(r.liveRenderers).padStart(3)} renderers   ` +
                `${JSON.stringify(r.breakdown)}`);
  }

  const { fixed, perTab } = fit(points);
  console.log(`\n  fit: total = ${fixed.toFixed(1)} MB fixed + n x ${perTab.toFixed(1)} MB per tab`);
  console.log(`\n  implication for the <10 MB/tab target at 30 tabs (300 MB):`);
  const room = 300 - fixed;
  console.log(`    budget left for renderers after fixed overhead: ${room.toFixed(0)} MB`);
  console.log(`    live renderers that fits, at ${perTab.toFixed(1)} MB each: ${Math.floor(room / perTab)}`);
  if (fixed > 250) console.log(`    *** fixed overhead > 250 MB: target UNREACHABLE, see plan gate M1 ***`);

  const outPath = path.join(__dirname, 'm1-results.json');
  fs.writeFileSync(outPath, JSON.stringify({ host: os.platform(), mix: MIX, points, fixed, perTab }, null, 2));
  console.log(`\n  raw: ${outPath}\n`);
})().catch((e) => { console.error(`\nM1 failed: ${e.message}\n`); process.exit(1); });
