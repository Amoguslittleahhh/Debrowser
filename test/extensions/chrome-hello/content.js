// Proof of life: the page's root element says which extension ran, and that
// the Chrome API it was given knows who it is.
document.documentElement.dataset.debrowserChromeExt = chrome.runtime && chrome.runtime.id ? 'ran' : 'no-api';
