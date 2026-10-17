browser.runtime.sendMessage('pong').then((answer) => {
  document.documentElement.dataset.debrowserFirefoxMv3 = answer;
}, (e) => { document.documentElement.dataset.debrowserFirefoxMv3 = `error:${e.message}`; });
