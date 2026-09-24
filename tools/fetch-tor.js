#!/usr/bin/env node
'use strict';

/**
 * Fetch the Tor Expert Bundle for one platform, verify it, and unpack the
 * parts incognito ships.
 *
 *     node tools/fetch-tor.js                      # this machine
 *     node tools/fetch-tor.js --platform=darwin --arch=arm64
 *
 * Nothing is trusted because of where it came from. The bundle is checked
 * against its detached signature with `gpgv`, using a signing key committed to
 * this repository (tools/tor-signing-key.asc) whose fingerprint is pinned in
 * tools/tor.json - and the committed key is itself checked against that pin
 * before it is used, so replacing the key file without changing the pin
 * fails, and so does the reverse. The pin was checked against
 * support.torproject.org when it was written; see docs/MEASUREMENTS.md.
 *
 * Output: vendor/tor/<platform>-<arch>/ holding tor, its libraries, lyrebird
 * (the pluggable transports) and pt_config.json (the built-in bridge lines).
 * Not shipped: conjure-client (not used) and the GeoIP databases (a client
 * does not need them) - 38 MB saved per installer.
 *
 * The version is pinned, not "latest": a build must be reproducible, and a
 * scheduled workflow (tor-watch.yml) says loudly when the pin falls behind.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PIN = JSON.parse(fs.readFileSync(path.join(__dirname, 'tor.json'), 'utf8'));
const KEY_FILE = path.join(__dirname, 'tor-signing-key.asc');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const platform = arg('platform', process.platform);
const arch = arg('arch', process.arch);

/** The bundle's own names for platforms and architectures. */
const BUNDLE_OS = { linux: 'linux', darwin: 'macos', win32: 'windows' }[platform];
const BUNDLE_ARCH = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' }[arch];

function fail(message) {
  console.error(`fetch-tor: ${message}`);
  process.exit(1);
}

if (!BUNDLE_OS || !BUNDLE_ARCH) fail(`no Tor Expert Bundle for ${platform}-${arch}`);

/** gpg and gpgv, from PATH or from Git for Windows, which every Windows runner has. */
function tool(name) {
  const onPath = spawnSync(name, ['--version'], { stdio: 'ignore' });
  if (onPath.status === 0) return name;
  const git = path.join('C:\\Program Files\\Git\\usr\\bin', `${name}.exe`);
  if (process.platform === 'win32' && fs.existsSync(git)) return git;
  fail(`${name} not found - install GnuPG; the bundle is not used unverified`);
  return null;
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (r.status !== 0) {
    fail(`${path.basename(cmd)} ${args.join(' ')} failed:\n${r.stderr || r.stdout || r.error?.message}`);
  }
  return r.stdout;
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) fail(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

function copyTree(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst, skip);
    else fs.copyFileSync(src, dst);
  }
}

async function main() {
  const name = `tor-expert-bundle-${BUNDLE_OS}-${BUNDLE_ARCH}-${PIN.version}.tar.gz`;
  const url = `${PIN.base}/${PIN.version}/${name}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-tor-'));
  const tarball = path.join(work, name);

  console.log(`fetching ${url}`);
  await download(url, tarball);
  await download(`${url}.asc`, `${tarball}.asc`);

  // 1. The committed key is the pinned key, and only that key.
  const gpg = tool('gpg');
  const home = path.join(work, 'gnupg');
  fs.mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, GNUPGHOME: home };
  const shown = run(gpg, ['--batch', '--show-keys', '--with-colons', KEY_FILE], { env });
  const primaries = shown.split('\n').filter((l) => l.startsWith('pub:')).length;
  const firstFpr = (shown.split('\n').find((l) => l.startsWith('fpr:')) || '').split(':')[9];
  if (primaries !== 1 || firstFpr !== PIN.fingerprint) {
    fail(`tools/tor-signing-key.asc is not exactly the pinned key ${PIN.fingerprint} (found ${firstFpr}, ${primaries} key(s))`);
  }

  // 2. The bundle is signed by it.
  const keyring = path.join(work, 'tor.gpg');
  run(gpg, ['--batch', '--yes', '--dearmor', '-o', keyring, KEY_FILE], { env });
  const gpgv = tool('gpgv');
  run(gpgv, ['--keyring', keyring, `${tarball}.asc`, tarball], { env });
  console.log(`signature good: ${name} (key ${PIN.fingerprint})`);

  // 3. Unpack, and keep what incognito uses.
  const unpacked = path.join(work, 'x');
  fs.mkdirSync(unpacked);
  run('tar', ['-xzf', tarball, '-C', unpacked]);
  const out = path.join(ROOT, 'vendor', 'tor', `${platform}-${arch}`);
  fs.rmSync(out, { recursive: true, force: true });
  copyTree(path.join(unpacked, 'tor'), out, (n) => /^conjure-client|^README/i.test(n));
  fs.writeFileSync(path.join(out, 'VERSION'), `${PIN.version}\n`);

  fs.rmSync(work, { recursive: true, force: true });
  const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) =>
    n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
  console.log(`unpacked to ${path.relative(ROOT, out)} (${(size(out) / 1048576).toFixed(1)} MB)`);
}

main().catch((err) => fail(err.stack || err.message));
