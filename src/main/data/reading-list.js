'use strict';

/**
 * Pages saved to read later - Safari's and Chrome's reading list.
 *
 * Saved from the tab's menu, the page's menu or the command bar, and listed
 * from the app menu: unread first, newest first, then the few read last.
 * Opening one shows it in reader view and marks it read. The last 300, in
 * `reading-list.json`; in a private window the list is never written (the
 * file is null), so nothing saved there outlives the window.
 */

const fs = require('fs');
const { readJson } = require('./store-file');

const KEPT = 300;

class ReadingList {
  constructor(file) {
    this.file = file;
    /** Newest first: { url, title, addedAt, readAt } */
    this.items = [];
    if (file) {
      try {
        const parsed = readJson(file);
        if (Array.isArray(parsed)) {
          this.items = parsed.filter((e) => e && typeof e.url === 'string' && /^https?:/i.test(e.url)).slice(0, KEPT)
            .map((e) => ({ url: e.url, title: String(e.title || '').slice(0, 300), addedAt: Number(e.addedAt) || 0,
              readAt: Number(e.readAt) || 0 }));
        }
      } catch { /* none yet */ }
    }
  }

  save() {
    if (!this.file) return;
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch { /* kept for this run */ }
  }

  has(url) { return this.items.some((e) => e.url === url); }

  /** Saved again, it moves to the top as unread. */
  add(url, title) {
    if (typeof url !== 'string' || !/^https?:/i.test(url)) return false;
    this.items = [{ url, title: String(title || '').slice(0, 300), addedAt: Date.now(), readAt: 0 },
      ...this.items.filter((e) => e.url !== url)].slice(0, KEPT);
    this.save();
    return true;
  }

  markRead(url) {
    const entry = this.items.find((e) => e.url === url);
    if (!entry || entry.readAt) return;
    entry.readAt = Date.now();
    this.save();
  }

  remove(url) {
    const before = this.items.length;
    this.items = this.items.filter((e) => e.url !== url);
    if (this.items.length !== before) this.save();
  }

  clearRead() {
    this.items = this.items.filter((e) => !e.readAt);
    this.save();
  }

  get unread() { return this.items.filter((e) => !e.readAt); }

  /** Most recently read first. */
  get read() { return this.items.filter((e) => e.readAt).sort((a, b) => b.readAt - a.readAt); }
}

module.exports = { ReadingList };
