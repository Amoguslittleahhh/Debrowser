// Written for Firefox: `browser`, not `chrome`. Runs only if Debrowser put
// the shim in front of it.
document.documentElement.dataset.debrowserFirefoxExt = browser.runtime.getURL('x').length ? 'ran' : 'no-api';
