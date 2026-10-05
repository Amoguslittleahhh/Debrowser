'use strict';

/**
 * Passkeys Debrowser keeps itself, on macOS and Linux.
 *
 * Windows has a passkey store any browser may use, and passkeys.js lists it.
 * macOS's - iCloud Keychain - opens only to browsers Apple grants an
 * entitlement for, which takes a signed Developer ID build this project does
 * not have yet; Linux has none at all. Without this a passkey sign-in there
 * found nothing, and a site offering to make one failed. So they are kept
 * here, in the same encrypted file as saved passwords (credentials.js), behind
 * the same passcode, and offered in the same list.
 *
 * Nothing here does cryptography of its own. Chromium carries a complete
 * WebAuthn authenticator for testing - the "virtual authenticator", driven
 * over the DevTools protocol - which makes keys, signs, and speaks to the page
 * exactly as a hardware one does. Each tab gets one only for the moment a
 * request the user approved is in flight:
 *
 *   sign in   the one passkey picked is put in it, the page asks for that
 *             passkey by name, it signs, and the passkey is taken out again
 *             (with its counter brought back up to date);
 *   save      it starts empty, the page makes its passkey, and the new key is
 *             taken out into the encrypted file.
 *
 * Between requests a tab has no authenticator and none of the keys, so a page
 * cannot sign with them by asking Chromium directly, and a security key or a
 * phone works as it always does.
 *
 * "It is you" is Touch ID where the Mac has it, and otherwise the Debrowser
 * passcode - asked in the list itself, and not again while the passwords page
 * would also stay open (five minutes). The authenticator reports the user as
 * verified only because one of those happened.
 */

/** Longest an approved request may hold its tab's authenticator. */
const HOLD_MS = 2 * 60 * 1000;

const toB64 = (b64url) => {
  const s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return s + '==='.slice((s.length + 3) % 4);
};
const toB64url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class PasskeyStore {
  /**
   * @param {object} deps
   * @param {import('./data/credentials').Credentials} deps.credentials
   * @param {import('./data/vault').Vault} deps.vault
   * @param {{capability: Function, verify: Function}} deps.presence
   * @param {(...a) => void} [deps.log]
   */
  constructor({ credentials, vault, presence, log = () => {} }) {
    this.credentials = credentials;
    this.vault = vault;
    this.presence = presence;
    this.log = log;
  }

  /** On only with a passcode set and a keyring that really encrypts. */
  available() {
    return Boolean(this.vault && this.vault.configured() && this.credentials.capability().available);
  }

  /** The passkeys for a site, as the list shows them: never the key. */
  async list(rpId) {
    if (!this.available()) return null;
    return this.credentials.passkeysFor(rpId).map((r) => ({ id: r.id, name: r.name, display: r.display }));
  }

  /**
   * Whether it is the user: 'ok', 'passcode' (ask for it in the list), or
   * 'no'. Touch ID first; the passcode where there is none, unless it was
   * given in the last few minutes.
   */
  async verify(reason, window = null) {
    const cap = await this.presence.capability().catch(() => ({ available: false }));
    if (cap.available) return (await this.presence.verify(reason, window)) ? 'ok' : 'no';
    if (this.vault.unlocked()) { this.vault.touch(); return 'ok'; }
    return 'passcode';
  }

  /** The passcode, typed into the list. */
  async unlock(passcode) {
    if (typeof passcode !== 'string' || !passcode) return { ok: false };
    return this.vault.unlockWithPasscode(passcode);
  }

  /** The tab's authenticator, made for this request. Null where it cannot be. */
  async authenticator(tab) {
    const cdp = tab.cdp;
    if (!cdp || !tab.wc || tab.wc.isDestroyed()) return null;
    // Kept attached while the request is in flight: the governor's tidy-up
    // detach on a tab switch would take the authenticator with it.
    // Only the first time: a second request before the first was released
    // would otherwise record `true` here, and the tab would stay attached for
    // good once both were done.
    if (!tab.passkeyHeld) tab.passkeyHeld = { keepAttached: cdp.keepAttached };
    cdp.keepAttached = true;
    // Whatever an earlier request left behind goes first.
    if (tab.passkeyOp) { clearTimeout(tab.passkeyOp.timer); tab.passkeyOp = null; }
    await cdp.send('WebAuthn.disable');
    if (!(await cdp.send('WebAuthn.enable', { enableUI: false }))) return null;
    const made = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
    } });
    return made ? made.authenticatorId : null;
  }

  /** Sign in: the picked passkey, in the tab's authenticator, for this request only. */
  async prepareSignIn(tab, id) {
    const record = this.credentials.reveal('passkey', id);
    if (!record) return false;
    const auth = await this.authenticator(tab);
    if (!auth) { await this.release(tab); return false; }
    const added = await tab.cdp.send('WebAuthn.addCredential', { authenticatorId: auth, credential: {
      credentialId: toB64(record.id),
      isResidentCredential: true,
      rpId: record.rpId,
      privateKey: record.key,
      userHandle: record.userHandle || undefined,
      signCount: record.signCount,
      userName: record.name,
      userDisplayName: record.display
    } });
    if (!added) { await this.release(tab); return false; }
    this.hold(tab, { kind: 'get', auth, id });
    return true;
  }

  /** Save: an empty authenticator for the page to make its passkey in. */
  async prepareSave(tab, rpId) {
    const auth = await this.authenticator(tab);
    if (!auth) { await this.release(tab); return false; }
    this.hold(tab, { kind: 'create', auth, rpId });
    return true;
  }

  hold(tab, op) {
    clearTimeout(tab.passkeyOp?.timer);
    op.timer = setTimeout(() => this.finish(tab), HOLD_MS);
    op.timer.unref?.();
    tab.passkeyOp = op;
  }

  /**
   * The page's request has settled: whatever the authenticator now holds is
   * read back - a new passkey into the file, a used one's counter - and the
   * authenticator goes.
   */
  async finish(tab) {
    const op = tab.passkeyOp;
    if (!op) return null;
    tab.passkeyOp = null;
    clearTimeout(op.timer);
    let saved = null;
    const got = await tab.cdp.send('WebAuthn.getCredentials', { authenticatorId: op.auth });
    const found = (got && got.credentials) || [];
    if (op.kind === 'create') {
      const made = found.find((c) => c.rpId === op.rpId && c.isResidentCredential);
      if (made) {
        const record = {
          rpId: made.rpId,
          id: toB64url(made.credentialId),
          userHandle: made.userHandle || '',
          name: String(made.userName || '').slice(0, 511),
          display: String(made.userDisplayName || '').slice(0, 511),
          key: made.privateKey,
          signCount: Number(made.signCount) || 0,
          created: Date.now()
        };
        if (this.credentials.put('passkey', record)) saved = record;
        this.log(saved ? `saved a passkey for ${record.rpId}` : `could not save a passkey for ${record.rpId}`);
      }
    } else {
      const used = found.find((c) => toB64url(c.credentialId) === op.id);
      const record = used && this.credentials.reveal('passkey', op.id);
      if (record && Number(used.signCount) > record.signCount) {
        this.credentials.put('passkey', { ...record, signCount: Number(used.signCount) });
      }
    }
    await this.release(tab);
    return saved;
  }

  /** No authenticator, and the tab's session back to how it was. */
  async release(tab) {
    if (tab.cdp) {
      await tab.cdp.send('WebAuthn.disable');
      if (tab.passkeyHeld) tab.cdp.keepAttached = tab.passkeyHeld.keepAttached;
    }
    tab.passkeyHeld = null;
  }
}

module.exports = { PasskeyStore, toB64, toB64url };
