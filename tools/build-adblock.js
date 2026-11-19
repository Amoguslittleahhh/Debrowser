#!/usr/bin/env node
'use strict';

/**
 * Build the Rust ad-blocking module (native/adblock, Brave's adblock-rust)
 * for this platform: `node tools/build-adblock.js`. Needs cargo (rustup).
 *
 * Output: vendor/adblock/<platform>-<arch>/adblock.node, which electron-builder
 * ships as `resources/adblock` and src/main/protection/rust-engine.js loads.
 * N-API is ABI-stable, so one build serves every Electron version.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CRATE = path.join(ROOT, 'native', 'adblock');
const r = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(CRATE, 'Cargo.toml')],
  { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) { console.error('build-adblock: cargo failed'); process.exit(1); }

const lib = { win32: 'debrowser_adblock.dll', darwin: 'libdebrowser_adblock.dylib' }[process.platform] ||
  'libdebrowser_adblock.so';
const out = path.join(ROOT, 'vendor', 'adblock', `${process.platform}-${process.arch}`);
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(CRATE, 'target', 'release', lib), path.join(out, 'adblock.node'));
console.log(`built ${path.join(out, 'adblock.node')}`);
