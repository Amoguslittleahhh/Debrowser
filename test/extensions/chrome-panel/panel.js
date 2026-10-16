// Reads its tab's title through the debugger, and signs in without showing
// anything (the test server's /authorize answers at once). The result is the
// page's title, for the test to read.
(async () => {
  const tabId = Number(new URLSearchParams(location.search).get('tabId'));
  const out = { tabId };
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    out.title = r && r.result ? r.result.value : null;
    await chrome.debugger.detach({ tabId });
  } catch (e) { out.title = `error: ${e.message}`; }
  try {
    const tab = await chrome.tabs.get(tabId);
    const back = chrome.identity.getRedirectURL('done');
    const url = `${new URL(tab.url).origin}/authorize?redirect_uri=${encodeURIComponent(back)}&state=s1`;
    out.signedIn = await chrome.identity.launchWebAuthFlow({ url, interactive: false });
    out.back = back;
  } catch (e) { out.signedIn = `error: ${e.message}`; }
  document.title = `panel:${JSON.stringify(out)}`;
})();
