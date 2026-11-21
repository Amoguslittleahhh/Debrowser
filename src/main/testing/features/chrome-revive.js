'use strict';

/**
 * The toolbar and tabs crashing over and over (window.js, reviveOnCrash):
 * reloaded three times in a minute, then a notice over the whole window
 * whose Reload brings them back. DEBROWSER_SHOTS=<dir> also photographs the
 * notice in every design, light and dark.
 */

const fs = require('fs');
const path = require('path');

module.exports = async function chromeRevive(t) {
  const { check, waitFor, sleep, shell, prefs } = t;
  const chrome = shell.chromeView.webContents;
  const ready = (wc) => waitFor(() => Promise.race([
    wc.executeJavaScript('document.readyState === "complete"').catch(() => false),
    sleep(300).then(() => false)
  ]), { timeoutMs: 10_000 });

  for (let i = 0; i < 4 && !shell.chromeDownView; i++) {
    chrome.forcefullyCrashRenderer();
    await waitFor(() => Boolean(shell.chromeDownView) || !chrome.isCrashed(), { timeoutMs: 10_000 });
    if (!shell.chromeDownView) await ready(chrome);
  }
  const shown = await waitFor(() => Boolean(shell.chromeDownView), { timeoutMs: 5000 });
  check('a toolbar that keeps crashing says so over the window', shown, `notice=${Boolean(shell.chromeDownView)}`);
  if (!shown) return;

  const notice = shell.chromeDownView.webContents;
  await ready(notice);
  const words = await notice.executeJavaScript('document.querySelector("h1").textContent').catch(() => '');
  check('the notice names the toolbar, not a tab', /toolbar/i.test(words), `"${words}"`);

  const dir = process.env.DEBROWSER_SHOTS;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    const before = { design: prefs.get('design'), theme: prefs.get('theme') };
    for (const design of ['ledger', 'paper', 'grid', 'calm', 'legacy']) {
      for (const theme of ['light', 'dark']) {
        t.runCommand('set-pref', { key: 'design', value: design });
        t.runCommand('set-pref', { key: 'theme', value: theme });
        await sleep(600);
        fs.writeFileSync(path.join(dir, `${design}-${theme}.png`), (await notice.capturePage()).toPNG());
      }
    }
    t.runCommand('set-pref', { key: 'design', value: before.design });
    t.runCommand('set-pref', { key: 'theme', value: before.theme });
  }

  await notice.executeJavaScript('document.getElementById("reload").click()').catch(() => {});
  const back = await waitFor(() => !shell.chromeDownView && !chrome.isCrashed() && !chrome.isLoading(), { timeoutMs: 10_000 });
  check('Reload on the notice brings the toolbar and tabs back', back,
    `notice=${Boolean(shell.chromeDownView)}, crashed=${chrome.isCrashed()}`);
};
