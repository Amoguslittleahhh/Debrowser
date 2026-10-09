// Firefox's way to answer a message: return a promise.
browser.runtime.onMessage.addListener((message) => Promise.resolve(`pong:${message}`));
