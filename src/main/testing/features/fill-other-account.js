'use strict';

/**
 * Signing in to a second account on a site that has one saved.
 *
 * The saved sign-in is filled when the page finishes loading. The person may
 * already be typing a different account by then, or the site may have put one
 * in the box (an account chooser, a failed attempt coming back). The fill
 * must leave that alone: putting the saved account back signs them into the
 * account they were trying to leave.
 */

module.exports = async function fillOtherAccount(t) {
  const { check, waitFor, sleep, tabs } = t;
  let tab = null;
  try {
    tab = tabs.create({ url: t.pageUrl('save-password.html'), activate: true, realise: true });
    await waitFor(() => tab.isLive && !tab.loading && tab.wc.getURL().includes('save-password.html'), { timeoutMs: 10_000 });
    await tabs.activate(tab.id);
    const origin = new URL(tab.wc.getURL()).origin;
    const saved = { origin, username: 'saved@example.test', password: 'saved-password' };
    const fields = () => tab.wc.executeJavaScript(
      '[...document.querySelectorAll("input")].filter((e) => e.type !== "submit").map((e) => e.value)');
    const clear = () => tab.wc.executeJavaScript(
      'document.querySelectorAll("input").forEach((e) => { if (e.type !== "submit") e.value = ""; })');

    // Empty form: filled, as before.
    await clear();
    tab.sendToPage('debrowser:credential-fill', saved);
    await sleep(300);
    let got = await fields();
    check('a saved sign-in still fills an empty form',
      got.includes('saved@example.test') && got.includes('saved-password'), JSON.stringify(got));

    // Typed by the person: real key presses, then the late fill.
    await clear();
    await tab.wc.executeJavaScript('document.querySelector("input:not([type=password])").focus()');
    for (const ch of 'other@example.test') tab.wc.sendInputEvent({ type: 'char', keyCode: ch });
    await sleep(200);
    tab.sendToPage('debrowser:credential-fill', saved);
    await sleep(300);
    got = await fields();
    check('a fill never replaces an account the person typed',
      got.includes('other@example.test') && !got.includes('saved-password'), JSON.stringify(got));

    // Put there by the site.
    await tab.wc.reload();
    await waitFor(() => !tab.loading, { timeoutMs: 10_000 });
    await sleep(300);
    await clear();
    await tab.wc.executeJavaScript('document.querySelector("input:not([type=password])").value = "site@example.test"');
    tab.sendToPage('debrowser:credential-fill', saved);
    await sleep(300);
    got = await fields();
    check('a fill leaves another account the site put in the box',
      got.includes('site@example.test') && !got.includes('saved-password'), JSON.stringify(got));
  } finally {
    if (tab && tabs.all().includes(tab)) tabs.close(tab.id);
  }
};
