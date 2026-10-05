'use strict';

/**
 * Passkeys, offered in the browser's own list.
 *
 * Signing in with a passkey works without any of this: the page asks, Chromium
 * hands the request to Windows, and Windows shows its "Choose a passkey"
 * dialog - a system window over the browser, every account in it. Chrome and
 * Edge show the accounts themselves instead, as a list under the address bar
 * or a dropdown under the sign-in field, and Windows Hello only asks whether it
 * is you. This is that.
 *
 * How it goes:
 *
 *   1. The page asks for "any passkey of mine for this site" (a request with
 *      no list of allowed credentials). probe-preload.js catches it before
 *      Chromium does and asks here instead.
 *   2. The passkeys Windows holds for the site are listed by a helper
 *      (native/helpers/passkeys.c, over webauthn.dll - what Chrome reads).
 *   3. The browser shows them: a list under the address bar for a request made
 *      there and then, or a dropdown under the field marked for passkeys
 *      (`autocomplete="... webauthn"`) for one the page leaves waiting
 *      ("conditional" - Chrome's autofill passkeys).
 *   4. The one picked goes back to the page, which makes the same request to
 *      Windows naming only that credential - so Windows skips its picker and
 *      shows only Windows Hello.
 *
 * What the page learns: nothing it would not have learned anyway. The list of
 * accounts never enters the page's process - it goes to the browser's own
 * view - and the page hears only the credential the user chose, which the
 * signed answer would have told it a moment later.
 *
 * Anything this cannot do is handed back to Chromium as before: no helper (not
 * Windows, or a Windows before 11 22H2), no passkeys for the site, a request
 * for "Use a different passkey" - a phone, a security key - or a page that is
 * not plainly the site the passkeys belong to. Never in a private window,
 * where the hook is not installed (probe-preload.js).
 */

const fs = require('fs');
const { spawn } = require('child_process');
const { getDomain } = require('tldts-experimental');

/** Longest a listing may take before the system's own dialog is used instead. */
const LIST_TIMEOUT_MS = 4000;

/** How long the dropdown outlives the field's blur, for a click on itself. */
const BLUR_GRACE_MS = 150;

/** How long one listing of a site's passkeys answers every request for it. */
const LISTING_FRESH_MS = 2000;

/** No second "Save a passkey?" from a tab for this long after the last. */
const SAVE_QUIET_MS = 10_000;

/**
 * Windows' passkeys for a site, from the helper; null where it cannot say.
 * Returns null - not a lister - where there is no helper to ask.
 */
function windowsLister(log = () => {}) {
  if (process.platform !== 'win32') return null;
  const binary = require('./platform').helperPath('passkeys.exe');
  if (!fs.existsSync(binary)) return null;
  return (rpId) => new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(binary, ['list', rpId], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log(`passkeys: helper did not start (${err.message})`);
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(null); }, LIST_TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (out.length < 256 * 1024) out += d; });
    child.stderr.on('data', (d) => log(`passkeys: ${String(d).trim()}`));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve(null); return; }
      try { resolve(accountsFrom(JSON.parse(out))); } catch { resolve(null); }
    });
  });
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/** Only well-formed rows, with a usable id; at most a screenful. */
function accountsFrom(list) {
  if (!Array.isArray(list)) return null;
  return list
    .filter((a) => a && typeof a.id === 'string' && /^[A-Za-z0-9_-]{1,1400}$/.test(a.id))
    .slice(0, 20)
    .map((a) => ({
      id: a.id,
      name: typeof a.name === 'string' ? a.name.slice(0, 200) : '',
      display: typeof a.display === 'string' ? a.display.slice(0, 200) : ''
    }));
}

/**
 * The site a request's passkeys belong to, if the page may ask for them; else
 * null. WebAuthn's own rule, checked here rather than trusted to the page: the
 * site is the page's host or a parent of it, never above the registrable
 * domain (`co.uk`), and only over https or on this machine. Read from the
 * page's address as the browser knows it, not from anything the page says, so
 * one site cannot have another's accounts listed.
 */
function rpIdFor(pageUrl, asked) {
  let url;
  try { url = new URL(pageUrl); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost');
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return null;
  const rpId = typeof asked === 'string' && asked ? asked.toLowerCase() : host;
  if (rpId === host) return rpId;
  if (!host.endsWith(`.${rpId}`)) return null;
  const site = getDomain(host);
  if (!site || !(rpId === site || rpId.endsWith(`.${site}`))) return null;
  return rpId;
}

/**
 * The requests pages have made, one per tab, and the list on screen.
 *
 * Answers, to the page (probe-preload.js):
 *   null              not ours to answer: Chromium asks Windows as before
 *   { id }            the credential the user picked
 *   { native: true }  "Use a different passkey": Windows' own dialog
 *   { cancel: true }  dismissed, replaced, or the page went away
 * and for a passkey Debrowser keeps itself (passkey-store.js, macOS and Linux):
 *   { id, done }      as { id }, and the page says when its request settled
 *   { go, done }      save: the page makes its passkey now
 *   { exists: true }  save: this site already has that one here
 */
class PasskeyBroker {
  /**
   * @param {object} deps
   * @param {((rpId: string) => Promise<object[]|null>)|null} deps.list
   * @param {(tab: object) => object|null} deps.shellFor - the window a tab is in
   * @param {(...a) => void} [deps.log]
   */
  constructor({ list = null, store = null, shellFor, ask = null, log = () => {} }) {
    this.store = store;
    this.list = list || (store ? (rpId) => store.list(rpId) : null);
    /** A site's listing, shared by requests made while it is under way. */
    this.listing = new Map();
    /** Tabs whose "Save a passkey?" is up, or was just refused: tab id -> until. */
    this.saveQuiet = new Map();
    this.shellFor = shellFor;
    this.ask = ask;
    this.log = log;
    /** @type {Map<number, object>} tab id -> request */
    this.pending = new Map();
    this.shown = null;
    this.hideTimer = null;
    this.watched = new WeakSet();
  }

  available() { return typeof this.list === 'function'; }

  /** A page asked. Resolves with one of the answers above. */
  async request(tab, frameUrl, { rpId, conditional, allow = null, create = null }) {
    if (!this.available() || !tab || !tab.wc || tab.wc.isDestroyed()) return null;
    const site = rpIdFor(frameUrl, rpId);
    if (!site) return null;
    if (create) return this.save(tab, frameUrl, site, create);
    // A page naming its passkeys is Windows' to answer: it asks only Hello.
    // Kept here, the named one has to come from here.
    if (allow && !this.store) return null;
    let accounts = await this.accountsFor(site);
    if (accounts && allow) accounts = accounts.filter((a) => allow.includes(a.id));
    if (!accounts || !accounts.length) return null;
    // Still the page that asked: a listing takes a moment, and the tab may
    // have gone somewhere else in it.
    if (tab.wc.isDestroyed() || originOf(tab.wc.getURL()) !== originOf(frameUrl)) return { cancel: true };
    this.watch(tab);
    // One request per page, as in Chromium: a new one replaces the last.
    this.settle(tab, { cancel: true });
    return new Promise((resolve) => {
      const req = { tab, site, accounts, conditional: conditional === true, resolve };
      this.pending.set(tab.id, req);
      if (!req.conditional) this.show(req, null);
      else if (tab.passkeyField) this.show(req, tab.passkeyField);
    });
  }

  /**
   * A site's passkeys, asked of the list once for every request that arrives
   * while it is being answered and for a moment after: a page calling get()
   * in a loop otherwise started a helper process per call on Windows.
   */
  accountsFor(site) {
    // Kept here, a listing is a read of the file already in memory - and one
    // held for a moment would hide a passkey saved in that moment.
    if (this.store) return Promise.resolve().then(() => this.list(site)).catch(() => null);
    const held = this.listing.get(site);
    if (held && Date.now() - held.at < LISTING_FRESH_MS) return held.promise;
    const promise = Promise.resolve().then(() => this.list(site)).catch(() => null);
    this.listing.set(site, { promise, at: Date.now() });
    if (this.listing.size > 32) this.listing.delete(this.listing.keys().next().value);
    return promise;
  }

  /** Answer a tab's request, if it has one, and take its list away. */
  settle(tab, answer) {
    const req = this.pending.get(tab.id);
    if (!req) return;
    this.pending.delete(tab.id);
    if (this.shown === req) this.hide();
    if (req.verifying) { req.verifying.resolve(false); req.verifying = null; }
    req.resolve(answer);
  }

  /**
   * The field for passkeys gained focus (with where it is, in the page's
   * pixels) or lost it (null). A waiting request shows its dropdown there.
   */
  field(tab, rect) {
    tab.passkeyField = rect;
    const req = this.pending.get(tab.id);
    if (!req || !req.conditional) return;
    if (rect) { this.show(req, rect); return; }
    // Not at once: a click on the dropdown blurs the field first.
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      const shell = this.shellFor(req.tab);
      if (this.shown === req && !(shell && shell.passkeysFocused())) this.hide();
    }, BLUR_GRACE_MS);
  }

  /** The page gave up waiting (its AbortSignal): nothing to answer. */
  abort(tab) {
    const req = this.pending.get(tab.id);
    if (!req) return;
    this.pending.delete(tab.id);
    if (this.shown === req) this.hide();
  }

  /** Arrow down in the field: into the dropdown, as in Chrome's. */
  enterList(tab) {
    const req = this.pending.get(tab.id);
    const shell = req && this.shown === req ? this.shellFor(tab) : null;
    if (shell) shell.focusPasskeys();
  }

  show(req, rect) {
    const shell = this.shellFor(req.tab);
    if (!shell || !req.tab.view) return;
    clearTimeout(this.hideTimer);
    this.shown = req;
    const b = req.tab.view.getBounds();
    let zoom = 1;
    try { zoom = req.tab.wc.getZoomFactor() || 1; } catch { /* default */ }
    const anchor = rect
      ? { x: b.x + rect.left * zoom, y: b.y + rect.bottom * zoom, width: rect.width * zoom }
      : { x: b.x + b.width / 2, y: b.y, width: 0 };
    shell.showPasskeys({
      mode: rect ? 'dropdown' : 'chooser',
      // Kept by Debrowser (macOS, Linux) rather than by Windows Hello: the
      // list says which.
      kept: Boolean(this.store),
      site: req.site,
      accounts: req.accounts,
      anchor
    });
  }

  hide() {
    const req = this.shown;
    this.shown = null;
    clearTimeout(this.hideTimer);
    if (!req) return;
    const shell = this.shellFor(req.tab);
    if (shell) shell.hidePasskeys();
  }

  /** From the list: an account. */
  async pick(id) {
    const req = this.shown;
    if (!req || req.verifying || req.picking || !req.accounts.some((a) => a.id === id)) return;
    if (!this.store) { this.answer(req, { id }); return; }
    // One at a time: a second row clicked while Touch ID is up is not a
    // second sign-in.
    req.picking = true;
    // Kept here: it is you (Touch ID or the passcode), then the passkey goes
    // into the tab's authenticator for this one request.
    if (!(await this.confirm(req, `sign in to ${req.site}`))) {
      if (this.pending.get(req.tab.id) === req) this.answer(req, { cancel: true });
      return;
    }
    if (this.pending.get(req.tab.id) !== req) return;
    const ready = await this.store.prepareSignIn(req.tab, id);
    this.answer(req, ready ? { id, done: true } : { cancel: true });
  }

  /**
   * Save a passkey a page offers to make, where Debrowser keeps them. Asked
   * first, as Chrome asks; then it is you; then the page makes it.
   */
  async save(tab, frameUrl, site, { name = '', exclude = [] } = {}) {
    if (!this.store || !this.store.available() || !this.ask) return null;
    const shell = this.shellFor(tab);
    if (!shell) return null;
    // One question at a time per tab, and none for a little while after "Not
    // now": a page calling create() in a loop otherwise stacked dialogs.
    if ((this.saveQuiet.get(tab.id) || 0) > Date.now()) return { cancel: true };
    this.saveQuiet.set(tab.id, Infinity);
    try {
      return await this.saveAsked(tab, frameUrl, site, shell, { name, exclude });
    } finally {
      this.saveQuiet.set(tab.id, Date.now() + SAVE_QUIET_MS);
    }
  }

  async saveAsked(tab, frameUrl, site, shell, { name, exclude }) {
    const mine = new Set(((await this.store.list(site)) || []).map((a) => a.id));
    if (exclude.some((id) => mine.has(id))) return { exists: true };
    const who = name ? `${name} on ${site}` : site;
    const { response } = await this.ask(shell, {
      buttons: ['Save passkey', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      title: 'Save a passkey?',
      message: `Save a passkey for ${who}?`,
      detail: 'You will sign in with it instead of a password. It is encrypted and kept on this device, ' +
        'with your saved passwords, and is not copied anywhere else.'
    });
    if (response !== 0) return { cancel: true };
    if (tab.wc.isDestroyed() || originOf(tab.wc.getURL()) !== originOf(frameUrl)) return { cancel: true };
    this.watch(tab);
    this.settle(tab, { cancel: true });
    const req = { tab, site, accounts: [], conditional: false, resolve: () => {}, saving: true };
    this.pending.set(tab.id, req);
    const ok = await this.confirm(req, `save a passkey for ${site}`);
    if (this.pending.get(tab.id) !== req) return { cancel: true };
    this.pending.delete(tab.id);
    if (this.shown === req) this.hide();
    if (!ok) return { cancel: true };
    const ready = await this.store.prepareSave(tab, site);
    try { tab.wc.focus(); } catch { /* gone */ }
    return ready ? { go: true, done: true } : { cancel: true };
  }

  /**
   * It is you: Touch ID, or the passcode typed into the list - which the list
   * turns into for it. False on a refusal, a dismissal, or the page leaving.
   */
  async confirm(req, reason) {
    const shell = this.shellFor(req.tab);
    const verdict = await this.store.verify(reason, shell ? shell.window : null);
    if (verdict !== 'passcode') return verdict === 'ok';
    return new Promise((resolve) => {
      req.verifying = { resolve, reason };
      if (this.shown !== req) this.show(req, null);
      if (shell) {
        shell.passcodePasskeys({ title: req.saving ? `Save a passkey for ${req.site}` : `Sign in to ${req.site}` });
      }
    });
  }

  /** The passcode, from the list. */
  async passcode(code) {
    const req = this.shown;
    if (!req || !req.verifying || !this.store) return;
    const result = await this.store.unlock(code);
    if (!req.verifying) return;
    if (result && result.ok) {
      const { resolve } = req.verifying;
      req.verifying = null;
      resolve(true);
      return;
    }
    const shell = this.shellFor(req.tab);
    if (shell) {
      shell.passcodePasskeys({
        error: result && result.waitMs
          ? `Too many tries. Wait ${Math.ceil(result.waitMs / 1000)} seconds.`
          : 'That is not the passcode.'
      });
    }
  }

  /** The page's request settled: the store takes back what the tab held. */
  async done(tab) {
    if (this.store && tab.passkeyOp) await this.store.finish(tab);
  }

  /** From the list: "Use a different passkey" - Windows' own dialog. */
  other() {
    if (this.shown) this.answer(this.shown, { native: true });
  }

  /**
   * The list went away without a choice - Escape, or a click elsewhere. A
   * request made there and then is cancelled, as closing Windows' dialog
   * would; one waiting on the field keeps waiting, its dropdown back when the
   * field is.
   */
  dismiss({ escaped = false } = {}) {
    const req = this.shown;
    if (!req) return;
    if (req.verifying) {
      const { resolve } = req.verifying;
      req.verifying = null;
      this.hide();
      resolve(false);
      return;
    }
    if (req.conditional) { this.hide(); return; }
    // Escape gives the keyboard back to the page, as closing a menu does; a
    // click elsewhere leaves it where the click put it.
    if (escaped) this.answer(req, { cancel: true });
    else this.settle(req.tab, { cancel: true });
  }

  /**
   * The keyboard goes back to the page before the answer does: Chromium
   * refuses a passkey request from a page that is not focused, and the list
   * held the focus a moment ago.
   */
  answer(req, value) {
    this.hide();
    try { if (!req.tab.wc.isDestroyed()) req.tab.wc.focus(); } catch { /* gone */ }
    this.settle(req.tab, value);
  }

  /** A page that leaves, or a tab that closes, takes its request with it. */
  watch(tab) {
    if (this.watched.has(tab.wc)) return;
    this.watched.add(tab.wc);
    const wc = tab.wc;
    const forget = () => {
      tab.passkeyField = null;
      this.settle(tab, { cancel: true });
      if (this.store && tab.passkeyOp) this.store.finish(tab).catch(() => {});
    };
    wc.on('did-start-navigation', (details) => {
      if (details && details.isMainFrame && !details.isSameDocument) forget();
    });
    wc.once('destroyed', forget);
  }
}

module.exports = { PasskeyBroker, windowsLister, rpIdFor, accountsFrom };
