'use strict';

/**
 * Tabs that show a page another tab already shows.
 *
 * The same address, ignoring the part after `#` - a page scrolled to another
 * heading is still the same page. Of each set, the one kept is the tab in
 * front if it is one of them, else a pinned one, else the one used last; the
 * rest are the duplicates. A pinned tab is never one of those closed.
 *
 * @param {Array<{id: number, url: string, pinned?: boolean, lastActiveAt?: number}>} list
 * @param {number|null} activeId
 * @returns {Array<object>} the tabs to close, in strip order
 */
function duplicateTabs(list, activeId = null) {
  const key = (url) => String(url || '').split('#')[0];
  const groups = new Map();
  for (const tab of list) {
    if (!tab.url) continue;
    const k = key(tab.url);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(tab);
  }
  const doomed = new Set();
  for (const same of groups.values()) {
    if (same.length < 2) continue;
    const keep = same.find((t) => t.id === activeId) || same.find((t) => t.pinned) ||
      [...same].sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))[0];
    for (const t of same) if (t !== keep && !t.pinned) doomed.add(t);
  }
  return list.filter((t) => doomed.has(t));
}

module.exports = { duplicateTabs };
