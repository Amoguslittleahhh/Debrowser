// Firefox's way to ask: browser.runtime.sendMessage returns a promise.
const root = document.documentElement.dataset;
browser.runtime.sendMessage('ping').then((answer) => { root.debrowserFirefoxExt = answer; },
  (e) => { root.debrowserFirefoxExt = `error:${e.message}`; });
setTimeout(() => {
  browser.runtime.sendMessage('last-url').then((url) => { root.debrowserFirefoxTabs = url; }, () => {});
}, 500);
