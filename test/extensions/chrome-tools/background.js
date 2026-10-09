// A right-click item for selected text: clicking it opens a tab saying so.
chrome.contextMenus.create({ id: 'say', title: 'Say “%s”', contexts: ['selection'] });
chrome.contextMenus.onClicked.addListener((info) => {
  chrome.tabs.create({ url: chrome.runtime.getURL(`done.html#clicked-${encodeURIComponent(info.selectionText || '')}`) });
});
// An alarm a moment from now: it opens a tab when it goes off.
chrome.alarms.onAlarm.addListener((alarm) => {
  chrome.tabs.create({ url: chrome.runtime.getURL(`done.html#alarm-${alarm.name}`) });
});
chrome.alarms.create('soon', { delayInMinutes: 0.02 });
// A rule added while running, beside the static one in rules.json.
chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [100],
  addRules: [{ id: 100, priority: 1, action: { type: 'block' },
    condition: { urlFilter: 'debrowser-dnr-dynamic', resourceTypes: ['xmlhttprequest'] } }]
});
