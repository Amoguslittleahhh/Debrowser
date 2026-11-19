'use strict';

/**
 * Labs: network ad and tracker matching in Rust (native/adblock, Brave's
 * adblock-rust), in place of Ghostery's per-request check. Ghostery keeps the
 * cosmetic filters and headers. Absent module (a build without it): null, and
 * blocker.js carries on with Ghostery alone.
 */

const fs = require('fs');
const path = require('path');

let native;

const candidates = () => [
  process.resourcesPath && path.join(process.resourcesPath, 'adblock', 'adblock.node'),
  path.join(__dirname, '..', '..', '..', 'vendor', 'adblock', `${process.platform}-${process.arch}`, 'adblock.node')
].filter((file) => file && fs.existsSync(file));

function load() {
  if (native !== undefined) return native;
  native = null;
  for (const file of candidates()) {
    try { native = require(file); break; } catch { /* wrong platform or corrupt: try the next */ }
  }
  return native;
}

/** Whether this build has the module, without loading it (Settings asks on every broadcast). */
const present = () => candidates().length > 0;

/**
 * The cache file for a Rust build holds both engines: "DBR1", the Ghostery
 * engine's length (uint32 LE), its bytes, then the Rust engine's bytes.
 */
const MAGIC = Buffer.from('DBR1');
function pack(ghostery, rust) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(ghostery.byteLength);
  return Buffer.concat([MAGIC, len, Buffer.from(ghostery.buffer, ghostery.byteOffset, ghostery.byteLength), rust]);
}
function unpack(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(MAGIC)) throw new Error('not a Rust blocker file');
  const n = bytes.readUInt32LE(4);
  if (8 + n > bytes.length) throw new Error('truncated Rust blocker file');
  return { ghostery: bytes.subarray(8, 8 + n), rust: bytes.subarray(8 + n) };
}

/**
 * Both engines from one download: Ghostery's with cosmetic filters only (it
 * still needs uBO's resources for scriptlets), Rust's from the same list text,
 * caught as Ghostery fetches it. `rules`: a list given as text (the tests).
 */
async function compile({ urls, rules }, fetch) {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  const config = { loadCosmeticFilters: true, loadNetworkFilters: false };
  const mod = load();
  if (!mod) throw new Error('no Rust ad-blocking module in this build');
  if (typeof rules === 'string') return pack(ElectronBlocker.parse(rules, config).serialize(), mod.Engine.parse(rules).serialize());
  const texts = new Map();
  const catching = (url, init) => fetch(url, init).then((res) => {
    if (urls.includes(url)) texts.set(url, res.clone().text());
    return res;
  });
  const ghostery = await ElectronBlocker.fromLists(catching, urls, config);
  const lists = await Promise.all(urls.map((url) => texts.get(url) || '')); // in list order, as Ghostery joins them
  return pack(ghostery.serialize(), mod.Engine.parse(lists.join('\n')).serialize());
}

module.exports = { load, present, pack, unpack, compile };
