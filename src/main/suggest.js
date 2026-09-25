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

const { classifyAddress } = require('./address');

const MAX_ROWS = 7;

/** The part of an address people type: no scheme, no `www.`. */
const stem = (url) => String(url || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '');

/** Whether text reads as an address rather than words to search for. */
const looksLikeAddress = (text) => classifyAddress(text) !== null;

/**
 * How well `words` match a title and an address, or 0 for no match. Every word
 * must appear somewhere; where it appears decides the score.
 */
function matchScore(words, title, url) {
  return scoreLower(words, String(title || '').toLowerCase(), stem(url).toLowerCase());
}

/**
 * The best place a word appears in `text`, scored by `at`. Every occurrence is
 * looked at, not only the first: "art" is inside "smart" before it starts
 * "Art Gallery", and the first `indexOf` alone scored that title as no match.
 */
function bestHit(text, word, at) {
  let best = 0;
  for (let i = text.indexOf(word); i !== -1 && best < 60; i = text.indexOf(word, i + 1)) {
    best = Math.max(best, at(i, text));
  }
  return best;
}

function scoreLower(words, t, s) {
  let score = 0;
  for (const w of words) {
    // In the middle of a word only counts for a longer word: "git" inside
    // "digital" is noise, "hub" inside "github" is not what anyone meant
    // either, but "request" inside "pullrequest" is.
    const midOk = w.length >= 4;
    const hit =
      bestHit(s, w, (i) => (i === 0 ? 60                                // start of the address
        : /[./\-_?=&]/.test(s[i - 1]) ? 30                              // start of a part of it
          : midOk ? 10 : 0)) +
      bestHit(t, w, (i) => (i === 0 || /[\s\-·|:(]/.test(t[i - 1]) ? 25 : midOk ? 8 : 0));
    if (!hit) return 0;
    score += hit;
  }
  return score;
}

/*
 * The lowercased title and address stem of each history entry, kept between
 * keystrokes. Every letter typed in the bar ranks the whole history - up to
 * ten thousand pages - on the browser's main thread, and lowercasing and
 * stemming each one again for every letter was most of that work. Keyed by the
 * entry itself and checked against its current title and address, so a
 * renamed or forgotten entry is never matched on what it used to say.
 */
const prepared = new WeakMap();
function prepare(item) {
  const had = prepared.get(item);
  if (had && had.title === item.title && had.url === item.url) return had;
  const s = stem(item.url).toLowerCase();
  const p = { title: item.title, url: item.url, t: String(item.title || '').toLowerCase(), s, key: s.replace(/\/$/, '') };
  prepared.set(item, p);
  return p;
}

/**
 * @param {object} input
 * @param {string} input.text
 * @param {Array<{id, title, url}>} input.tabs       - open tabs, active one excluded by the caller
 * @param {Array<{title, url}>} input.bookmarks
 * @param {Array<{title, url, visits, visitedAt}>} input.history
 * @param {string} input.engine                      - search engine's name, for the search row
 * @param {boolean} [input.complete]                 - the bar will fill in `inline` as typed
 * @param {number} [input.now]
 * @returns {{items: object[], inline: string|null, inlineUrl: string|null}}
 *   `inline` is the address stem inline completion should fill, if any.
 */
function suggest({ text, tabs = [], bookmarks = [], history = [], engine = 'the web', complete = true, now = Date.now() }) {
  const typed = String(text || '').trim();
  if (!typed) return { items: [], inline: null, inlineUrl: null };
  const lower = typed.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);

  // How much each address has been used, whichever list it comes from: a
  // bookmark visited every day should outrank one saved and never opened.
  const usage = new Map();
  for (const h of history) {
    const days = Math.max(0, (now - (h.visitedAt || 0)) / 86_400_000);
    const frequency = Math.min(Math.log2((h.visits || 1) + 1) * 30, 150);
    const recency = Math.max(0, 60 - days * 2);
    usage.set(prepare(h).key, frequency + recency);
  }

  const seen = new Map();   // one row per address; the better kind of row wins
  const offer = (kind, base, item) => {
    const p = prepare(item);
    const m = scoreLower(words, p.t, p.s);
    if (!m) return;
    const candidate = {
      kind, title: item.title || stem(item.url), url: item.url,
      ...(kind === 'tab' ? { tabId: item.id } : {}),
      score: base + m + (usage.get(p.key) || 0)
    };
    const had = seen.get(p.key);
    if (!had || candidate.score > had.score) seen.set(p.key, candidate);
  };
  for (const tab of tabs) if (/^https?:/i.test(tab.url || '')) offer('tab', 150, tab);
  for (const b of bookmarks) offer('bookmark', 80, b);
  for (const h of history) offer('history', 0, h);

  const ranked = [...seen.values()].sort((a, b) => b.score - a.score);

  // Inline completion: the best row whose address starts with exactly what was
  // typed, the shorter address winning a tie - one word only, nothing else
  // would make sense to fill in.
  let inline = null;
  let inlineUrl = null;
  if (!/\s/.test(typed)) {
    const hits = ranked.filter((c) => stem(c.url).toLowerCase().startsWith(lower));
    hits.sort((a, b) => b.score - a.score || stem(a.url).length - stem(b.url).length);
    if (hits.length) {
      inlineUrl = hits[0].url;
      // A site's front page completes as `github.com`, as its row reads, not
      // `github.com/`; the full address is kept for Enter.
      inline = stem(inlineUrl).replace(/^([^/]+)\/$/, '$1');
      if (inline.length < typed.length) inline = stem(inlineUrl);
    }
  }

  // The first row is always what Enter does, and is marked so. That is the
  // completed address only when the bar is really going to fill it in - it
  // does not after a backspace, a paste, or with completion turned off - or
  // when the text already is that address. Otherwise it is the address as
  // typed, or the search.
  const exact = inline !== null && inline.toLowerCase() === lower;
  const leadUrl = inlineUrl && (exact || (complete && inline.length > typed.length)) ? inlineUrl : null;
  const searchRow = { kind: 'search', title: typed, engine };
  const address = looksLikeAddress(typed);
  const leadIndex = leadUrl ? ranked.findIndex((c) => c.url === leadUrl) : -1;
  const lead = leadIndex >= 0 ? ranked.splice(leadIndex, 1)[0]
    : address ? { kind: 'go', title: typed, url: typed }
      : searchRow;

  // After it, the best matches, and the search is always somewhere in the
  // list: no lower than third for words, last for something that is plainly
  // an address, where a second row repeating the typed text read as noise.
  // Room is kept for it before the matches are cut, rather than cutting it.
  const room = MAX_ROWS - (lead === searchRow ? 1 : 2);
  const matches = ranked.slice(0, room);
  const rows = [{ ...lead, isDefault: true }];
  if (lead === searchRow) rows.push(...matches);
  else if (address) rows.push(...matches, searchRow);
  else rows.push(...matches.slice(0, 1), searchRow, ...matches.slice(1));
  return {
    items: rows.map(({ score, ...row }) => row),
    inline,
    inlineUrl
  };
}

module.exports = { suggest, looksLikeAddress, matchScore, stem, MAX_ROWS };
