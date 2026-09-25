'use strict';

/**
 * Saved sign-ins and payment details, encrypted by the operating system.
 *
 * What this does not change
 * -------------------------
 * This browser refuses to read a password or card field into its session store,
 * and refuses to photograph a page carrying one. Both rules are untouched, and
 * both are asserted in the smoke suite. Nothing here is automatic: a credential
 * reaches this file only when the user is asked and says yes.
 *
 * The distinction is worth stating precisely, because "we never read it" and
 * "we save it when you ask" sound contradictory and are not. The session store
 * is a performance mechanism the user never opted into - it exists so a
 * discarded tab can come back - and quietly putting a password in it would be a
 * decision made on their behalf. This is the opposite: a deliberate,
 * per-credential answer to a question.
 *
 * How it is protected
 * -------------------
 * A 32-byte master key, generated once, held by the OS keystore -
 * DPAPI on Windows, Keychain on macOS, libsecret on Linux - through Electron's
 * `safeStorage`. The key never exists in plaintext on disk. Records are
 * AES-256-GCM, which authenticates as well as encrypts, so a tampered file is
 * detected rather than decrypted into something plausible.
 *
 * Whole records are encrypted, not merely the secret inside them. Leaving the
 * site and username in the clear would make listing cheaper and would also
 * publish, to anything that can read the file, exactly which services the user
 * has accounts with. That is worth more to an attacker than it is to us.
 *
 * Logins and payment details are separate files. This is compartmentation, not
 * obscurity, and it is not claimed to add cryptographic strength: the same key
 * protects both. It means an accident with one - a bad write, a bug in a
 * migration - cannot take the other with it.
 *
 * If the OS keystore is unavailable, this store REFUSES TO SAVE. It does not
 * fall back to a weaker scheme, because a fallback nobody is told about is how
 * credentials end up in plaintext on disk while the UI says they are protected.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

/**
 * Whether the OS keystore really encrypts, and why not when it does not.
 *
 * Shared by everything that seals a secret with it - saved credentials, and
 * incognito's Tor state - so one rule decides what counts as protected.
 * Must be asked after `app.whenReady()`: on Linux `safeStorage` talks to a
 * secret service that is not up before then.
 */
function keystoreCapability() {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      available: false,
      reason: process.platform === 'linux'
        ? 'no OS keyring available – install gnome-keyring or another libsecret provider'
        : 'the OS keystore is unavailable'
    };
  }
  // Linux only: Electron falls back to a "basic text" backend that is
  // obfuscation rather than encryption, and reports encryption as available
  // while using it. Saving anything under that while telling the user it is
  // protected by the OS would be the exact lie this refuses to tell.
  if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === 'basic_text' || backend === 'unknown') {
      return {
        available: false,
        reason: `the available keyring (${backend}) does not really encrypt - install gnome-keyring or kwallet`
      };
    }
  }
  return { available: true, reason: null };
}

/** The two kinds, and the file each lives in. */
const KINDS = {
  login: 'logins.dat',
  payment: 'payments.dat'
};

const KEY_FILE = 'keyring.dat';

/** Owner read/write only. The default 0644 would be world-readable. */
const FILE_MODE = 0o600;

/**
 * What a record of each kind must look like.
 *
 * Validated on the way in *and* on the way out. On the way in because a
 * renderer is not trusted; on the way out because a decrypted record is only as
 * trustworthy as the file it came from, and the file is the thing an attacker
 * would edit.
 */
const SHAPES = {
  login: {
    origin: (v) => typeof v === 'string' && /^https?:\/\//.test(v) && v.length < 2048,
    username: (v) => typeof v === 'string' && v.length < 512,
    password: (v) => typeof v === 'string' && v.length > 0 && v.length < 1024
  },
  payment: {
    label: (v) => typeof v === 'string' && v.length > 0 && v.length < 128,
    number: (v) => typeof v === 'string' && /^[0-9]{12,19}$/.test(v),
    expiry: (v) => typeof v === 'string' && /^(0[1-9]|1[0-2])\/[0-9]{2}$/.test(v),
    holder: (v) => typeof v === 'string' && v.length < 256
  }
};

function validate(kind, record) {
  const shape = SHAPES[kind];
  if (!shape || !record || typeof record !== 'object') return false;
  return Object.entries(shape).every(([field, ok]) => ok(record[field]));
}

/**
 * The origin, and nothing but the origin.
 *
 * Matching is per origin, never per registrable domain: `accounts.example.com`
 * and `blog.example.com` are different places, and a password offered to the
 * wrong one of them is a password handed to whoever controls that subdomain.
 */
function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

class Credentials {
  constructor(log = () => {}) {
    this.log = log;
    this.dir = app.getPath('userData');
    this.key = null;
    this.unavailable = null;   // a named reason, or null when usable
    /** @type {Record<string, object[]>} kind -> records, decrypted, in memory */
    this.records = { login: [], payment: [] };
    this.loaded = false;
  }

  /* ---------------------------------------------------------------- */
  /* Availability                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Whether anything can be saved here, and why not when it cannot.
   *
   * Must be called after `app.whenReady()`: on Linux `safeStorage` talks to a
   * secret service that is not up before then, and asking early reports a
   * false negative that would be cached for the session.
   */
  capability() {
    if (this.unavailable) return { available: false, reason: this.unavailable };
    const cap = keystoreCapability();
    if (!cap.available) this.unavailable = cap.reason;
    return cap;
  }

  /* ---------------------------------------------------------------- */
  /* The key                                                           */
  /* ---------------------------------------------------------------- */

  /** Load the master key, generating one on first use. */
  loadKey() {
    if (this.key) return this.key;
    const cap = this.capability();
    if (!cap.available) return null;

    const file = path.join(this.dir, KEY_FILE);
    try {
      if (fs.existsSync(file)) {
        const sealed = fs.readFileSync(file);
        const raw = Buffer.from(safeStorage.decryptString(sealed), 'base64');
        if (raw.length === 32) { this.key = raw; return this.key; }
        // A key of the wrong length is a corrupt file, not a usable key.
        // Refusing is right: generating a new one here would silently orphan
        // every record already encrypted with the old one.
        this.unavailable = 'the stored key is corrupt; saved items cannot be read';
        return null;
      }
    } catch (err) {
      this.unavailable = `the stored key could not be read: ${err.message}`;
      return null;
    }

    const key = crypto.randomBytes(32);
    try {
      this.writeFile(file, safeStorage.encryptString(key.toString('base64')));
    } catch (err) {
      this.unavailable = `the key could not be saved: ${err.message}`;
      return null;
    }
    this.key = key;
    return this.key;
  }

  /* ---------------------------------------------------------------- */
  /* Encryption                                                        */
  /* ---------------------------------------------------------------- */

  seal(record) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64')
    };
  }

  open(sealed) {
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      const pt = Buffer.concat([
        decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
      return JSON.parse(pt.toString('utf8'));
    } catch {
      // GCM's tag failing means the file was altered or the key is wrong.
      // Either way this record is not ours to trust.
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Disk                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Write atomically, durably, and privately.
   *
   * `prefs.js` writes tmp-then-rename and stops there, which is right for
   * settings: losing them costs a re-tick of some checkboxes. A credential the
   * user believes is saved and is not is worse, so this also fsyncs before the
   * rename - a rename is atomic with respect to crashes, but only orders
   * against data that actually reached the disk - and sets 0600 so the file is
   * not world-readable for the instant before anything else runs.
   */
  writeFile(file, data) {
    const tmp = `${file}.tmp`;
    let fd = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(tmp, 'w', FILE_MODE);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, file);
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    }
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.loadKey()) return;

    for (const [kind, name] of Object.entries(KINDS)) {
      const file = path.join(this.dir, name);
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') this.log(`credentials: ${name} unreadable: ${err.message}`);
        continue;
      }
      if (!Array.isArray(raw)) continue;

      const opened = [];
      for (const sealed of raw) {
        const record = this.open(sealed);
        // A record that fails its tag or its shape is dropped rather than used.
        // Shape is re-checked here because the file is exactly what an attacker
        // would edit, and a "password" that is an object reaches page code.
        if (record && validate(kind, record)) opened.push(record);
        else this.log(`credentials: dropped an unreadable ${kind} record`);
      }
      this.records[kind] = opened;
    }
  }

  save(kind) {
    if (!this.key) return false;
    try {
      this.writeFile(
        path.join(this.dir, KINDS[kind]),
        JSON.stringify(this.records[kind].map((r) => this.seal(r)))
      );
      return true;
    } catch (err) {
      this.log(`credentials: could not save ${kind}: ${err.message}`);
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* The operations                                                    */
  /* ---------------------------------------------------------------- */

  /** Add or replace. Returns whether it was stored. */
  put(kind, record) {
    this.load();
    if (!this.key) return false;
    if (!validate(kind, record)) {
      this.log(`credentials: refusing a malformed ${kind} record`);
      return false;
    }

    const list = this.records[kind];
    const same = kind === 'login'
      ? (r) => r.origin === record.origin && r.username === record.username
      : (r) => r.label === record.label;

    // Written first, kept second. The list used to be mutated before `save`,
    // and `save` swallows its own errors and returns false - so a disk that
    // refused the write left the browser listing a credential it had not
    // stored, or hiding one still on disk that came back at the next restart.
    // Restoring the previous list on failure keeps what is in memory and what
    // is on disk saying the same thing.
    const previous = list.slice();
    const at = list.findIndex(same);
    if (at === -1) list.push(record);
    else list[at] = record;

    if (this.save(kind)) return true;
    this.records[kind] = previous;
    return false;
  }

  /** Remove by the same identity `put` matches on. */
  remove(kind, id) {
    this.load();
    if (!this.key) return false;
    const list = this.records[kind];
    // A kind we do not have is a refusal, not a throw. Throwing rejects the
    // renderer's request rather than answering it, and the caller cannot tell a
    // rejection from a crash.
    if (!Array.isArray(list) || typeof id !== 'string') return false;
    const before = list.length;
    this.records[kind] = kind === 'login'
      ? list.filter((r) => `${r.origin}\u0000${r.username}` !== id)
      : list.filter((r) => r.label !== id);
    if (this.records[kind].length === before) return false;
    return this.save(kind);
  }

  /**
   * What the UI is allowed to see: enough to manage the list, and no secrets.
   *
   * A settings page never needs a password to show a row, and sending one there
   * would put it in a renderer's heap for as long as the page is open, for no
   * benefit. Revealing is a separate, deliberate call.
   */
  list() {
    this.load();
    return {
      logins: this.records.login.map((r) => ({
        id: `${r.origin}\u0000${r.username}`,
        origin: r.origin,
        username: r.username
      })),
      payments: this.records.payment.map((r) => ({
        id: r.label,
        label: r.label,
        // Last four only. The rest is never sent anywhere it is not needed.
        last4: r.number.slice(-4),
        expiry: r.expiry
      }))
    };
  }

  /** Every login stored for exactly this origin. */
  forOrigin(url) {
    this.load();
    const origin = originOf(url);
    if (!origin) return [];
    return this.records.login.filter((r) => r.origin === origin);
  }

  /**
   * Forget every saved sign-in and card - what taking the passcode away means.
   * The files are removed rather than written empty, so nothing is left to
   * decrypt. Returns how many records went.
   */
  clear() {
    this.load();
    const removed = this.records.login.length + this.records.payment.length;
    for (const kind of Object.keys(KINDS)) {
      this.records[kind] = [];
      try { fs.unlinkSync(path.join(this.dir, KINDS[kind])); } catch { /* none saved */ }
    }
    return removed;
  }

  /** One full record, for a fill or a deliberate reveal. */
  reveal(kind, id) {
    this.load();
    if (kind === 'login') {
      return this.records.login.find((r) => `${r.origin}\u0000${r.username}` === id) || null;
    }
    return this.records.payment.find((r) => r.label === id) || null;
  }
}

module.exports = { Credentials, originOf, validate, KINDS, keystoreCapability };
