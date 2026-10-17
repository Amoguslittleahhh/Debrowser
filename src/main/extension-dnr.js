'use strict';

/**
 * declarativeNetRequest, run by Debrowser for extensions.
 *
 * Chrome's way for an extension to block, allow, redirect or upgrade
 * requests, and to change their headers - from rules the extension declares
 * rather than code that sees each request. Electron does not run it, so an
 * ad blocker built on it (uBlock Origin Lite, AdGuard, most current Chrome
 * blockers) loaded, opened its popup and blocked nothing. Debrowser runs the
 * rules itself, on the same request hooks as its own blocker (web-hooks.js).
 *
 * Covered: static rulesets from the manifest (enabled, disabled, and rules
 * switched off by id), dynamic rules (kept on disk) and session rules; the
 * conditions urlFilter, regexFilter, requestDomains, excludedRequestDomains,
 * initiatorDomains, excludedInitiatorDomains, domainType, resourceTypes,
 * excludedResourceTypes and requestMethods; the actions block, allow,
 * allowAllRequests, upgradeScheme, redirect (url, extensionPath,
 * regexSubstitution, transform) and modifyHeaders. Priority as Chrome orders
 * it: the highest priority, then allow over block over upgrade over redirect.
 *
 * Fast enough for uBlock Origin Lite's tens of thousands of rules: each rule
 * is filed under the longest plain word in its urlFilter, a request looks up
 * only the rules filed under its own words, and a rule's pattern is compiled
 * the first time it is tried.
 */

const fs = require('fs');
const path = require('path');
const { getDomain } = require('tldts-experimental');

/** Electron's resource type names, as declarativeNetRequest spells them. */
const TYPE = {
  mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet', script: 'script', image: 'image',
  font: 'font', object: 'object', xhr: 'xmlhttprequest', ping: 'ping', cspReport: 'csp_report', media: 'media',
  webSocket: 'websocket', other: 'other'
};
const ACTION_ORDER = { allow: 5, allowAllRequests: 4, block: 3, upgradeScheme: 2, redirect: 1, modifyHeaders: 0 };

/** urlFilter as a regular expression: `||` a domain start, `|` an end, `*` anything, `^` a separator. */
function filterToRegExp(filter, caseSensitive) {
  let src = String(filter);
  let prefix = '';
  let suffix = '';
  if (src.startsWith('||')) { prefix = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?'; src = src.slice(2); }
  else if (src.startsWith('|')) { prefix = '^'; src = src.slice(1); }
  if (src.endsWith('|')) { suffix = '$'; src = src.slice(0, -1); }
  const body = src.split('').map((ch) => {
    if (ch === '*') return '.*';
    if (ch === '^') return '(?:[^A-Za-z0-9_\\-.%]|$)';
    return ch.replace(/[.+?${}()|[\]\\/]/g, '\\$&');
  }).join('');
  return new RegExp(prefix + body + suffix, caseSensitive ? '' : 'i');
}

/** The longest run of letters and digits in a filter, not touching a wildcard: its index key. */
function keyOf(filter) {
  if (!filter) return null;
  let best = null;
  // A word is whole only between separators: at an unanchored edge, or next
  // to a wildcard, the address may carry more letters on that side.
  const text = String(filter);
  const anchoredStart = text.startsWith('|');
  for (const m of text.toLowerCase().matchAll(/[a-z0-9%]{3,}/g)) {
    const before = text[m.index - 1];
    const after = text[m.index + m[0].length];
    const whole = (ch, edgeOk) => (ch === undefined ? edgeOk : !/[*a-z0-9%]/i.test(ch));
    if (!whole(before, anchoredStart && m.index <= 2) || !whole(after, text.endsWith('|'))) continue;
    if (!best || m[0].length > best.length) best = m[0];
  }
  return best;
}

const hostMatches = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

class RuleSet {
  constructor(rules) {
    this.byKey = new Map();
    this.loose = [];
    this.count = 0;
    for (const rule of rules || []) this.add(rule);
  }

  add(rule) {
    if (!rule || !rule.action || !rule.condition) return;
    const key = rule.condition.regexFilter ? null : keyOf(rule.condition.urlFilter);
    if (key) {
      if (!this.byKey.has(key)) this.byKey.set(key, []);
      this.byKey.get(key).push(rule);
    } else {
      this.loose.push(rule);
    }
    this.count += 1;
  }

  /** The rules worth testing against an address. */
  *candidates(words) {
    yield* this.loose;
    for (const w of words) {
      const list = this.byKey.get(w);
      if (list) yield* list;
    }
  }
}

/** Does one rule's condition hold for this request? */
function matches(rule, req) {
  const c = rule.condition;
  if (c.resourceTypes && !c.resourceTypes.includes(req.type)) return false;
  // With neither resourceTypes nor excludedResourceTypes, Chrome leaves the
  // main frame out; naming only the exclusions counts the main frame in.
  if (!c.resourceTypes && !c.excludedResourceTypes && req.type === 'main_frame' &&
      rule.action.type !== 'allowAllRequests') return false;
  if (c.excludedResourceTypes && c.excludedResourceTypes.includes(req.type)) return false;
  if (c.requestMethods && !c.requestMethods.includes(req.method)) return false;
  if (c.excludedRequestMethods && c.excludedRequestMethods.includes(req.method)) return false;
  if (c.requestDomains && !hostMatches(req.host, c.requestDomains)) return false;
  if (c.excludedRequestDomains && hostMatches(req.host, c.excludedRequestDomains)) return false;
  if (c.initiatorDomains && !(req.initiator && hostMatches(req.initiator, c.initiatorDomains))) return false;
  if (c.excludedInitiatorDomains && req.initiator && hostMatches(req.initiator, c.excludedInitiatorDomains)) return false;
  if (c.domainType) {
    const third = Boolean(req.initiator) && getDomain(req.host) !== getDomain(req.initiator);
    if ((c.domainType === 'thirdParty') !== third) return false;
  }
  if (c.regexFilter) {
    if (!rule.__re) {
      try { rule.__re = new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? '' : 'i'); } catch { rule.__re = /$^/; }
    }
    return rule.__re.test(req.url);
  }
  if (c.urlFilter) {
    if (!rule.__re) rule.__re = filterToRegExp(c.urlFilter, c.isUrlFilterCaseSensitive === true);
    return rule.__re.test(req.url);
  }
  return true;
}

/** Where a redirect goes, or null. */
function redirectTarget(rule, req, extensionOrigin) {
  const r = rule.action.redirect || {};
  if (r.url) return r.url;
  if (r.extensionPath) return `${extensionOrigin}${r.extensionPath.startsWith('/') ? '' : '/'}${r.extensionPath}`;
  if (r.regexSubstitution && rule.condition.regexFilter && rule.__re) {
    const m = rule.__re.exec(req.url);
    if (m) return r.regexSubstitution.replace(/\\(\d)/g, (_x, n) => m[Number(n)] || '');
  }
  if (r.transform) {
    try {
      const u = new URL(req.url);
      const t = r.transform;
      if (t.scheme) u.protocol = `${t.scheme}:`;
      if (t.host) u.hostname = t.host;
      if (t.port !== undefined) u.port = t.port;
      if (t.path !== undefined) u.pathname = t.path;
      if (t.query !== undefined) u.search = t.query;
      if (t.fragment !== undefined) u.hash = t.fragment;
      if (t.queryTransform) {
        for (const k of t.queryTransform.removeParams || []) u.searchParams.delete(k);
        for (const p of t.queryTransform.addOrReplaceParams || []) u.searchParams.set(p.key, p.value);
      }
      return u.href;
    } catch { return null; }
  }
  return null;
}

/**
 * One extension's rules: its static rulesets, dynamic and session rules, and
 * what it has switched on and off. Persisted in `debrowser-dnr.json` beside
 * the installed copy.
 */
class ExtensionRules {
  constructor(ext) {
    this.ext = ext;
    this.file = path.join(ext.dir, 'debrowser-dnr.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(ext.dir, 'manifest.json'), 'utf8')); } catch { /* none */ }
    this.resources = (manifest.declarative_net_request && manifest.declarative_net_request.rule_resources) || [];
    this.enabled = new Set(saved.enabled || this.resources.filter((r) => r.enabled).map((r) => r.id));
    this.disabledRules = saved.disabledRules || {};
    this.dynamic = saved.dynamic || [];
    this.session = [];
    this.staticSets = new Map();
    this.rebuild();
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ enabled: [...this.enabled], disabledRules: this.disabledRules, dynamic: this.dynamic }));
    } catch { /* read-only: kept for this run */ }
  }

  staticRules(id) {
    const res = this.resources.find((r) => r.id === id);
    if (!res) return [];
    try {
      const all = JSON.parse(fs.readFileSync(path.join(this.ext.dir, res.path.replace(/^\/+/, '')), 'utf8'));
      const off = new Set(this.disabledRules[id] || []);
      return Array.isArray(all) ? all.filter((r) => !off.has(r.id)) : [];
    } catch { return []; }
  }

  rebuild() {
    for (const id of [...this.staticSets.keys()]) if (!this.enabled.has(id)) this.staticSets.delete(id);
    for (const id of this.enabled) if (!this.staticSets.has(id)) this.staticSets.set(id, new RuleSet(this.staticRules(id)));
    this.dynamicSet = new RuleSet(this.dynamic);
    this.sessionSet = new RuleSet(this.session);
  }

  sets() {
    return [this.sessionSet, this.dynamicSet, ...this.staticSets.values()];
  }

  get size() {
    return this.sets().reduce((n, s) => n + s.count, 0);
  }

  /** The winning rule for a request, as Chrome picks it, or null. */
  decide(req, wanted) {
    let best = null;
    const rank = (r) => [r.priority || 1, ACTION_ORDER[r.action.type] || 0];
    for (const set of this.sets()) {
      for (const rule of set.candidates(req.words)) {
        if (!wanted.includes(rule.action.type) || !matches(rule, req)) continue;
        if (!best) { best = rule; continue; }
        const [p, a] = rank(rule);
        const [bp, ba] = rank(best);
        if (p > bp || (p === bp && a > ba)) best = rule;
      }
    }
    return best;
  }

  /** Every modifyHeaders rule that applies, highest priority first. */
  headerRules(req) {
    const out = [];
    for (const set of this.sets()) {
      for (const rule of set.candidates(req.words)) {
        if (rule.action.type === 'modifyHeaders' && matches(rule, req)) out.push(rule);
      }
    }
    return out.sort((a, b) => (b.priority || 1) - (a.priority || 1));
  }

  /* -- The API, as the extension calls it (through extension-compat.js). -- */

  updateDynamicRules({ removeRuleIds = [], addRules = [] } = {}) {
    const drop = new Set([...removeRuleIds, ...addRules.map((r) => r.id)]);
    this.dynamic = [...this.dynamic.filter((r) => !drop.has(r.id)), ...addRules];
    this.save();
    this.dynamicSet = new RuleSet(this.dynamic);
  }

  updateSessionRules({ removeRuleIds = [], addRules = [] } = {}) {
    const drop = new Set([...removeRuleIds, ...addRules.map((r) => r.id)]);
    this.session = [...this.session.filter((r) => !drop.has(r.id)), ...addRules];
    this.sessionSet = new RuleSet(this.session);
  }

  updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] } = {}) {
    for (const id of disableRulesetIds) this.enabled.delete(id);
    for (const id of enableRulesetIds) if (this.resources.some((r) => r.id === id)) this.enabled.add(id);
    this.save();
    this.rebuild();
  }

  updateStaticRules({ rulesetId, disableRuleIds = [], enableRuleIds = [] } = {}) {
    const off = new Set(this.disabledRules[rulesetId] || []);
    for (const id of disableRuleIds) off.add(id);
    for (const id of enableRuleIds) off.delete(id);
    this.disabledRules[rulesetId] = [...off];
    this.save();
    this.staticSets.delete(rulesetId);
    this.rebuild();
  }

  getDisabledRuleIds({ rulesetId } = {}) {
    return this.disabledRules[rulesetId] || [];
  }

  getRules(list, filter) {
    const ids = filter && Array.isArray(filter.ruleIds) ? new Set(filter.ruleIds) : null;
    return list.filter((r) => !ids || ids.has(r.id)).map(({ __re, ...r }) => r);
  }
}

/**
 * Every extension's rules, as one judge on a session's request hooks.
 */
class DeclarativeNetRequest {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.byExt = new Map();
    this.origins = new Map();
    this.hooked = new WeakSet();
    this.allowances = new Map();
    this.matched = 0;
  }

  /** An extension's rules, read when it first loads. */
  forExtension(ext) {
    if (!this.byExt.has(ext.id)) this.byExt.set(ext.id, new ExtensionRules(ext));
    return this.byExt.get(ext.id);
  }

  setOrigin(extId, origin) { this.origins.set(extId, origin); }

  drop(extId) { this.byExt.delete(extId); this.origins.delete(extId); this.allowances.clear(); }

  /** The request as the rules see it. */
  static describe(details) {
    let host = '';
    let initiator = '';
    try { host = new URL(details.url).hostname; } catch { /* not a URL */ }
    try {
      const from = details.frame?.url || (details.webContents && !details.webContents.isDestroyed()
        ? details.webContents.getURL() : '') || details.referrer || '';
      initiator = from ? new URL(from).hostname : '';
    } catch { /* none */ }
    const lower = details.url.toLowerCase();
    return {
      url: details.url, host, initiator, method: String(details.method || 'GET').toLowerCase(),
      type: TYPE[details.resourceType] || 'other', words: new Set(lower.match(/[a-z0-9%]{3,}/g) || [])
    };
  }

  /** What one request should do, across every extension, or undefined. */
  judge(details) {
    if (!this.byExt.size) return undefined;
    const req = DeclarativeNetRequest.describe(details);
    for (const [id, rules] of this.byExt) {
      const rule = rules.decide(req, ['allow', 'allowAllRequests', 'block', 'upgradeScheme', 'redirect']);
      if (!rule) continue;
      const type = rule.action.type;
      if (type === 'allow' || type === 'allowAllRequests') continue;
      // allowAllRequests on a page covers everything that page then loads,
      // unless a rule of higher priority says otherwise. It matched only the
      // navigation, so uBlock Origin Lite's "no filtering on this site" let
      // the page through and went on blocking its every image and script.
      const pageAllow = this.pageAllowance(id, rules, details, req);
      if (pageAllow && (pageAllow.priority || 1) >= (rule.priority || 1)) continue;
      this.matched += 1;
      if (type === 'block') return { cancel: true };
      if (type === 'upgradeScheme' && /^(http|ws):/.test(req.url)) {
        return { redirectURL: req.url.replace(/^http:/, 'https:').replace(/^ws:/, 'wss:') };
      }
      if (type === 'redirect') {
        const to = redirectTarget(rule, req, this.origins.get(id) || '');
        if (to && to !== req.url) return { redirectURL: to };
      }
    }
    return undefined;
  }

  /**
   * The allowAllRequests rule, if any, that the document making this request
   * was loaded under. Remembered for a moment per document, so a page loading
   * two hundred things asks once rather than two hundred times.
   */
  pageAllowance(id, rules, details, req) {
    if (req.type === 'main_frame') return null;
    const frame = details.frame;
    let doc = '';
    let top = true;
    try {
      doc = frame?.url || '';
      top = !frame?.parent;
    } catch { /* a frame already gone */ }
    if (!doc && details.webContents && !details.webContents.isDestroyed()) doc = details.webContents.getURL();
    if (!/^https?:/i.test(doc)) return null;
    const key = `${id}\n${top ? 'm' : 's'}\n${doc}`;
    const now = Date.now();
    const hit = this.allowances.get(key);
    if (hit && now - hit.at < 2000) return hit.rule;
    const docReq = DeclarativeNetRequest.describe({ url: doc, resourceType: top ? 'mainFrame' : 'subFrame', method: 'GET' });
    const rule = rules.decide(docReq, ['allowAllRequests']);
    if (this.allowances.size > 512) this.allowances.clear();
    this.allowances.set(key, { at: now, rule });
    return rule;
  }

  /** modifyHeaders on one list of headers: `request` or `response`. */
  editHeaders(details, which, headers) {
    if (!this.byExt.size) return null;
    const req = DeclarativeNetRequest.describe(details);
    let out = null;
    for (const rules of this.byExt.values()) {
      for (const rule of rules.headerRules(req)) {
        const ops = rule.action[which === 'request' ? 'requestHeaders' : 'responseHeaders'] || [];
        for (const op of ops) {
          out = out || { ...headers };
          const name = Object.keys(out).find((k) => k.toLowerCase() === String(op.header).toLowerCase()) || op.header;
          if (op.operation === 'remove') delete out[name];
          else if (op.operation === 'set') out[name] = which === 'response' ? [op.value] : op.value;
          else if (op.operation === 'append') {
            const had = out[name];
            if (which === 'response') out[name] = [...(Array.isArray(had) ? had : had ? [had] : []), op.value];
            else out[name] = had ? `${had}, ${op.value}` : op.value;
          }
        }
      }
    }
    return out;
  }

  /** On a session's hooks, once. */
  attach(hooks) {
    if (this.hooked.has(hooks)) return;
    this.hooked.add(hooks);
    hooks.onBeforeRequest((details) => this.judge(details));
    hooks.onBeforeSendHeaders((details) => {
      const edited = this.editHeaders(details, 'request', details.requestHeaders || {});
      return edited ? { requestHeaders: edited } : undefined;
    });
    hooks.onHeadersReceived((details) => {
      const edited = this.editHeaders(details, 'response', details.responseHeaders || {});
      return edited ? { responseHeaders: edited } : undefined;
    });
  }
}

module.exports = { DeclarativeNetRequest, ExtensionRules, filterToRegExp, keyOf, matches };
