// Firefox's way to ask: browser.runtime.sendMessage returns a promise.
browser.runtime.sendMessage('ping').then((answer) => {
  document.documentElement.dataset.debrowserFirefoxExt = answer;
}, (e) => { document.documentElement.dataset.debrowserFirefoxExt = `error:${e.message}`; });
