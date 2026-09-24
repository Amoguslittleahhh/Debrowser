'use strict';

/**
 * What the address bar offers as you type.
 *
 * Four sources, one list, at most seven rows:
 *
 *   tab       a page already open - picking it switches to that tab rather than
 *             loading the page a second time, which is the row people use most
 *             once they know it is there
 *   bookmark  something the user chose to keep
 *   history   somewhere they have been, weighted by how often and how lately
 *   search    the typed text, sent to their search engine - always offered,
 *             because the list must never make searching harder than it was
 *
 * Matching is on words, in any order, anywhere in the title or the address:
 * "git pull" finds "Pull requests · github.com". A match at the start of the
 * address, or at the start of a word in the title, counts for more, and a row
 * whose address begins with what was typed is the one inline completion fills.
 *
 * Pure: no Electron, no I/O. main.js hands it the lists; the smoke suite
 * hands it fixtures.
 */

const MAX_ROWS = 7;

/** The part of an address people type: no scheme, no `www.`. */
const stem = (url) => String(url || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '');

/** Whether text reads as an address rather than words to search for. */
function looksLikeAddress(text) {
  const t = text.trim();
  if (/\s/.test(t)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^[^\s/?#]+\.[^\s/?#]{2,}([/?#]|$)/.test(t) ||
    t === 'localhost' || t.startsWith('localhost:');
}

/**
 * How well `words` match a title and an address, or 0 for no match. Every word
 * must appear somewhere; where it appears decides the score.
 */
function matchScore(words, title, url) {
  const t = String(title || '').toLowerCase();
  const s = stem(url).toLowerCase();
  let score = 0;
  for (const w of words) {
    // In the middle of a word only counts for a longer word: "git" inside
    // "digital" is noise, "hub" inside "github" is not what anyone meant
    // either, but "request" inside "pullrequest" is.
    const midOk = w.length >= 4;
    const inUrl = s.indexOf(w);
    const inTitle = t.indexOf(w);
    let hit = 0;
    if (inUrl === 0) hit += 60;                                              // start of the address
    else if (inUrl > 0 && /[./\-_?=&]/.test(s[inUrl - 1])) hit += 30;         // start of a part of it
    else if (inUrl > 0 && midOk) hit += 10;
    if (inTitle === 0 || (inTitle > 0 && /[\s\-·|:(]/.test(t[inTitle - 1]))) hit += 25;
    else if (inTitle > 0 && midOk) hit += 8;
    if (!hit) return 0;
    score += hit;
  }
  return score;
}

/**
 * @param {object} input
 * @param {string} input.text
 * @param {Array<{id, title, url}>} input.tabs       - open tabs, active one excluded by the caller
 * @param {Array<{title, url}>} input.bookmarks
 * @param {Array<{title, url, visits, visitedAt}>} input.history
 * @param {string} input.engine                      - search engine's name, for the search row
 * @param {number} [input.now]
 * @returns {{items: object[], inline: string|null}}
 *   `inline` is the address stem inline completion should fill, if any.
 */
function suggest({ text, tabs = [], bookmarks = [], history = [], engine = 'the web', now = Date.now() }) {
  const typed = String(text || '').trim();
  if (!typed) return { items: [], inline: null };
  const lower = typed.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);

  // How much each address has been used, whichever list it comes from: a
  // bookmark visited every day should outrank one saved and never opened.
  const key = (url) => stem(url).replace(/\/$/, '').toLowerCase();
  const usage = new Map();
  for (const h of history) {
    const days = Math.max(0, (now - (h.visitedAt || 0)) / 86_400_000);
    const frequency = Math.min(Math.log2((h.visits || 1) + 1) * 30, 150);
    const recency = Math.max(0, 60 - days * 2);
    usage.set(key(h.url), frequency + recency);
  }

  const seen = new Map();   // one row per address; the better kind of row wins
  const offer = (kind, base, item) => {
    const m = matchScore(words, item.title, item.url);
    if (!m) return;
    const k = key(item.url);
    const candidate = {
      kind, title: item.title || stem(item.url), url: item.url,
      ...(kind === 'tab' ? { tabId: item.id } : {}),
      score: base + m + (usage.get(k) || 0)
    };
    const had = seen.get(k);
    if (!had || candidate.score > had.score) seen.set(k, candidate);
  };
  for (const tab of tabs) if (/^https?:/i.test(tab.url || '')) offer('tab', 150, tab);
  for (const b of bookmarks) offer('bookmark', 80, b);
  for (const h of history) offer('history', 0, h);

  const ranked = [...seen.values()].sort((a, b) => b.score - a.score);

  // Inline completion: the best row whose address starts with exactly what was
  // typed, the shorter address winning a tie - one word only, nothing else
  // would make sense to fill in.
  let inline = null;
  if (!/\s/.test(typed)) {
    const hits = ranked.filter((c) => stem(c.url).toLowerCase().startsWith(lower));
    hits.sort((a, b) => b.score - a.score || stem(a.url).length - stem(b.url).length);
    if (hits.length) inline = stem(hits[0].url);
  }

  const rows = [];
  if (looksLikeAddress(typed)) rows.push({ kind: 'go', title: typed, url: typed });
  // The row Enter would take comes first: the completed address if there is
  // one, then everything else by score, with the search row never lower than
  // third - a list full of history must not bury the plain search.
  const matches = ranked.slice(0, MAX_ROWS);
  const searchRow = { kind: 'search', title: typed, engine };
  const lead = inline ? matches.findIndex((c) => stem(c.url) === inline) : -1;
  if (lead > 0) matches.unshift(matches.splice(lead, 1)[0]);
  const head = matches.slice(0, rows.length ? 1 : 2);
  rows.push(...head, searchRow, ...matches.slice(head.length));
  return {
    items: rows.slice(0, MAX_ROWS).map(({ score, ...row }) => row),
    inline
  };
}

module.exports = { suggest, looksLikeAddress, matchScore, stem, MAX_ROWS };
