'use strict';

/**
 * Tab groups (a Lab: Settings → Labs): tabs that belong together, under a name
 * and a colour, inside a space.
 *
 * A group folds away into its label, and a folded group's tabs go to sleep -
 * the same bargain spaces make, at the size of a task rather than a project.
 *
 * The groups themselves live here; which group a tab is in is `tab.groupId`.
 * Both are saved with the session (session.js), so a group lasts exactly as
 * long as its tabs do. A private window keeps them in memory only.
 */

const { COLOURS } = require('./spaces');

const cleanName = (value, fallback) => (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim().slice(0, 30) || fallback;
const ID = /^g[a-z0-9]{1,12}$/;

class TabGroups {
  constructor() {
    /** @type {Map<string, {id: string, name: string, color: string, collapsed: boolean}>} */
    this.map = new Map();
  }

  /** The one the session saves and restores through. */
  static current = null;

  get(id) { return (id && this.map.get(id)) || null; }

  create({ name, color } = {}) {
    let id;
    do { id = `g${Math.random().toString(36).slice(2, 8)}`; } while (this.map.has(id));
    const group = {
      id,
      name: cleanName(name, `Group ${this.map.size + 1}`),
      color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : COLOURS[(this.map.size + 1) % COLOURS.length],
      collapsed: false
    };
    this.map.set(id, group);
    return group;
  }

  rename(id, name) {
    const group = this.get(id);
    if (group) group.name = cleanName(name, group.name);
    return Boolean(group);
  }

  recolour(id, color) {
    const group = this.get(id);
    if (!group || !/^#[0-9a-f]{6}$/i.test(color || '')) return false;
    group.color = color;
    return true;
  }

  /** Fold or unfold; returns the new state, or null for no such group. */
  toggle(id, collapsed) {
    const group = this.get(id);
    if (!group) return null;
    group.collapsed = typeof collapsed === 'boolean' ? collapsed : !group.collapsed;
    return group.collapsed;
  }

  /** Forget the groups no tab is in any more. */
  prune(tabs) {
    const used = new Set(tabs.map((t) => t.groupId).filter(Boolean));
    for (const id of this.map.keys()) if (!used.has(id)) this.map.delete(id);
  }

  /** For the session file: only the groups these tabs are in. */
  save(tabs) {
    const used = new Set(tabs.map((t) => t.groupId).filter(Boolean));
    return [...this.map.values()].filter((g) => used.has(g.id)).map((g) => ({ ...g }));
  }

  /** From the session file; anything malformed is dropped. */
  load(list) {
    if (!Array.isArray(list)) return;
    for (const g of list.slice(0, 64)) {
      if (!g || typeof g.id !== 'string' || !ID.test(g.id)) continue;
      this.map.set(g.id, {
        id: g.id,
        name: cleanName(g.name, 'Group'),
        color: /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : COLOURS[0],
        collapsed: g.collapsed === true
      });
    }
  }

  /** For the state broadcast. */
  describe() {
    return Object.fromEntries([...this.map].map(([id, g]) => [id, { ...g }]));
  }
}

module.exports = { TabGroups, GROUP_ID: ID };
