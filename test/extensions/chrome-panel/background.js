// A click on the extension opens its side panel for that tab, as Claude's does.
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.setOptions({ tabId: tab.id, path: `panel.html?tabId=${tab.id}`, enabled: true });
  await chrome.sidePanel.open({ tabId: tab.id });
});
