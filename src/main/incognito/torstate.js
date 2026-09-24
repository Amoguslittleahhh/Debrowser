'use strict';

/**
 * Tor's memory between private sessions, sealed with the OS keystore.
 *
 * Tor is built to keep the same entry guard for months. A guard chosen fresh
 * every session is another roll of the dice against a malicious one - wiping
 * Tor's state on every exit, which "leave nothing on disk" suggests, quietly
 * weakens the network-level protection that is the whole point here. It also
 * forces a full download of the network's directory each time, which is most
 * of why a cold Tor takes fifteen to thirty seconds to connect.
 *
 * So by default these few files are kept, and only these: `state` (the guard)
 * and the cached consensus and descriptors. Nothing about any site visited is
 * in them. They are compressed and sealed with AES-256-GCM under a key the OS
 * keystore holds, into one file in the ordinary profile - the one thing a
 * private session writes there, and only when the setting is on. Off, the file
 * is deleted and every session starts from nothing, and Settings says what
 * that costs.
 *
 * With no real keystore (Linux without a keyring) nothing is kept: an
 * unencrypted record that Tor was used is exactly what someone with the disk
 * would want, so this refuses rather than writing it in the clear.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { safeStorage } = require('electron');
const { keystoreCapability } = require('../credentials');

const FILE = 'incognito-tor.sealed';
const MAGIC = Buffer.from('DBT1');
/** The files worth keeping. Anything else in Tor's directory is left behind. */
const KEEP = ['state', 'cached-certs', 'cached-microdesc-consensus', 'cached-microdescs', 'cached-microdescs.new'];
/** A consensus and descriptors are a few MB; anything much bigger is not what we wrote. */
const MAX_BYTES = 64 * 1024 * 1024;

const sealedPath = (normalUserData) => path.join(normalUserData, FILE);

/**
 * Put the kept files back into Tor's data directory before it starts.
 * Returns how many were restored; any failure is a fresh start, never an error.
 */
function restore(normalUserData, dataDir, log = () => {}) {
  const file = sealedPath(normalUserData);
  if (!fs.existsSync(file)) return 0;
  if (!keystoreCapability().available) return 0;
  try {
    const blob = fs.readFileSync(file);
    if (blob.length > MAX_BYTES || !blob.subarray(0, 4).equals(MAGIC)) throw new Error('not ours');
    const wrappedLength = blob.readUInt32BE(4);
    const wrapped = blob.subarray(8, 8 + wrappedLength);
    const iv = blob.subarray(8 + wrappedLength, 20 + wrappedLength);
    const tag = blob.subarray(20 + wrappedLength, 36 + wrappedLength);
    const body = blob.subarray(36 + wrappedLength);
    const key = Buffer.from(safeStorage.decryptString(wrapped), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const files = JSON.parse(zlib.gunzipSync(Buffer.concat([decipher.update(body), decipher.final()])).toString());
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    let count = 0;
    for (const name of KEEP) {
      if (typeof files[name] !== 'string') continue;
      fs.writeFileSync(path.join(dataDir, name), Buffer.from(files[name], 'base64'), { mode: 0o600 });
      count++;
    }
    return count;
  } catch (err) {
    // Tampered, from another keystore, or truncated: start fresh, and do not
    // keep a file that will fail the same way next time.
    log('tor', `kept state unusable (${err.message}); starting fresh`);
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return 0;
  }
}

/** Seal the kept files from Tor's data directory. Returns whether anything was written. */
function save(normalUserData, dataDir, log = () => {}) {
  const cap = keystoreCapability();
  if (!cap.available) {
    log('tor', `not keeping Tor's state: ${cap.reason}`);
    return false;
  }
  const files = {};
  for (const name of KEEP) {
    try { files[name] = fs.readFileSync(path.join(dataDir, name)).toString('base64'); } catch { /* not there */ }
  }
  if (!files.state) return false;             // nothing worth keeping yet

  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(JSON.stringify(files))), cipher.final()]);
  const wrapped = safeStorage.encryptString(key.toString('base64'));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(wrapped.length);
  const blob = Buffer.concat([MAGIC, length, wrapped, iv, cipher.getAuthTag(), body]);

  const file = sealedPath(normalUserData);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, blob, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log('tor', `could not keep Tor's state: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    return false;
  }
}

/** Forget it: the setting is off. */
function forget(normalUserData) {
  try { fs.unlinkSync(sealedPath(normalUserData)); } catch { /* not there */ }
}

module.exports = { restore, save, forget, KEEP, FILE };
