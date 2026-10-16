'use strict';

/**
 * Which Linux this is, and installing Debrowser its way.
 *
 * The AppImage runs on any Linux. Where the system has a package manager
 * Debrowser builds for - apt (Ubuntu, Debian, Mint and their kin), dnf
 * (Fedora, RHEL and its rebuilds) or zypper (openSUSE) - the AppImage offers to
 * install the matching package instead (install.js): then Debrowser is in the
 * software centre with its details, is installed for everyone, and updates
 * with the rest of the system from the signed repository the package adds.
 *
 * Offered only when this build carries the repository's key (resources/
 * archive-keyring.asc, empty without one): without it, a package would get no
 * updates at all, where the AppImage updates itself.
 *
 * The package is this very version's, downloaded from its release and checked
 * against the SHA-512 in that release's latest-linux.yml - the same manifest
 * the AppImage's own updates are checked against - before the package manager
 * is given it, through pkexec, which asks for the password.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PKEXEC } = require('../system-tools');
const DOWNLOADS = require('./downloads.json');

/** /etc/os-release as an object; empty when it cannot be read. */
function osRelease(file = '/etc/os-release') {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

const TOOLS = {
  apt: { family: 'deb', bin: '/usr/bin/apt-get', ids: /^(debian|ubuntu)$/ },
  dnf: { family: 'rpm', bin: '/usr/bin/dnf', ids: /^(fedora|rhel|centos)$/ },
  zypper: { family: 'rpm', bin: '/usr/bin/zypper', ids: /^(suse|opensuse.*|sles)$/ }
};

/**
 * `{ tool, family, name }` for a system Debrowser has a package for - the
 * package manager, 'deb' or 'rpm', and the system's own name ("Ubuntu",
 * "Fedora Linux") - or null. Decided by os-release's ID and ID_LIKE, and only
 * when the package manager and pkexec are both really there.
 */
function packageSystem({ release = osRelease(), exists = fs.existsSync, arch = process.arch } = {}) {
  if (arch !== 'x64' || !exists(PKEXEC)) return null;
  const ids = [release.ID, ...String(release.ID_LIKE || '').split(/\s+/)].filter(Boolean).map((s) => s.toLowerCase());
  for (const [tool, t] of Object.entries(TOOLS)) {
    if (ids.some((id) => t.ids.test(id)) && exists(t.bin)) {
      return { tool, family: t.family, name: release.NAME || release.ID || 'your system' };
    }
  }
  return null;
}

/** Whether this build carries the repositories' key, so a package would get updates. */
function hasRepositoryKey(resources = process.resourcesPath) {
  try { return fs.statSync(path.join(resources || '', 'archive-keyring.asc')).size > 0; } catch { return false; }
}

/** The package file for a family, from downloads.json. */
const packageFile = (family) => DOWNLOADS.files.find((f) => f.id === family).file;

/** Where this version's release keeps a file. */
const releaseUrl = (version, file) => DOWNLOADS.latest.replace('/latest/download/', `/download/v${version}/`) + file;

/** The base64 SHA-512 latest-linux.yml gives for a file, or null. */
function expectedDigest(manifest, file) {
  const lines = String(manifest).split('\n');
  const at = lines.findIndex((l) => l.trim() === `- url: ${file}`);
  if (at < 0) return null;
  for (let i = at + 1; i < lines.length && /^\s{4}\S/.test(lines[i]); i++) {
    const m = /^\s+sha512:\s*(\S+)/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/**
 * Download `url` to `dest`, refusing it unless its SHA-512 is `digest`.
 * `fetch` is Electron's net.fetch in the app (system proxy, redirects).
 */
async function download(url, dest, digest, fetch) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The package could not be downloaded (HTTP ${res.status}).`);
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(dest, { mode: 0o644 });
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  } finally {
    // Closed, not just finished: the file is still open between the two, and
    // removing it then - as a refusal below does - fails on Windows.
    await new Promise((r) => { out.once('close', r); out.end(); });
  }
  if (hash.digest('base64') !== digest) {
    fs.rmSync(dest, { force: true });
    throw new Error('The downloaded package did not match this release, so it was not installed.');
  }
}

/**
 * The command that installs a downloaded package, run through pkexec. The
 * package was checked against the release's manifest, which is why zypper is
 * told not to stop at a key it has not been given yet; dnf does not check a
 * local file's signature by default, and apt never does.
 */
function installCommand(tool, file) {
  if (tool === 'apt') return [TOOLS.apt.bin, 'install', '-y', file];
  if (tool === 'dnf') return [TOOLS.dnf.bin, 'install', '-y', file];
  return [TOOLS.zypper.bin, '--non-interactive', '--no-gpg-checks', 'install', file];
}

/**
 * The environment for starting the installed copy: this one's, without what
 * the AppImage runtime set. Inherited, APPIMAGE would make the installed copy
 * believe it was an AppImage and update a file that is no longer it.
 */
function packagedEnv(env = process.env) {
  const out = { ...env };
  const appDir = out.APPDIR;
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'APPIMAGE_SILENT_INSTALL']) delete out[k];
  for (const k of ['LD_LIBRARY_PATH', 'PATH', 'XDG_DATA_DIRS']) {
    if (appDir && out[k]) out[k] = out[k].split(':').filter((p) => p && !p.startsWith(appDir)).join(':');
    if (out[k] === '') delete out[k];
  }
  return out;
}

/** Where the package installs the browser. */
const INSTALLED = '/opt/Debrowser/debrowser';

/**
 * Download this version's package and install it. Resolves once the package
 * manager has finished; throws a message for the window otherwise.
 */
async function installPackage({ system, version, fetch, run, log = () => {} }) {
  const file = packageFile(system.family);
  const manifest = await fetch(releaseUrl(version, 'latest-linux.yml')).then((r) => (r.ok ? r.text() : ''));
  const digest = expectedDigest(manifest, file);
  if (!digest) throw new Error('This release does not list its package, so it cannot be installed from here.');
  // A folder of its own, readable by root and by apt's own user.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-package-'));
  fs.chmodSync(dir, 0o755);
  const dest = path.join(dir, file);
  try {
    await download(releaseUrl(version, file), dest, digest, fetch);
    log('install', `installing ${file} with ${system.tool}`);
    const { code, stderr } = await run(PKEXEC, installCommand(system.tool, dest));
    if (code === 126) throw new Error('The password was not given, so nothing was installed.');
    if (code === 127 && /not authori[sz]ed/i.test(stderr)) {
      throw new Error('The password was not accepted, or this account may not install programs, so nothing was installed.');
    }
    if (code === 127 || code < 0) throw new Error('Your system could not ask for a password, so nothing was installed.');
    if (code !== 0) {
      const why = String(stderr).trim().split('\n').filter(Boolean).slice(-1)[0] || `${system.tool} ${code}`;
      throw new Error(`Installing the package failed: ${why}`);
    }
    if (!fs.existsSync(INSTALLED)) throw new Error('The package manager finished, but Debrowser is not where the package puts it.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  osRelease, packageSystem, hasRepositoryKey, packageFile, releaseUrl, expectedDigest,
  download, installCommand, packagedEnv, installPackage, INSTALLED
};
