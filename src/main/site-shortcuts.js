'use strict';

/**
 * Site search shortcuts: a word, a space, and what to look for -
 * `yt cats` searches YouTube, `w Paris` Wikipedia - without going through the
 * search engine first. A few come set up; Settings → Search and startup
 * edits the list.
 *
 * Pure: no Electron, no I/O. The list itself is a preference (prefs.js,
 * `siteShortcuts`).
 */

const DEFAULT_SHORTCUTS = [
  { key: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' },
  { key: 'w', name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search=%s' },
  { key: 'gh', name: 'GitHub', url: 'https://github.com/search?q=%s' },
  { key: 'r', name: 'Reddit', url: 'https://www.reddit.com/search/?q=%s' },
  { key: 'maps', name: 'Google Maps', url: 'https://www.google.com/maps/search/%s' },
  { key: 'so', name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q=%s' }
];

const KEY = /^[a-z0-9.]{1,16}$/;

/** One entry as Settings may save it, or null. */
function cleanShortcut(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const key = String(entry.key || '').trim().toLowerCase();
  const name = String(entry.name || '').trim().slice(0, 40);
  const url = String(entry.url || '').trim();
  if (!KEY.test(key) || !name || url.length > 2048 || !url.includes('%s')) return null;
  try {
    if (new URL(url.replace('%s', 'x')).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { key, name, url };
}

/**
 * The list as Settings shows and saves it: one per line, the word, the name,
 * then the address with %s where the search goes -
 *
 *   yt  YouTube  https://www.youtube.com/results?search_query=%s
 *
 * A line that does not make sense is left out rather than refusing the rest;
 * the first line for a word wins.
 */
function parseShortcuts(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/).slice(0, 200)) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const url = parts[parts.length - 1];
    let name = parts.slice(1, -1).join(' ');
    if (!name) {
      try { name = new URL(url.replace('%s', 'x')).hostname.replace(/^www\./, ''); } catch { continue; }
    }
    const entry = cleanShortcut({ key: parts[0], name, url });
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push(entry);
    if (out.length >= 50) break;
  }
  return out;
}

const DEFAULT_SHORTCUTS_TEXT = DEFAULT_SHORTCUTS.map((e) => `${e.key}  ${e.name}  ${e.url}`).join('\n');

/**
 * `yt cats` against the list: the shortcut and the search it makes, or null.
 * The word alone ("yt") is not one yet - that is still someone typing.
 */
function resolveShortcut(text, list) {
  if (typeof list === 'string') list = parseShortcuts(list);
  const m = /^(\S+)\s+(\S.*)$/.exec(String(text || '').trim());
  if (!m || !Array.isArray(list)) return null;
  const key = m[1].toLowerCase();
  const hit = list.find((e) => e && String(e.key).toLowerCase() === key);
  if (!hit) return null;
  const query = m[2].trim();
  return { key: hit.key, name: hit.name, query, url: hit.url.replace('%s', encodeURIComponent(query)) };
}

module.exports = { DEFAULT_SHORTCUTS, DEFAULT_SHORTCUTS_TEXT, cleanShortcut, parseShortcuts, resolveShortcut };
