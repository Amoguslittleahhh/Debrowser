// Firefox's way to answer a message: return a promise. "last-url" asks what
// tabs.onUpdated last said; anything else is pinged back.
let lastUrl = '';
browser.tabs.onUpdated.addListener((tabId, change) => { if (change.url) lastUrl = change.url; });
browser.runtime.onMessage.addListener((message) =>
  Promise.resolve(message === 'last-url' ? lastUrl : `pong:${message}`));
// A request refused by the extension's own code, as uBlock Origin does it.
browser.webRequest.onBeforeRequest.addListener(() => ({ cancel: true }),
  { urls: ['*://*/debrowser-wr-block*'] }, ['blocking']);
