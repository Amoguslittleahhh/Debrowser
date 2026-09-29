'use strict';

/**
 * Your own look for a site, and the parts of it you have hidden.
 *
 *   css   anything you write for a site - a darker background, a wider column,
 *         a font you can read - as Arc's Boosts and Zen's mods do
 *   hide  the things you clicked away with "Hide something on this page": a
 *         cookie wall the blocker missed, a sidebar, a sticky video, a
 *         "recommended for you" box - the element picker uBlock Origin made
 *         popular, and Safari's Distraction Control
 *
 * Both kept per site in site-prefs.json, and put into every page of that site
 * as it is parsed, as a user style sheet - which outranks the site's own.
 * Never in a private window, which keeps nothing about the sites it visits.
 */

const { SitePrefs } = require('./site-prefs');

const WORLD = 1003;

class SiteStyles {
  /** @param {SitePrefs} sitePrefs */
  constructor(sitePrefs) {
    this.sitePrefs = sitePrefs;
  }

  cssFor(host) {
    const hidden = this.sitePrefs.get(host, 'hide') || [];
    const own = this.sitePrefs.get(host, 'css') || '';
    return [hidden.length ? `${hidden.join(',\n')} { display: none !important; }` : '', own].filter(Boolean).join('\n');
  }

  /**
   * Put the site's style into a page as it is parsed. Only ever added to:
   * `removeInsertedCSS` does not take a sheet back out in this Electron
   * (measured: the element stays hidden), so a change that removes anything
   * reloads the page instead, which starts it from the saved style (main.js).
   */
  async apply(tab) {
    if (!tab.isLive || tab.internal) return;
    const css = this.cssFor(SitePrefs.hostOf(tab.wc.getURL()));
    if (css) await tab.wc.insertCSS(css, { cssOrigin: 'user' }).catch(() => {});
  }

  /** One more thing hidden, on a page already showing: just that rule. */
  async add(tab, selector) {
    if (!tab.isLive) return;
    await tab.wc.insertCSS(`${selector} { display: none !important; }`, { cssOrigin: 'user' }).catch(() => {});
  }

  /**
   * Let the user point at something on the page and hide it. Resolves to the
   * selector chosen, or null for Escape. In a world of its own, so the page's
   * scripts cannot see or steer the picker.
   */
  async pick(tab) {
    if (!tab.isLive || tab.internal) return null;
    try {
      return await tab.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: PICKER }], true);
    } catch {
      return null;
    }
  }

  /** Remember a hidden thing for the tab's site; the most recent last. */
  hide(host, selector) {
    const list = (this.sitePrefs.get(host, 'hide') || []).filter((s) => s !== selector);
    list.push(selector);
    this.sitePrefs.set(host, 'hide', list.slice(-50));
  }
}

/*
 * The picker: an outline follows the pointer, a click chooses, Escape gives
 * up. The selector is the shortest that names the element alone - its id if
 * that looks written by a person, else classes and positions up the tree -
 * leaving out names that look generated, which change on the next visit.
 */
const PICKER = `new Promise((resolve) => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2f857b;' +
    'background:rgba(47,133,123,.15);border-radius:3px;transition:all 60ms ease-out;';
  const tip = document.createElement('div');
  tip.textContent = 'Click something to hide it on this site · Esc to stop';
  tip.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);padding:6px 12px;' +
    'border-radius:999px;background:#1e1e1b;color:#fff;font:13px system-ui,sans-serif;pointer-events:none;';
  document.documentElement.append(box, tip);
  let target = null;
  const generated = (name) => /\\d{3,}|[a-f0-9]{6,}|^css-|^sc-|__[a-z0-9]{5}$/i.test(name);
  const selectorFor = (el) => {
    if (el.id && !generated(el.id) && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].filter((c) => !generated(c)).slice(0, 2);
      if (classes.length) part += classes.map((c) => '.' + CSS.escape(c)).join('');
      const siblings = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
      if (siblings.length > 1 && !classes.length) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(part);
      const sel = parts.join(' > ');
      if (document.querySelectorAll(sel).length === 1) return sel;
      // An ancestor with a person-written id anchors the rest of the path.
      if (node.id && !generated(node.id)) {
        parts[0] = '#' + CSS.escape(node.id);
        const anchored = parts.join(' > ');
        if (document.querySelectorAll(anchored).length === 1) return anchored;
      }
    }
    return parts.join(' > ');
  };
  const move = (e) => {
    target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === document.body || target === document.documentElement) { box.style.width = '0'; return; }
    const r = target.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  const done = (value) => {
    removeEventListener('mousemove', move, true);
    removeEventListener('click', click, true);
    removeEventListener('keydown', key, true);
    box.remove(); tip.remove();
    resolve(value);
  };
  const click = (e) => {
    e.preventDefault(); e.stopPropagation();
    done(target && target !== document.body ? selectorFor(target) : null);
  };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
  addEventListener('mousemove', move, true);
  addEventListener('click', click, true);
  addEventListener('keydown', key, true);
})`;

module.exports = { SiteStyles };
