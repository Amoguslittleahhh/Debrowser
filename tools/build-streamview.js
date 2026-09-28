#!/usr/bin/env node
'use strict';

/**
 * Build the streaming view module for this platform.
 *
 *     node tools/build-streamview.js
 *
 * Windows embeds Microsoft's WebView2 and macOS embeds Apple's WebKit, for the
 * streaming sites whose DRM (PlayReady, FairPlay) the operating system provides
 * and Chromium's Widevine does not. Linux has nothing to build: Widevine
 * already covers it there.
 *
 * Output: vendor/streamview/<platform>-<arch>/streamview.node, which
 * electron-builder ships as `resources/streamview` and src/main/streamview.js
 * loads. Compiled against the Electron in node_modules - castLabs' build, whose
 * ABI is upstream Electron's of the same version.
 *
 * The WebView2 SDK comes from NuGet, pinned by version and SHA-256 like Tor in
 * tools/fetch-tor.js: a header and a static loader library linked into the
 * browser are not something to take unverified.
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'native', 'streamview');
const WEBVIEW2 = {
  version: '1.0.4191.47',
  sha256: 'f492bbf547d0da329553b6727435b677579b1e9f91cc9e4a1ad029366d5f23d0'
};

function fail(message) {
  console.error(`build-streamview: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

function download(url, file, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, file, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function webView2Sdk() {
  const sdk = path.join(MODULE, 'sdk');
  if (fs.existsSync(path.join(sdk, 'include', 'WebView2.h'))) return;
  const cache = path.join(MODULE, '.sdk-cache');
  fs.mkdirSync(cache, { recursive: true });
  const pkg = path.join(cache, `webview2-${WEBVIEW2.version}.nupkg`);
  if (!fs.existsSync(pkg)) {
    const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2.version}/` +
      `microsoft.web.webview2.${WEBVIEW2.version}.nupkg`;
    console.log(`fetching WebView2 SDK ${WEBVIEW2.version}`);
    await download(url, pkg);
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(pkg)).digest('hex');
  if (digest !== WEBVIEW2.sha256) {
    fs.rmSync(pkg, { force: true });
    fail(`WebView2 SDK checksum mismatch: ${digest}`);
  }
  const unpacked = path.join(cache, 'unpacked');
  fs.rmSync(unpacked, { recursive: true, force: true });
  fs.mkdirSync(unpacked, { recursive: true });
  // A .nupkg is a zip; Windows' bsdtar reads it.
  run('tar', ['-xf', pkg, '-C', unpacked]);
  const native = path.join(unpacked, 'build', 'native');
  fs.mkdirSync(sdk, { recursive: true });
  fs.cpSync(path.join(native, 'include'), path.join(sdk, 'include'), { recursive: true });
  fs.cpSync(path.join(native, 'x64'), path.join(sdk, 'x64'), { recursive: true });
}

function build(arch) {
  const electron = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version.split('+')[0];
  const gyp = require.resolve('node-gyp/bin/node-gyp.js', { paths: [ROOT] });
  run(process.execPath, [gyp, 'rebuild', `--target=${electron}`, `--arch=${arch}`,
    '--dist-url=https://electronjs.org/headers'], { cwd: MODULE });
  const out = path.join(ROOT, 'vendor', 'streamview', `${process.platform}-${arch}`);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(path.join(MODULE, 'build', 'Release', 'streamview.node'), path.join(out, 'streamview.node'));
  console.log(`built ${path.relative(ROOT, path.join(out, 'streamview.node'))}`);
}

(async () => {
  if (process.platform === 'win32') {
    await webView2Sdk();
    build('x64');
  } else if (process.platform === 'darwin') {
    // One runner builds both Mac artifacts.
    build('x64');
    build('arm64');
  } else {
    console.log('build-streamview: nothing to build on this platform');
  }
})().catch((err) => fail(err.message));
