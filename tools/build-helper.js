#!/usr/bin/env node
'use strict';

/**
 * Build one of the native helpers for whatever platform this is.
 *
 *     node tools/build-helper.js mem-probe
 *     node tools/build-helper.js mem-trim
 *
 * A shell one-liner would not do: the Windows compiler is `cl` with entirely
 * different flags and a different way of naming its output, and it only exists
 * on PATH inside a Visual Studio developer environment. This picks the right
 * one and fails loudly rather than leaving a missing binary for the browser to
 * discover at runtime and report as an unavailable capability.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const dir = __dirname;
const NAME = process.argv[2];
if (!NAME || !/^[a-z-]+$/.test(NAME)) {
  console.error('usage: node tools/build-helper.js <mem-probe|mem-trim|net-watch>');
  process.exit(2);
}
const src = path.join(dir, `${NAME}.c`);
const out = path.join(dir, process.platform === 'win32' ? `${NAME}.exe` : NAME);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status === 0;
}

function have(cmd) {
  const probe = process.platform === 'win32' ? ['where', cmd] : ['command', '-v', cmd];
  return spawnSync(probe[0], probe.slice(1), { stdio: 'ignore', shell: true }).status === 0;
}

let ok = false;

if (process.platform === 'win32') {
  // MSVC first, because that is what the release runner has; MinGW second, so
  // a developer machine with it works too.
  // What each helper links against. psapi is where QueryWorkingSet lives;
  // net-watch reads the connection table from the IP helper API.
  const LIBS = { 'net-watch': ['iphlpapi', 'ws2_32'] }[NAME] || ['psapi'];
  if (have('cl')) {
    ok = run('cl', ['/nologo', '/O2', '/W3', src, '/link', ...LIBS.map((l) => `${l}.lib`), `/OUT:${out}`]);
    for (const junk of [`${NAME}.obj`]) {
      try { fs.unlinkSync(path.join(process.cwd(), junk)); } catch { /* nothing to clean */ }
    }
  } else if (have('gcc')) {
    ok = run('gcc', ['-O2', '-Wall', src, '-o', out, ...LIBS.map((l) => `-l${l}`)]);
  } else {
    console.error(`build ${NAME}: no compiler found. Open a Visual Studio developer prompt, ` +
                  'or run this from a job that has run ilammy/msvc-dev-cmd.');
    process.exit(1);
  }
} else if (process.platform === 'darwin') {
  // Universal, because one macOS runner builds both the x64 and the arm64
  // artifact and would otherwise put its own architecture into each. The Intel
  // .dmg would then carry an arm64 helper, `spawn` would fail with ENOEXEC, and
  // memory accounting would silently fall back to the over-counted figure this
  // helper exists to replace - on the machines least able to notice.
  const cc = process.env.CC || 'clang';
  ok = run(cc, ['-O2', '-Wall', '-Wextra', '-arch', 'x86_64', '-arch', 'arm64', src, '-o', out]);
  if (ok) {
    const lipo = spawnSync('lipo', ['-archs', out], { encoding: 'utf8' });
    if (lipo.status === 0) console.log(`architectures: ${lipo.stdout.trim()}`);
  }
} else {
  const cc = process.env.CC || (have('clang') ? 'clang' : 'gcc');
  ok = run(cc, ['-O2', '-Wall', '-Wextra', src, '-o', out]);
}

if (!ok) {
  console.error(`build ${NAME}: compilation failed`);
  process.exit(1);
}
console.log(`built ${out}`);
