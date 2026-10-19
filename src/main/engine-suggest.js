'use strict';

/**
 * What the chosen search engine suggests for the words being typed.
 *
 * The address bar's own list (suggest.js) knows only this browser: open tabs,
 * bookmarks, history. This adds the engine's completions of the words -
 * "how to b" -> "how to boil an egg" - as further search rows, in the bar and
 * in the new tab page's search field.
 *
 * Every engine here answers the same OpenSearch shape, `[query, [phrase...]]`,
 * at the address in prefs.js's SEARCH_ENGINES (`suggest`). Asked without
 * cookies: the engine learns the words, as it would on Enter, but not who is
 * typing them. Never asked from a private window (main.js), never for text
 * that reads as an address - a typed intranet name is not the engine's
 * business - and not at all with "Search suggestions" off.
 *
 * `merge` and `parse` are pure; `EngineSuggest` does the asking.
 */

const { looksLikeAddress } = require('./suggest');

/** Phrases the engine adds at most, and rows the list has at most with them. */
const MAX_PHRASES = 4;
const MAX_ROWS = 8;

/** The phrases in an OpenSearch answer, or none for anything else. */
function parse(body) {
  let data;
  try { data = typeof body === 'string' ? JSON.parse(body) : body; } catch { return []; }
  if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
  return data[1].filter((p) => typeof p === 'string').map((p) => p.trim()).filter((p) => p && p.length <= 200);
}

/** Whether the engine should be asked about `text` at all. */
function worthAsking(text) {
  const typed = String(text || '').trim();
  if (!typed || typed.length > 200) return false;
  if (/^[>@]/.test(typed)) return false;            // the command bar, tab search
  return !looksLikeAddress(typed);
}

/**
 * The list with the engine's phrases in it: straight after the row that
 * searches for what was typed, so Enter still does what it did and the
 * user's own pages stay in the list below.
 *
 * @param {object[]} items  - suggest()'s rows
 * @param {string[]} phrases
 * @param {string} typed
 * @param {string} engine   - the engine's name, as the search row says it
 */
function merge(items, phrases, typed, engine) {
  const lower = String(typed || '').trim().toLowerCase();
  const at = items.findIndex((r) => r.kind === 'search' && String(r.title).toLowerCase() === lower);
  // A site shortcut leads (`yt cats`): its search is the site's, not the engine's.
  if (at < 0 || items.some((r) => r.kind === 'shortcut')) return items;
  const have = new Set(items.filter((r) => r.kind === 'search').map((r) => String(r.title).toLowerCase()));
  const rows = [];
  for (const p of phrases) {
    const key = p.toLowerCase();
    if (have.has(key)) continue;
    have.add(key);
    rows.push({ kind: 'search', title: p, engine, suggested: true });
    if (rows.length >= MAX_PHRASES) break;
  }
  if (!rows.length) return items;
  return [...items.slice(0, at + 1), ...rows, ...items.slice(at + 1)].slice(0, MAX_ROWS);
}

/**
 * Asks the engine, one question at a time: a newer keystroke cancels the
 * question before it, and recent answers are kept, so a backspace costs
 * nothing.
 */
class EngineSuggest {
  /**
   * @param {object} deps
   * @param {(url: string, signal: AbortSignal) => Promise<string>} deps.fetchText
   */
  constructor({ fetchText, log = () => {}, timeoutMs = 1500 }) {
    this.fetchText = fetchText;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();     // url -> { at, phrases }
    this.inFlight = null;
  }

  /** A recent answer for this address, if there is one. */
  cached(url) {
    const hit = this.cache.get(url);
    if (!hit || Date.now() - hit.at > 5 * 60_000) return null;
    return hit.phrases;
  }

  /** The engine's phrases for `url`, or null if a newer question replaced it. */
  async ask(url) {
    const had = this.cached(url);
    if (had) return had;
    if (this.inFlight) this.inFlight.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const phrases = parse(await this.fetchText(url, controller.signal));
      this.cache.set(url, { at: Date.now(), phrases });
      if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
      return controller.signal.aborted ? null : phrases;
    } catch (err) {
      if (!controller.signal.aborted) this.log(`search suggestions failed: ${err.message}`);
      return null;
    } finally {
      clearTimeout(timer);
      if (this.inFlight === controller) this.inFlight = null;
    }
  }
}

module.exports = { EngineSuggest, parse, merge, worthAsking, MAX_PHRASES, MAX_ROWS };
