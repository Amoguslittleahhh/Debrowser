'use strict';

/**
 * What the browser did for you, day by day.
 *
 *   freedMB   memory handed back by putting tabs to sleep
 *   slept     tabs put to sleep (frozen, hibernated or discarded)
 *   blocked   ads and trackers not loaded
 *   cleaned   links that had their tracking taken out
 *   stopped   dangerous or look-alike sites stopped
 *
 * Seven days, totals only: no address, no site, nothing about what was
 * browsed - a receipt, not a history. Kept in `receipts.json`, and not at all
 * for a private window.
 *
 * The sources count from the start of the session; this reads them once a
 * minute and adds what changed to today, so a restart loses at most a minute.
 */

const fs = require('fs');

const DAYS = 7;
const KEYS = ['freedMB', 'slept', 'blocked', 'cleaned', 'stopped'];

const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

class Receipts {
  /**
   * @param {string|null} file
   * @param {() => Record<string, number>} read - the session's running totals, by KEYS
   */
  constructor(file, read) {
    this.file = file;
    this.read = read;
    this.last = null;
    /** date -> totals */
    this.days = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [date, totals] of Object.entries(parsed || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !totals || typeof totals !== 'object') continue;
        this.days.set(date, Object.fromEntries(KEYS.map((k) => [k, Math.max(0, Number(totals[k]) || 0)])));
      }
    } catch { /* first run */ }
  }

  save() {
    if (!this.file) return;
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.days)), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch { /* read-only profile: kept in memory */ }
  }

  /** Add what changed since the last look to today, and keep seven days. */
  tick(now = Date.now()) {
    const current = this.read();
    const date = dayOf(now);
    const today = this.days.get(date) || Object.fromEntries(KEYS.map((k) => [k, 0]));
    for (const key of KEYS) {
      const value = Number(current[key]) || 0;
      const before = this.last ? Number(this.last[key]) || 0 : value;
      // A counter that went down was reset (a new engine, say): count from there.
      today[key] += value >= before ? value - before : value;
    }
    this.last = current;
    this.days.set(date, today);
    for (const old of [...this.days.keys()].sort().slice(0, Math.max(0, this.days.size - DAYS))) this.days.delete(old);
  }

  today(now = Date.now()) {
    const t = this.days.get(dayOf(now));
    return t ? { ...t, freedMB: Math.round(t.freedMB) } : null;
  }

  /** The last seven days, oldest first, with zeros for days the browser was not open. */
  week(now = Date.now()) {
    const out = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const date = dayOf(now - i * 86_400_000);
      const t = this.days.get(date) || Object.fromEntries(KEYS.map((k) => [k, 0]));
      out.push({ date, ...t, freedMB: Math.round(t.freedMB) });
    }
    return out;
  }
}

module.exports = { Receipts, dayOf };
