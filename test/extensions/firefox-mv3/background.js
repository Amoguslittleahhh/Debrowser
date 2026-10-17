browser.runtime.onMessage.addListener((message) => Promise.resolve(`mv3:${message}`));
