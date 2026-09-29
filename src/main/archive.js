'use strict';

/**
 * Tabs put away because they were not opened for a while - Arc's archive.
 *
 * Off unless chosen (Settings, `autoArchiveDays`). A tab not looked at for
 * that many days leaves the strip for this list, which tab search shows under
 * the open tabs; picking one opens it again where it was. Pinned tabs, tabs
 * playing sound and the tab in front are never archived. The last 200, in
 * `archive.json`; nothing at all in a private window.
 */

const fs = require('fs');

const KEPT = 200;

class Archive {
  constructor(file) {
    this.file = file;
    /** Newest first: { url, title, spaceId, at } */
    this.items = [];
    if (file) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) {
          this.items = parsed.filter((e) => e && typeof e.url === 'string' && /^https?:/i.test(e.url)).slice(0, KEPT)
            .map((e) => ({ url: e.url, title: String(e.title || '').slice(0, 300), spaceId: String(e.spaceId || 'home'), at: Number(e.at) || 0 }));
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

  add(tab) {
    this.items = [{ url: tab.url, title: tab.title || '', spaceId: tab.spaceId || 'home', at: Date.now() },
      ...this.items.filter((e) => e.url !== tab.url)].slice(0, KEPT);
    this.save();
  }

  take(index) {
    const [entry] = this.items.splice(index, 1);
    this.save();
    return entry || null;
  }

  /**
   * The tabs that have gone unopened for `days`: never pinned, audible or in
   * front, and only websites - our own pages are cheap to open again anyway.
   */
  static due(tabs, days, now = Date.now()) {
    if (!days) return [];
    const limit = days * 86_400_000;
    return tabs.filter((t) => !t.pinned && !t.visible && !t.audible && /^https?:/i.test(t.url || '') &&
      now - (t.lastActiveAt || now) > limit);
  }
}

module.exports = { Archive };
