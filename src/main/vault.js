'use strict';

/**
 * The lock on saved passwords and cards.
 *
 * The store (credentials.js) encrypts every record under a key the operating
 * system holds, so a copy of the file is useless off this machine. What that
 * does not stop is someone at the unlocked computer opening the browser and
 * reading them. This does: the passwords page opens locked, and unlocking it
 * takes Windows Hello or Touch ID where the machine has one, or a passcode the
 * owner chose.
 *
 * The passcode is required for the feature to exist at all. Without one,
 * nothing is offered for saving, nothing is filled and nothing can be read -
 * because a lock whose only key is a fingerprint reader that may be missing,
 * broken or never tested on this machine (presence.js says so) is a lock with
 * no key. Taking the passcode away deletes what was saved, for the same
 * reason in reverse: the next person to set one would otherwise be handed
 * everything saved under the last.
 *
 * The passcode is never stored, only a salted scrypt hash of it, in a file
 * beside the store. Wrong guesses cost more each time. Unlocking lasts
 * UNLOCK_MS from the last thing done with it, and a browser restart locks.
 *
 * Pure but for the file: no Electron here. main.js decides who may ask.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'vault.json';

/** How long an unlocked vault stays open without being used. */
const UNLOCK_MS = 5 * 60 * 1000;

/** Shortest passcode accepted. Six, as a phone asks for. */
const MIN_LENGTH = 6;

/** scrypt at a cost that takes a noticeable fraction of a second per guess. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;

/** Free guesses before each wrong one starts costing time, then the waits. */
const FREE_TRIES = 3;
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 5 * 60_000];

class Vault {
  /**
   * @param {string} dir - where the hash lives (the profile directory)
   * @param {{ now?: () => number, log?: Function }} [options]
   */
  constructor(dir, { now = Date.now, log = () => {} } = {}) {
    this.file = dir ? path.join(dir, FILE) : null;
    this.now = now;
    this.log = log;
    this.record = this.load();
    this.unlockedUntil = 0;
    this.failures = 0;
    this.blockedUntil = 0;
  }

  load() {
    if (!this.file) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw.salt === 'string' && typeof raw.hash === 'string') return raw;
    } catch { /* none set, or unreadable: treated as none */ }
    return null;
  }

  write(record) {
    this.record = record;
    if (!this.file) return;
    if (!record) {
      try { fs.unlinkSync(this.file); } catch { /* already gone */ }
      return;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Whether a passcode is set, which is whether the feature is on at all. */
  configured() {
    return Boolean(this.record);
  }

  unlocked() {
    return this.configured() && this.now() < this.unlockedUntil;
  }

  /** Using it keeps it open; walking away closes it. */
  touch() {
    if (this.unlocked()) this.unlockedUntil = this.now() + UNLOCK_MS;
  }

  lock() {
    this.unlockedUntil = 0;
  }

  status() {
    const wait = Math.max(0, this.blockedUntil - this.now());
    return {
      configured: this.configured(),
      unlocked: this.unlocked(),
      waitMs: wait,
      minLength: MIN_LENGTH
    };
  }

  /** Open it after the operating system confirmed who is there. */
  unlockByPresence() {
    if (!this.configured()) return false;
    this.unlockedUntil = this.now() + UNLOCK_MS;
    this.failures = 0;
    return true;
  }

  /**
   * Open it with the passcode.
   * @returns {Promise<{ok: boolean, waitMs?: number}>}
   */
  async unlockWithPasscode(passcode) {
    const check = await this.check(passcode);
    if (check.ok) this.unlockedUntil = this.now() + UNLOCK_MS;
    return check;
  }

  /** Whether `passcode` is the one set, with the cost of guessing applied. */
  async check(passcode) {
    if (!this.configured()) return { ok: false };
    const wait = this.blockedUntil - this.now();
    if (wait > 0) return { ok: false, waitMs: wait };
    const ok = await matches(String(passcode ?? ''), this.record);
    if (ok) {
      this.failures = 0;
      this.blockedUntil = 0;
      return { ok: true };
    }
    this.failures += 1;
    const over = this.failures - FREE_TRIES;
    if (over > 0) {
      this.blockedUntil = this.now() + BACKOFF_MS[Math.min(over, BACKOFF_MS.length) - 1];
    }
    this.log('vault', `wrong passcode (${this.failures})`);
    return { ok: false, waitMs: Math.max(0, this.blockedUntil - this.now()) };
  }

  /**
   * Set the first passcode, or change it - the current one is needed to change.
   * @returns {Promise<{ok: boolean, reason?: string, waitMs?: number}>}
   */
  async setPasscode(next, current = null) {
    const reason = weakness(next);
    if (reason) return { ok: false, reason };
    if (this.configured()) {
      const check = await this.check(current);
      if (!check.ok) return { ok: false, reason: 'The current passcode is not right.', waitMs: check.waitMs };
    }
    this.write(await derive(String(next)));
    this.lock();
    return { ok: true };
  }

  /**
   * Take the passcode away, which turns the feature off. The caller deletes
   * what was saved; see the note at the top.
   */
  async removePasscode(current) {
    const check = await this.check(current);
    if (!check.ok) return { ok: false, reason: 'The passcode is not right.', waitMs: check.waitMs };
    this.write(null);
    this.lock();
    return { ok: true };
  }
}

/** Why a passcode will not do, or null. */
function weakness(passcode) {
  const text = String(passcode ?? '');
  if (text.length < MIN_LENGTH) return `At least ${MIN_LENGTH} characters.`;
  if (text.length > 256) return 'At most 256 characters.';
  if (/^(.)\1+$/.test(text)) return 'Not the same character over and over.';
  if ('01234567890123456789'.includes(text) || '98765432109876543210'.includes(text)) {
    return 'Not a run of digits in order.';
  }
  return null;
}

function scrypt(passcode, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passcode, salt, KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function derive(passcode) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(passcode, salt);
  return { v: 1, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

async function matches(passcode, record) {
  try {
    const expected = Buffer.from(record.hash, 'base64');
    const actual = await scrypt(passcode, Buffer.from(record.salt, 'base64'));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

module.exports = { Vault, weakness, UNLOCK_MS, MIN_LENGTH };
