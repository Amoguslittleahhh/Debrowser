#!/usr/bin/env node
'use strict';

/**
 * The Arch package recipe for a release: a PKGBUILD, and the .SRCINFO the AUR
 * wants beside it.
 *
 *   node tools/pkgbuild.js --version 2.4.0 --sha256 <of Debrowser-Linux.deb> [--out dir]
 *
 * debrowser-bin, as Arch names a package made from a project's own build:
 * makepkg downloads the release's .deb, refuses it unless its SHA-256 is the
 * one written here, and unpacks the files into a pacman package. Run by
 * .github/workflows/pages.yml for the newest release, so the site always has
 * the recipe for it (/arch/PKGBUILD), which tools/install.sh builds on Arch;
 * the same two files are what goes to the AUR.
 *
 * Nothing of the .deb's install scripts comes along - pacman never runs
 * them - and nothing here needs them: the apt repository they add is
 * Debian's, the update-alternatives link is a plain one here, and Arch's
 * kernel lets Chromium sandbox without a setuid helper.
 */

const fs = require('fs');
const path = require('path');

const REPO = 'Amoguslittleahhh/Debrowser';
const SUMMARY = "A web browser that gives your computer's memory back";
// What the browser links against, by Arch's names: the .deb's own list
// (electron-builder.yml, deb.depends) and what Chromium loads beyond it.
const DEPENDS = ['gtk3', 'nss', 'alsa-lib', 'libxss', 'libxtst', 'libnotify', 'libsecret', 'at-spi2-core', 'libdrm', 'mesa', 'xdg-utils'];

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(version|sha256|out)$/.exec(argv[i]);
    if (m) out[m[1]] = argv[++i];
  }
  return out;
}

function pkgbuild({ version, sha256, license }) {
  const deb = `https://github.com/${REPO}/releases/download/v\${pkgver}/Debrowser-Linux.deb`;
  return `# Maintainer: Amoguslittleahhh <amoguslittleahhh@users.noreply.github.com>
# Written by tools/pkgbuild.js for each release; edit that, not this.
pkgname=debrowser-bin
pkgver=${version}
pkgrel=1
pkgdesc="${SUMMARY}"
arch=('x86_64')
url="https://github.com/${REPO}"
license=('MIT')
depends=(${DEPENDS.map((d) => `'${d}'`).join(' ')})
provides=('debrowser')
conflicts=('debrowser')
options=('!strip' '!debug')
source=("debrowser-\${pkgver}.deb::${deb}")
sha256sums=('${sha256}')

package() {
  # makepkg has unpacked the .deb (an ar archive) into data.tar.*.
  bsdtar -xf data.tar.* -C "$pkgdir"
  # The apt repository's key: Debian's business, and nothing here reads it.
  rm -rf "$pkgdir/usr/share/debrowser"
  # A plain link where Debian uses update-alternatives.
  install -d "$pkgdir/usr/bin"
  ln -s /opt/Debrowser/debrowser "$pkgdir/usr/bin/debrowser"
  install -Dm644 /dev/stdin "$pkgdir/usr/share/licenses/$pkgname/LICENSE" <<'LICENSE'
${license.trim()}
LICENSE
}
`;
}

/** What `makepkg --printsrcinfo` would say, without needing makepkg. */
function srcinfo({ version, sha256 }) {
  return `pkgbase = debrowser-bin
\tpkgdesc = ${SUMMARY}
\tpkgver = ${version}
\tpkgrel = 1
\turl = https://github.com/${REPO}
\tarch = x86_64
\tlicense = MIT
${DEPENDS.map((d) => `\tdepends = ${d}`).join('\n')}
\tprovides = debrowser
\tconflicts = debrowser
\toptions = !strip
\toptions = !debug
\tsource = debrowser-${version}.deb::https://github.com/${REPO}/releases/download/v${version}/Debrowser-Linux.deb
\tsha256sums = ${sha256}

pkgname = debrowser-bin
`;
}

function main() {
  const { version, sha256, out = '.' } = args(process.argv.slice(2));
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('--version must be a plain release version, e.g. 2.4.0');
  if (!/^[0-9a-f]{64}$/.test(sha256 || '')) throw new Error('--sha256 must be the .deb\'s SHA-256, in hex');
  const license = fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8');
  if (/^LICENSE$/m.test(license)) throw new Error('LICENSE contains a line that would end the PKGBUILD\'s heredoc');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'PKGBUILD'), pkgbuild({ version, sha256, license }));
  fs.writeFileSync(path.join(out, '.SRCINFO'), srcinfo({ version, sha256 }));
  console.log(`debrowser-bin ${version}: PKGBUILD and .SRCINFO written to ${out}`);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(`pkgbuild: ${err.message}`); process.exit(1); }
}

module.exports = { pkgbuild, srcinfo };
