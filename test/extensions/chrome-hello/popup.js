// What a popup typically does first: find the page it was opened over. Also
// touches the APIs Electron does not have, which used to stop a popup dead.
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const win = await chrome.windows.getCurrent();
  const menu = chrome.contextMenus.create({ id: 'hello', title: 'Hello', contexts: ['page'] });
  document.title = `popup:${JSON.stringify({ url: tab && tab.url, win: Boolean(win && win.id), menu })}`;
})().catch((e) => { document.title = `popup-error:${e.message}`; });
