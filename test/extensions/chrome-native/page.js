// Asks the test host for its status over a port, then once more with
// sendNativeMessage, and tries a host that does not let it in.
window.results = (async () => {
  const out = { connectNative: typeof chrome.runtime.connectNative };
  out.status = await new Promise((resolve) => {
    const port = chrome.runtime.connectNative('com.debrowser.test_host');
    port.onMessage.addListener((msg) => { resolve(msg); port.disconnect(); });
    port.onDisconnect.addListener((p) => resolve({ gone: (p && p.error && p.error.message) || 'gone' }));
    port.postMessage({ type: 'get_status' });
  });
  out.echo = await chrome.runtime.sendNativeMessage('com.debrowser.test_host', { type: 'echo', text: 'hi' }).catch((e) => ({ error: e.message }));
  out.forbidden = await new Promise((resolve) => {
    const port = chrome.runtime.connectNative('com.debrowser.test_closed');
    port.onDisconnect.addListener((p) => resolve((p && p.error && p.error.message) || 'gone'));
    port.onMessage.addListener(() => resolve('answered'));
  });
  out.missing = await chrome.runtime.sendNativeMessage('com.debrowser.nobody', {}).then(() => 'answered', (e) => e.message);
  return out;
})();
