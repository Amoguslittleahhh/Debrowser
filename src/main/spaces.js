'use strict';

/**
 * Spaces: named sets of tabs - Work, Home, a project - each with a colour, one
 * showing at a time.
 *
 * What makes them more than folders is what happens to the ones you are not
 * in. A space you leave goes to sleep a little later (main.js, `switch-space`),
 * so a dozen tabs of a project you will not touch until tomorrow cost nothing
 * until you come back to it. And a space can be a *container*: its own cookies
 * and storage, in a partition of its own, so the same site can be signed in to
 * two accounts at once - work mail in Work, your own in Home - as Firefox's
 * containers do and no Chromium browser does.
 *
 * Kept in `spaces.json`. The first space, "Home", always exists and uses the
 * ordinary browsing partition; a private window has only it and saves nothing.
 */

const fs = require('fs');
const path = require('path');

const HOME = 'home';
const MAX_SPACES = 12;
/** The accents Settings offers (settings.js, ACCENTS), which read on both themes. */
const COLOURS = ['#2f857b', '#6f8f5f', '#a8694a', '#b08a3c', '#7b6a9c', '#5f7d9c', '#b0306a'];

const cleanName = (value, fallback) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40) || fallback;

class Spaces {
  /**
   * @param {string|null} dir - where spaces.json lives; null keeps it in memory
   * @param {string} browsingPartition - Home's partition
   */
  constructor(dir, browsingPartition) {
    this.file = dir ? path.join(dir, 'spaces.json') : null;
    this.browsingPartition = browsingPartition;
    this.list = [{ id: HOME, name: 'Home', color: COLOURS[0], container: false }];
    this.activeId = HOME;
    /** The tab last shown in each space, so coming back lands where you left. */
    this.lastTab = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return; }
    if (!parsed || !Array.isArray(parsed.spaces)) return;
    const seen = new Set();
    const list = [];
    for (const s of parsed.spaces.slice(0, MAX_SPACES)) {
      if (!s || typeof s.id !== 'string' || !/^[a-z0-9-]{1,24}$/.test(s.id) || seen.has(s.id)) continue;
      seen.add(s.id);
      list.push({
        id: s.id,
        name: cleanName(s.name, 'Space'),
        color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : COLOURS[list.length % COLOURS.length],
        container: s.id !== HOME && s.container === true
      });
    }
    if (!list.some((s) => s.id === HOME)) list.unshift(this.list[0]);
    this.list = list;
    if (list.some((s) => s.id === parsed.activeId)) this.activeId = parsed.activeId;
  }

  save() {
    if (!this.file) return;
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ spaces: this.list, activeId: this.activeId }, null, 2), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch { /* read-only profile: kept for this run */ }
  }

  get active() { return this.byId(this.activeId) || this.list[0]; }

  byId(id) { return this.list.find((s) => s.id === id) || null; }

  /** A space a tab can be put in: its own if it still exists, else Home. */
  resolve(id) { return this.byId(id) ? id : HOME; }

  /** Where a space's tabs keep their cookies and storage. */
  partitionFor(id) {
    const space = this.byId(id);
    return space && space.container ? `persist:space-${space.id}` : this.browsingPartition;
  }

  create({ name, color, container = false } = {}) {
    if (this.list.length >= MAX_SPACES) return null;
    let id;
    do { id = `s${Math.random().toString(36).slice(2, 8)}`; } while (this.byId(id));
    const space = {
      id,
      name: cleanName(name, `Space ${this.list.length + 1}`),
      color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : COLOURS[this.list.length % COLOURS.length],
      container: container === true
    };
    this.list.push(space);
    this.save();
    return space;
  }

  /** Rename or recolour. Whether it is a container is decided when it is made. */
  update(id, { name, color } = {}) {
    const space = this.byId(id);
    if (!space) return false;
    if (name !== undefined) space.name = cleanName(name, space.name);
    if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) space.color = color;
    this.save();
    return true;
  }

  /** Remove a space. Home cannot go; the caller moves or closes its tabs. */
  remove(id) {
    if (id === HOME || !this.byId(id)) return false;
    this.list = this.list.filter((s) => s.id !== id);
    if (this.activeId === id) this.activeId = HOME;
    this.lastTab.delete(id);
    this.save();
    return true;
  }

  activate(id) {
    if (!this.byId(id) || this.activeId === id) return false;
    this.activeId = id;
    this.save();
    return true;
  }

  /** For the state broadcast. */
  describe() {
    return { activeId: this.activeId, list: this.list.map((s) => ({ ...s })) };
  }
}

module.exports = { Spaces, HOME, COLOURS };
