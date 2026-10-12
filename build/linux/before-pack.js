'use strict';

/**
 * electron-builder `beforePack`, Linux only: the two files the .deb carries
 * outside /opt, written fresh for the version being built.
 *
 *   - debrowser.metainfo.xml, the AppStream entry software centres read. It is
 *     what gives Ubuntu's App Center, GNOME Software and KDE Discover a name,
 *     summary, licence, icon, developer and a "last updated" date; without it
 *     they show a placeholder and "unknown".
 *   - archive-keyring.asc, the public key the apt repository is signed with
 *     (build/linux/archive-keyring.asc). Empty when there is none yet: the
 *     install script then adds no apt source, since one it cannot verify would
 *     fail every `apt update` on the machine.
 *
 * Both go to build/linux/generated/, which the `deb.fpm` lines in
 * electron-builder.yml map into the package.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'generated');

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The metainfo for this version, released today. */
function metainfo(pkg, date = new Date().toISOString().slice(0, 10)) {
  const template = fs.readFileSync(path.join(__dirname, 'debrowser.metainfo.xml'), 'utf8');
  return template
    .replace('@VERSION@', escape(pkg.version))
    .replace('@DATE@', date)
    .replace(/@HOMEPAGE@/g, escape(pkg.homepage));
}

function write() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'debrowser.metainfo.xml'), metainfo(pkg));
  const key = path.join(__dirname, 'archive-keyring.asc');
  fs.writeFileSync(path.join(OUT, 'archive-keyring.asc'), fs.existsSync(key) ? fs.readFileSync(key) : '');
}

module.exports = async (context) => {
  if (context.electronPlatformName === 'linux') write();
};
module.exports.metainfo = metainfo;
module.exports.write = write;
