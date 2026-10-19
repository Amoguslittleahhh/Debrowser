'use strict';

/**
 * "Save password?" stays up after a sign-in until the user answers it.
 *
 * A sign-in form submits and the page goes on to the next one, and that page
 * loading - focus, a resize of the content area, the chrome redrawing - must
 * not take the question away before the user has read it.
 */

const crypto = require('crypto');

const PASSCODE = 'save-password-smoke-passcode';

module.exports = async function savePassword(t) {
  const { check, waitFor, sleep, tabs, shell, credentials, vault } = t;
  if (!credentials || !vault) {
    check('a sign-in can be offered for saving', false, 'no credentials or vault in this run');
    return;
  }
  const before = {
    key: credentials.key, loaded: credentials.loaded, unavailable: credentials.unavailable,
    records: credentials.records,
    capability: Object.prototype.hasOwnProperty.call(credentials, 'capability') ? credentials.capability : null,
    vaultRecord: vault.record, unlockedUntil: vault.unlockedUntil
  };
  let tab = null;
  try {
    credentials.key = crypto.randomBytes(32);
    credentials.loaded = true;
    credentials.unavailable = null;
    credentials.capability = () => ({ available: true, reason: null });
    credentials.records = { login: [], payment: [], address: [], passkey: [] };
    if (vault.configured()) vault.write(null);
    await vault.setPasscode(PASSCODE);

    tab = tabs.create({ url: t.pageUrl('save-password.html'), activate: true, realise: true });
    await waitFor(() => tab.isLive && !tab.loading && tab.wc.getURL().includes('save-password.html'), { timeoutMs: 10_000 });
    await tabs.activate(tab.id);
    await tab.wc.executeJavaScript('document.querySelector("form").requestSubmit()');

    const asked = await waitFor(() => shell.sheetPage === 'ask', { timeoutMs: 8000 });
    await waitFor(() => tab.wc.getURL().includes('save-password-done') && !tab.loading, { timeoutMs: 8000 });
    // The next page taking the keyboard, as it does on Windows once it has
    // loaded; Xvfb never moves focus on its own.
    tab.wc.focus();
    // Long enough for everything the next page sets off to have happened.
    await sleep(1500);
    const refocused = shell.sheetView?.webContents.isFocused() === true;
    const stayed = shell.sheetPage === 'ask' && /Save password/.test(shell.askSpec()?.title || '');
    check('"Save password?" stays on screen after the sign-in page moves on',
      asked && stayed && refocused, `asked=${asked}, sheet now ${shell.sheetPage}, keyboard back=${refocused}`);

    // And the answer still saves.
    if (stayed) shell.answerAsk({ response: 0 });
    const saved = await waitFor(() => credentials.records.login.some((r) => r.username === 'ada@example.test'),
      { timeoutMs: 3000 });
    check('answering Save keeps the sign-in', saved, `logins ${credentials.records.login.length}`);
  } finally {
    if (shell.sheetPage === 'ask') shell.closeSheet();
    if (tab && tabs.all().includes(tab)) tabs.close(tab.id);
    credentials.key = before.key;
    credentials.loaded = before.loaded;
    credentials.unavailable = before.unavailable;
    credentials.records = before.records;
    if (before.capability) credentials.capability = before.capability; else delete credentials.capability;
    try { vault.write(before.vaultRecord ?? null); } catch { /* memory only */ }
    vault.unlockedUntil = before.unlockedUntil;
  }
};
