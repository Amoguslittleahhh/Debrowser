'use strict';

/**
 * How much each private-window JavaScript level costs, measured.
 *
 *   node bench/js-levels/run.js [--json]
 *
 * One Electron process per level, because `--js-flags` is process-wide. Each
 * loads workloads.html in a hidden window, runs the five workloads, and
 * reports the median time of each and the renderer's private memory
 * afterwards. The flags are the ones incognito really uses (JS_LEVELS in
 * src/main/incognito/mode.js), plus `balanced+sparkplug`: the candidate
 * `--always-sparkplug`, kept only if it makes Balanced faster without costing
 * more than 5MB per renderer.
 */

const { spawnSync } = require('child_process');
const path = require('path');

if (process.versions.electron) {
  // Inside Electron: run the workloads once and print the result.
  const { app, BrowserWindow } = require('electron');
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
    await win.loadFile(path.join(__dirname, 'workloads.html'));
    const times = await win.webContents.executeJavaScript('runAll()');
    const pid = win.webContents.getOSProcessId();
    // PSS where /proc has it: a working set counts every shared library page
    // in full, which drowns a difference of a few MB.
    let kb = null;
    try {
      const rollup = require('fs').readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      kb = Number(/^Pss:\s+(\d+)/m.exec(rollup)[1]);
    } catch {
      const metric = app.getAppMetrics().find((m) => m.pid === pid);
      kb = metric && metric.memory ? (metric.memory.privateBytes || metric.memory.workingSetSize) : null;
    }
    console.log(`RESULT ${JSON.stringify({ times, rendererMB: kb ? Math.round(kb / 102.4) / 10 : null })}`);
    app.exit(0);
  });
} else {
  const electron = require('electron');           // the binary's path, from Node
  const { JS_LEVELS } = requireLevels();
  const levels = {
    full: JS_LEVELS.full,
    balanced: JS_LEVELS.balanced,
    'balanced+sparkplug': [...JS_LEVELS.balanced, '--always-sparkplug'],
    maximum: JS_LEVELS.maximum
  };
  const rows = {};
  for (const [name, flags] of Object.entries(levels)) {
    const args = [__filename, '--no-sandbox', '--disable-gpu'];
    if (flags.length) args.push(`--js-flags=${flags.join(' ')}`);
    const r = spawnSync(electron, args, { encoding: 'utf8', timeout: 300_000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
    rows[name] = line ? JSON.parse(line.slice(7)) : { error: (r.stderr || '').slice(-400) };
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    const names = ['dom', 'json', 'regex', 'numeric', 'wasm'];
    console.log(['level'.padEnd(20), ...names.map((n) => n.padStart(9)), 'renderer'.padStart(10)].join(''));
    for (const [level, row] of Object.entries(rows)) {
      if (row.error) { console.log(level.padEnd(20), 'failed:', row.error); continue; }
      const rel = (n) => (row.times[n] == null ? 'n/a' : `${row.times[n]}ms`).padStart(9);
      console.log([level.padEnd(20), ...names.map(rel), `${row.rendererMB}MB`.padStart(10)].join(''));
    }
  }
}

/** JS_LEVELS without loading Electron-only code: mode.js reads `electron` lazily. */
function requireLevels() {
  return require(path.join(__dirname, '..', '..', 'src', 'main', 'incognito', 'mode.js'));
}
