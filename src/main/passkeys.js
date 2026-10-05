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
 */
class PasskeyBroker {
  /**
   * @param {object} deps
   * @param {((rpId: string) => Promise<object[]|null>)|null} deps.list
   * @param {(tab: object) => object|null} deps.shellFor - the window a tab is in
   * @param {(...a) => void} [deps.log]
   */
  constructor({ list, shellFor, log = () => {} }) {
    this.list = list;
    this.shellFor = shellFor;
    this.log = log;
    /** @type {Map<number, object>} tab id -> request */
    this.pending = new Map();
    this.shown = null;
    this.hideTimer = null;
    this.watched = new WeakSet();
  }

  available() { return typeof this.list === 'function'; }

  /** A page asked. Resolves with one of the answers above. */
  async request(tab, frameUrl, { rpId, conditional }) {
    if (!this.available() || !tab || !tab.wc || tab.wc.isDestroyed()) return null;
    const site = rpIdFor(frameUrl, rpId);
    if (!site) return null;
    const accounts = await this.list(site).catch(() => null);
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

  /** Answer a tab's request, if it has one, and take its list away. */
  settle(tab, answer) {
    const req = this.pending.get(tab.id);
    if (!req) return;
    this.pending.delete(tab.id);
    if (this.shown === req) this.hide();
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
  pick(id) {
    const req = this.shown;
    if (!req || !req.accounts.some((a) => a.id === id)) return;
    this.answer(req, { id });
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
    const forget = () => { tab.passkeyField = null; this.settle(tab, { cancel: true }); };
    wc.on('did-start-navigation', (details) => {
      if (details && details.isMainFrame && !details.isSameDocument) forget();
    });
    wc.once('destroyed', forget);
  }
}

module.exports = { PasskeyBroker, windowsLister, rpIdFor, accountsFrom };
