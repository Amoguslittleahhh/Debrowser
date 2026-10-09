'use strict';

/**
 * Extensions, as a Lab: Chrome's and Firefox's.
 *
 * Electron loads an unpacked Chrome extension into a session and runs part of
 * the extension API: content scripts, background pages and service workers,
 * storage, messaging, scripting, and much of `chrome.tabs`. What it lacks,
 * Debrowser adds:
 *
 *  - A toolbar button and popups (main.js `open-extension-popup`): Electron
 *    draws neither, so the puzzle button lists the extensions and opens a
 *    popup in a small window of its own, under the button.
 *  - Installing from the Chrome Web Store, Edge Add-ons and Firefox Add-ons:
 *    a store page's address is enough (`storeTarget`, `downloadFromStore`).
 *  - The API Electron does not have, and Firefox's spelling of all of it:
 *    extension-compat.js, put in front of the extension's own code everywhere
 *    it runs. Firefox's MV3 background scripts, which Chrome has no place
 *    for, run as a service worker that loads them.
 *
 *  - A bridge back to the browser (`bridge`, `dispatch`): right-click items
 *    shown in Debrowser's menu, request rules run by extension-dnr.js,
 *    notifications, and tabs opened and closed from anywhere, the background
 *    included; events come back through a relay page of the extension's own.
 *
 *  - webRequest: the extension's own code on the request path. A listener's
 *    filter is matched here, and a blocking one in a background Debrowser
 *    hosts is asked and waited for (`requestEvent`); tabs and webNavigation
 *    events come from the browser's tabs (main.js `bindExtensionEvents`).
 *  - Alarms kept by the browser and saved, delivered as messages, which
 *    start a worker that had gone to sleep.
 *
 * Installed copies live unpacked under `<userData>/extensions/<id>/`, and are
 * loaded into every ordinary browsing session at start (and when one is
 * added). Never into a private window, which loads nothing it did not ship
 * with: an extension sees every page it runs on.
 *
 * Accepted: a folder with a manifest.json, a `.crx` (Chrome's packed format:
 * a header, then a zip), and a `.xpi` or `.zip` (a zip).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { DeclarativeNetRequest } = require('./extension-dnr');

/**
 * The compatibility layer (extension-compat.js), put in front of the
 * extension's own code everywhere it runs, and the file that tells a popup
 * which tab it was opened over (written as each popup opens).
 */
// Not starting with "_": Chromium reserves those names inside an extension
// and refuses to load one that has them.
const COMPAT_FILE = 'debrowser-compat.js';
const CONTEXT_FILE = 'debrowser-context.js';
const WORKER_FILE = 'debrowser-worker.js';
const BACKGROUND_FILE = 'debrowser-background.html';
const COMPAT_SOURCE = () => fs.readFileSync(path.join(__dirname, 'extension-compat.js'), 'utf8');
const RELAY_FILE = 'debrowser-relay.html';
/**
 * What the extension's own code is told: which tab is in front (for a popup)
 * and the token its calls to Debrowser carry (extension-compat.js, the
 * bridge). Only the extension's pages and worker load it; content scripts,
 * which run beside web pages, never see the token.
 */
const contextSource = (tabId, token) => `globalThis.__debrowserActiveTab = ${Number.isInteger(tabId) ? tabId : 'null'};\n` +
  `globalThis.__debrowserExt = ${JSON.stringify({ token: token || null })};\n`;
/** Recorded beside each copy: where it came from, so the list can say so. */
const META_FILE = 'debrowser-meta.json';

/* ---- Unpacking ------------------------------------------------------------ */

/**
 * The files in a zip, read from its central directory. Stored and deflated
 * entries, which is everything a browser extension is packed with. Paths that
 * would leave the folder (`..`, absolute) are refused, not skipped: an archive
 * that tries it is not one to half-install.
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, data: Buffer}>}
 */
function readZip(buf) {
  // The end-of-central-directory record, searched for from the end: a comment
  // of up to 64KB may follow it.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged zip archive');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const normal = path.posix.normalize(name.replace(/\\/g, '/'));
    if (normal.startsWith('../') || normal === '..' || path.posix.isAbsolute(normal) || /^[a-z]:/i.test(normal)) {
      throw new Error(`unsafe path in archive: ${name}`);
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported compression in ${name}`);
    files.push({ name: normal, data });
  }
  return files;
}

/** The zip inside a `.crx`: version 2 and 3 headers both name their own length. */
function crxZip(buf) {
  if (buf.toString('latin1', 0, 4) !== 'Cr24') return buf;
  const version = buf.readUInt32LE(4);
  if (version === 3) return buf.subarray(12 + buf.readUInt32LE(8));
  if (version === 2) return buf.subarray(16 + buf.readUInt32LE(8) + buf.readUInt32LE(12));
  throw new Error(`unknown .crx version ${version}`);
}

/**
 * Where a manifest sits in the files: at the top, or one folder down - a
 * zipped folder rather than its contents is the most common way people pack
 * one by hand.
 */
function rootOf(files) {
  if (files.some((f) => f.name === 'manifest.json')) return '';
  const nested = files.find((f) => /^[^/]+\/manifest\.json$/.test(f.name));
  if (nested) return nested.name.slice(0, -'manifest.json'.length);
  throw new Error('no manifest.json in it');
}

/* ---- Manifests ------------------------------------------------------------ */

/** Firefox's, if it says Gecko anywhere Firefox puts that. */
function isFirefox(manifest) {
  return Boolean(manifest.browser_specific_settings?.gecko || manifest.applications?.gecko);
}

/**
 * A manifest made loadable here, Chrome's or Firefox's.
 *
 *  - A service worker starts through a small worker that loads the
 *    compatibility layer first - by importScripts, or by import for a module.
 *  - A background page, or background scripts - Manifest V2's, and Firefox's
 *    in V3 - are hosted by Debrowser itself (`hostBackground`): the Chromium
 *    in this Electron loads a V2 extension's content scripts but no longer
 *    runs its background, and Firefox's background scripts expect a page,
 *    with a DOM, that a service worker is not. So the manifest loses its
 *    background, and a page that loads the same scripts is opened for it,
 *    off screen, with the whole extension API.
 *  - The layer goes in front of every content script; Gecko-only keys go.
 *
 * @returns {{ manifest: object, worker: string|null, background: string|null,
 *   backgroundHtml: string|null }} the manifest; the worker's source when one is
 *   needed; the page to host, and its source when Debrowser writes it
 */
function adaptManifest(manifest) {
  const out = JSON.parse(JSON.stringify(manifest));
  let worker = null;
  let background = null;
  let backgroundHtml = null;
  const bg = out.background || null;
  const quote = (f) => JSON.stringify(`/${String(f).replace(/^\/+/, '')}`);
  if (bg && bg.service_worker) {
    // A module worker cannot importScripts; it imports instead, the layer first.
    worker = bg.type === 'module'
      ? `import ${quote(CONTEXT_FILE)};\nimport ${quote(COMPAT_FILE)};\nimport ${quote(bg.service_worker)};\n`
      : `importScripts(${[CONTEXT_FILE, COMPAT_FILE, bg.service_worker].map(quote).join(', ')});\n`;
    out.background = { ...bg, service_worker: WORKER_FILE };
  } else if (bg && bg.page) {
    background = String(bg.page).replace(/^\/+/, '');
    delete out.background;
  } else if (bg && Array.isArray(bg.scripts)) {
    const type = bg.type === 'module' ? ' type="module"' : '';
    background = BACKGROUND_FILE;
    backgroundHtml = `<!doctype html><html><head><meta charset="utf-8">${
      bg.scripts.map((f) => `<script${type} src=${quote(f)}></script>`).join('')}</head><body></body></html>\n`;
    delete out.background;
  }
  if (Array.isArray(out.content_scripts)) {
    for (const cs of out.content_scripts) if (Array.isArray(cs.js)) cs.js = [COMPAT_FILE, ...cs.js];
  }
  delete out.browser_specific_settings;
  delete out.applications;
  return { manifest: out, worker, background, backgroundHtml };
}

/** An extension page with the context and the layer loaded before anything else on it. */
function adaptPage(html) {
  const tags = `<script src="/${CONTEXT_FILE}"></script><script src="/${COMPAT_FILE}"></script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tags}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}${tags}`);
  return tags + html;
}

/** The popup page an extension's toolbar button opens, if it has one. */
function popupOf(manifest) {
  const action = manifest.action || manifest.browser_action || manifest.page_action || null;
  return action && action.default_popup ? String(action.default_popup).replace(/^\/+/, '') : null;
}

/* ---- Stores ----------------------------------------------------------------- */

/**
 * Which store page an address is, and the extension on it: the Chrome Web
 * Store (old and new addresses), Microsoft Edge Add-ons, or Firefox Add-ons.
 *
 * @returns {{store: 'chrome'|'edge'|'firefox', id: string}|null}
 */
function storeTarget(address) {
  let u;
  try { u = new URL(String(address || '').trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const cwsId = parts.find((p) => /^[a-p]{32}$/.test(p));
  if ((host === 'chromewebstore.google.com' || (host === 'chrome.google.com' && parts[0] === 'webstore')) && cwsId) {
    return { store: 'chrome', id: cwsId };
  }
  if (host === 'microsoftedge.microsoft.com' && parts[0] === 'addons' && cwsId) return { store: 'edge', id: cwsId };
  if (host === 'addons.mozilla.org') {
    const at = parts.indexOf('addon');
    if (at >= 0 && parts[at + 1]) return { store: 'firefox', id: decodeURIComponent(parts[at + 1]) };
  }
  return null;
}

/**
 * Fetch the package a store page offers, into a file.
 *
 * @param {{store: string, id: string}} target
 * @param {(url: string) => Promise<Response>} fetchFn - the browsing session's, so proxies apply
 * @param {string} dir - where to put it
 * @param {string} chromeVersion - the store serves what this version can run
 * @returns {Promise<string>} the file
 */
async function downloadFromStore(target, fetchFn, dir, chromeVersion) {
  let url;
  let ext = 'crx';
  if (target.store === 'chrome') {
    url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${encodeURIComponent(chromeVersion)}` +
      `&acceptformat=crx2,crx3&x=id%3D${target.id}%26uc`;
  } else if (target.store === 'edge') {
    url = `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&prodversion=${encodeURIComponent(chromeVersion)}` +
      `&x=id%3D${target.id}%26installsource%3Dondemand%26uc`;
  } else {
    const info = await fetchFn(`https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(target.id)}/`);
    if (!info.ok) throw new Error(`Firefox Add-ons answered ${info.status}`);
    const json = await info.json();
    url = json?.current_version?.file?.url;
    if (!url) throw new Error('Firefox Add-ons has no file for it');
    ext = 'xpi';
  }
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`the store answered ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error('the store sent nothing to install');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${target.store}-${target.id.replace(/[^\w.-]/g, '_')}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

/** "__MSG_name__" names, read from the default locale, as the browser shows them. */
function displayName(dir, manifest) {
  const raw = String(manifest.name || '');
  const m = /^__MSG_(.+)__$/.exec(raw);
  if (!m) return raw || 'Extension';
  try {
    const locale = manifest.default_locale || 'en';
    const messages = JSON.parse(fs.readFileSync(path.join(dir, '_locales', locale, 'messages.json'), 'utf8'));
    const hit = Object.entries(messages).find(([k]) => k.toLowerCase() === m[1].toLowerCase());
    return hit ? hit[1].message : raw;
  } catch {
    return raw;
  }
}

/* ---- The store ------------------------------------------------------------ */

class Extensions {
  /**
   * @param {string} root - `<userData>/extensions`
   * @param {(msg: string) => void} [log]
   */
  /**
   * @param {string} root - `<userData>/extensions`
   * @param {(msg: string) => void} [log]
   * @param {object} [hooks] - what the bridge asks of the browser:
   *   openTab(url, active) -> {id, url}, closeTabs(ids), notify({title, message, iconPath}, onClick),
   *   menusChanged()
   */
  constructor(root, log = () => {}, hooks = {}) {
    this.root = root;
    this.log = log;
    this.hooks = hooks;
    this.sessions = new Set();
    // Each extension's right-click menu items, as it declared them.
    this.menus = new Map();
    this.dnr = new DeclarativeNetRequest({ log });
    // Each extension's webRequest listeners: id -> { event, filter, blocking }.
    this.listeners = new Map();
    // The browser events each extension listens to (tabs.*, webNavigation.*).
    this.subscriptions = new Map();
    // Alarms, kept by the browser so they can wake a sleeping worker.
    this.alarmTimers = new Map();
  }

  /* -- The bridge: calls from an extension's own code (extension-compat.js). -- */

  /**
   * One call, from an extension known by its token. The answer is what the
   * extension's promise resolves to.
   */
  async bridge(token, op, args) {
    const ext = token && this.list().find((e) => e.token === token);
    if (!ext) throw new Error('unknown extension');
    const a = args || {};
    const menus = () => {
      if (!this.menus.has(ext.id)) this.menus.set(ext.id, new Map());
      return this.menus.get(ext.id);
    };
    const changed = () => { if (this.hooks.menusChanged) this.hooks.menusChanged(); };
    const rules = () => this.dnr.forExtension(ext);
    switch (op) {
      case 'menus.create': {
        const id = String(a.id ?? `${ext.id}-${menus().size + 1}`);
        menus().set(id, { ...a, id });
        changed();
        return id;
      }
      case 'menus.update': {
        const had = menus().get(String(a.id));
        if (had) menus().set(String(a.id), { ...had, ...(a.props || {}) });
        changed();
        return undefined;
      }
      case 'menus.remove': menus().delete(String(a.id)); changed(); return undefined;
      case 'menus.removeAll': menus().clear(); changed(); return undefined;
      case 'tabs.create': {
        if (!this.hooks.openTab) throw new Error('tabs can’t be opened from here');
        return this.hooks.openTab(String(a.url || 'about:blank'), a.active !== false);
      }
      case 'tabs.remove': {
        if (this.hooks.closeTabs) this.hooks.closeTabs([].concat(a.ids || []));
        return undefined;
      }
      case 'notifications.create': {
        const id = String(a.id || `${ext.id}-n${Date.now()}`);
        if (this.hooks.notify) {
          const icon = a.options && a.options.iconUrl && !/^[a-z]+:/i.test(a.options.iconUrl)
            ? path.join(ext.dir, String(a.options.iconUrl).replace(/^\/+/, '')) : null;
          this.hooks.notify({ title: a.options?.title || ext.name, message: a.options?.message || '', iconPath: icon },
            () => this.dispatch(ext.id, 'notifications.onClicked', [id]));
        }
        return id;
      }
      case 'runtime.reload': {
        // After answering: the caller is the page about to be replaced.
        setTimeout(() => {
          this.unloadEverywhere(ext.id);
          this.loadEverywhere(ext.id).catch((e) => this.log(`extensions: ${ext.name} did not restart: ${e.message}`));
        }, 50).unref?.();
        return undefined;
      }
      case 'action.badge': {
        (this.badges ||= new Map()).set(ext.id, String(a.text || '').slice(0, 6));
        return undefined;
      }
      case 'webRequest.listen': {
        if (!this.listeners.has(ext.id)) this.listeners.set(ext.id, new Map());
        this.listeners.get(ext.id).set(String(a.id), { event: String(a.event), filter: a.filter || {}, blocking: a.blocking === true,
          extra: Array.isArray(a.extra) ? a.extra : [] });
        return undefined;
      }
      case 'webRequest.unlisten': this.listeners.get(ext.id)?.delete(String(a.id)); return undefined;
      case 'events.listen': {
        if (!this.subscriptions.has(ext.id)) this.subscriptions.set(ext.id, new Set());
        this.subscriptions.get(ext.id).add(String(a.name));
        return undefined;
      }
      case 'alarms.create': return this.alarmCreate(ext, a);
      case 'alarms.get': return this.alarmList(ext).find((x) => x.name === String(a.name || '')) || null;
      case 'alarms.getAll': return this.alarmList(ext);
      case 'alarms.clear': return this.alarmClear(ext, a.name === undefined ? null : String(a.name || ''));
      case 'dnr.updateDynamicRules': rules().updateDynamicRules(a); return undefined;
      case 'dnr.getDynamicRules': return rules().getRules(rules().dynamic, a);
      case 'dnr.updateSessionRules': rules().updateSessionRules(a); return undefined;
      case 'dnr.getSessionRules': return rules().getRules(rules().session, a);
      case 'dnr.updateEnabledRulesets': rules().updateEnabledRulesets(a); return undefined;
      case 'dnr.getEnabledRulesets': return [...rules().enabled];
      case 'dnr.updateStaticRules': rules().updateStaticRules(a); return undefined;
      case 'dnr.getDisabledRuleIds': return rules().getDisabledRuleIds(a);
      case 'dnr.getAvailableStaticRuleCount': return Math.max(0, 330000 - rules().size);
      default: throw new Error(`${op} isn’t available in Debrowser yet`);
    }
  }

  /**
   * An event for an extension - a menu item clicked, a notification clicked -
   * delivered to its background and pages as a runtime message from a small
   * off-screen page of its own (`debrowser-relay.html`), which the layer turns
   * back into the event. The relay goes after a minute of nothing to say.
   */
  dispatch(extId, eventName, args) {
    const ext = this.list().find((e) => e.id === extId);
    if (!ext) return;
    for (const ses of this.sessions) {
      const loaded = this.loadedId(ses, extId);
      if (!loaded) continue;
      const message = JSON.stringify({ __debrowserEvent: eventName, args: args || [] });
      // A background Debrowser hosts hears it directly; a worker through the relay.
      const host = ses.__debrowserBg?.get(extId);
      if (host && !host.webContents.isDestroyed()) {
        host.webContents.executeJavaScript(`globalThis.__debrowserFire && globalThis.__debrowserFire(${message});`).catch(() => {});
        continue;
      }
      const relay = this.ensureRelay(ses, ext, loaded);
      relay.ready.then(() => {
        if (relay.view.webContents.isDestroyed()) return;
        relay.view.webContents.executeJavaScript(
          `chrome.runtime.sendMessage(${message}).catch(() => {}); globalThis.__debrowserFire && globalThis.__debrowserFire(${message});`)
          .catch(() => {});
      });
    }
  }

  /* -- Alarms: the browser's, saved beside the extension, so one set for an
     hour from now goes off then even if the worker that set it has long
     stopped - delivered as a message, which starts it again. -- */

  alarmFile(ext) { return path.join(ext.dir, 'debrowser-alarms.json'); }

  alarmList(ext) {
    try { return JSON.parse(fs.readFileSync(this.alarmFile(ext), 'utf8')); } catch { return []; }
  }

  alarmSave(ext, list) {
    try { fs.writeFileSync(this.alarmFile(ext), JSON.stringify(list)); } catch { /* kept in memory only */ }
    this.alarmSchedule(ext, list);
  }

  alarmCreate(ext, a) {
    const name = String(a.name || '');
    const info = a.info || {};
    const minutes = (m) => Math.max(0.5 / 60, Number(m) || 0) * 60000;  // at least 0.5s apart
    const when = Number(info.when) || Date.now() + (info.delayInMinutes !== undefined ? minutes(info.delayInMinutes)
      : info.periodInMinutes !== undefined ? minutes(info.periodInMinutes) : 0);
    const list = this.alarmList(ext).filter((x) => x.name !== name);
    list.push({ name, scheduledTime: when, ...(info.periodInMinutes ? { periodInMinutes: Number(info.periodInMinutes) } : {}) });
    this.alarmSave(ext, list);
    return undefined;
  }

  alarmClear(ext, name) {
    const list = this.alarmList(ext);
    const keep = name === null ? [] : list.filter((x) => x.name !== name);
    this.alarmSave(ext, keep);
    return keep.length !== list.length;
  }

  /** The next alarm due for an extension, on one timer. */
  alarmSchedule(ext, list = this.alarmList(ext)) {
    clearTimeout(this.alarmTimers.get(ext.id));
    if (!list.length) return;
    const next = list.reduce((a, b) => (a.scheduledTime <= b.scheduledTime ? a : b));
    const timer = setTimeout(() => {
      const now = Date.now();
      const due = this.alarmList(ext).filter((x) => x.scheduledTime <= now + 50);
      for (const alarm of due) this.dispatch(ext.id, 'alarms.onAlarm', [alarm]);
      const rest = this.alarmList(ext)
        .map((x) => (x.scheduledTime <= now + 50 && x.periodInMinutes
          ? { ...x, scheduledTime: now + x.periodInMinutes * 60000 } : x))
        .filter((x) => x.scheduledTime > now + 50);
      this.alarmSave(ext, rest);
    }, Math.max(0, Math.min(next.scheduledTime - Date.now(), 2 ** 31 - 1)));
    timer.unref?.();
    this.alarmTimers.set(ext.id, timer);
  }

  /* -- Browser events: tabs and navigation, to the extensions listening. -- */

  /** An event every extension listening to it should hear. */
  broadcast(name, args) {
    // A background Debrowser hosts hears every one - its listeners pick - so
    // there is no window between it starting and it saying what it wants. A
    // worker only what it asked for: each message would start it.
    const to = new Set();
    for (const [extId, names] of this.subscriptions) if (names.has(name)) to.add(extId);
    for (const ses of this.sessions) for (const extId of (ses.__debrowserBg || new Map()).keys()) to.add(extId);
    for (const extId of to) this.dispatch(extId, name, args);
  }

  /** Whether any extension would hear browser events: one hosting a background, or one that asked. */
  get listening() {
    if (this.subscriptions.size) return true;
    for (const ses of this.sessions) if (ses.__debrowserBg && ses.__debrowserBg.size) return true;
    return false;
  }

  /* -- webRequest: an extension's own code on the request path. -- */

  /**
   * Chrome's description of a request, from Electron's - what a webRequest
   * listener is handed. Tab ids are the tab's page id, as everywhere else the
   * extension API is answered.
   */
  static requestDetails(d) {
    const type = { mainFrame: 'main_frame', subFrame: 'sub_frame', xhr: 'xmlhttprequest', cspReport: 'csp_report',
      webSocket: 'websocket' }[d.resourceType] || d.resourceType || 'other';
    let initiator;
    try { if (d.referrer) initiator = new URL(d.referrer).origin; } catch { /* none */ }
    const out = {
      requestId: String(d.id), url: d.url, method: d.method, type, timeStamp: d.timestamp || Date.now(),
      tabId: d.webContentsId || -1, frameId: d.resourceType === 'mainFrame' ? 0 : (d.frame && d.frame.routingId) || 0,
      parentFrameId: d.resourceType === 'mainFrame' ? -1 : 0, initiator,
      // Firefox's names for the same, which its extensions read.
      originUrl: d.referrer || undefined, documentUrl: d.resourceType === 'mainFrame' ? undefined : d.referrer || undefined
    };
    if (d.statusCode) Object.assign(out, { statusCode: d.statusCode, statusLine: d.statusLine, fromCache: Boolean(d.fromCache), ip: d.ip });
    if (d.error) out.error = d.error;
    if (d.redirectURL) out.redirectUrl = d.redirectURL;
    const asList = (h) => Object.entries(h || {}).flatMap(([name, v]) => [].concat(v).map((value) => ({ name, value: String(value) })));
    if (d.requestHeaders) out.requestHeaders = asList(d.requestHeaders);
    if (d.responseHeaders) out.responseHeaders = asList(d.responseHeaders);
    return out;
  }

  /** Does a listener's filter take this request? Match patterns and types. */
  static filterTakes(filter, details) {
    if (Array.isArray(filter.types) && filter.types.length && !filter.types.includes(details.type)) return false;
    if (Number.isInteger(filter.tabId) && filter.tabId !== details.tabId) return false;
    const urls = Array.isArray(filter.urls) ? filter.urls : ['<all_urls>'];
    return urls.some((p) => {
      if (p === '<all_urls>' || p === '*://*/*') return /^(https?|wss?):/.test(details.url);
      const m = /^(\*|https?|wss?|ftp|file):\/\/(\*|\*\.[^/]+|[^/*]+)(\/.*)$/.exec(p);
      if (!m) return false;
      let u;
      try { u = new URL(details.url); } catch { return false; }
      const scheme = u.protocol.slice(0, -1);
      if (m[1] === '*' ? !/^(https?|wss?)$/.test(scheme) : m[1] !== scheme) return false;
      if (m[2] !== '*') {
        if (m[2].startsWith('*.')) { const base = m[2].slice(2); if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false; }
        else if (u.hostname !== m[2]) return false;
      }
      const pathRe = new RegExp(`^${m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return pathRe.test(u.pathname + u.search);
    });
  }

  /**
   * Hand one request event to every extension listening. Blocking listeners
   * in a background Debrowser hosts are asked and waited for - up to a second,
   * so a stuck extension slows a page rather than stopping it; everything else
   * is told, without waiting. Returns the combined answer: cancel, a redirect,
   * or changed headers.
   */
  requestEvent(event, electronDetails) {
    if (!this.listeners.size) return undefined;
    let details = null;
    const answers = [];
    for (const [extId, list] of this.listeners) {
      const ids = [];
      let blocking = false;
      for (const [id, l] of list) {
        if (l.event !== event) continue;
        details = details || Extensions.requestDetails(electronDetails);
        if (!Extensions.filterTakes(l.filter, details)) continue;
        ids.push(id);
        if (l.blocking) blocking = true;
      }
      if (!ids.length) continue;
      const host = [...this.sessions].map((ses) => ses.__debrowserBg?.get(extId)).find((v) => v && !v.webContents.isDestroyed());
      const script = `globalThis.__debrowserWebRequest && globalThis.__debrowserWebRequest(${JSON.stringify(event)}, ${JSON.stringify(details)}, ${JSON.stringify(ids)})`;
      if (host) {
        const asked = host.webContents.executeJavaScript(script, true).catch(() => null);
        if (blocking) {
          answers.push(Promise.race([asked, new Promise((r) => { const t = setTimeout(() => r(null), 1000); t.unref?.(); })]));
        }
      } else {
        // A worker: told through the relay, never waited for (Chrome's MV3
        // workers cannot block either).
        this.dispatch(extId, 'webRequest.event', [event, details, ids]);
      }
    }
    // Synchronous when nothing has to be waited for, which is nearly always.
    if (!answers.length) return undefined;
    return Promise.all(answers).then((all) => Extensions.combine(event, all.filter(Boolean)));
  }

  /** Several listeners' answers as one, as Chrome combines them. */
  static combine(event, results) {
    const out = {};
    for (const r of results) {
      if (r.cancel) return { cancel: true };
      if (r.redirectUrl && !out.redirectURL) out.redirectURL = r.redirectUrl;
      const toMap = (list) => {
        const m = {};
        for (const h of list || []) m[h.name] = event === 'onHeadersReceived' ? [...(m[h.name] || []), h.value] : h.value;
        return m;
      };
      if (r.requestHeaders) out.requestHeaders = toMap(r.requestHeaders);
      if (r.responseHeaders) out.responseHeaders = toMap(r.responseHeaders);
    }
    return Object.keys(out).length ? out : undefined;
  }

  /** On a session's request hooks, once: the blocking events and the watched ones. */
  attachRequests(hooks) {
    if ((this.hookedRequests ||= new WeakSet()).has(hooks)) return;
    this.hookedRequests.add(hooks);
    const quick = (event) => (details) => (this.listeners.size ? this.requestEvent(event, details) : undefined);
    hooks.onBeforeRequest(quick('onBeforeRequest'));
    hooks.onBeforeSendHeaders(quick('onBeforeSendHeaders'));
    hooks.onHeadersReceived(quick('onHeadersReceived'));
    for (const event of ['onSendHeaders', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']) {
      hooks.observe(event, (details) => { if (this.listeners.size) this.requestEvent(event, details); });
    }
  }

  /**
   * The relay page for an extension in a session. Kept while the extension
   * has a service worker - it carries the worker's calls to the browser -
   * and otherwise closed after a minute with nothing to say.
   */
  ensureRelay(ses, ext, loaded) {
    const relays = (ses.__debrowserRelay ||= new Map());
    let relay = relays.get(ext.id);
    if (!relay || relay.view.webContents.isDestroyed()) {
      const { WebContentsView } = require('electron');
      const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
      relay = { view, ready: view.webContents.loadURL(`chrome-extension://${loaded}/${RELAY_FILE}`).catch(() => {}) };
      relays.set(ext.id, relay);
    }
    clearTimeout(relay.timer);
    if (!ext.worker) {
      relay.timer = setTimeout(() => {
        try { relay.view.webContents.close(); } catch { /* gone */ }
        relays.delete(ext.id);
      }, 60_000);
      relay.timer.unref?.();
    }
    return relay;
  }

  /**
   * The menu items to show for a right-click: each extension's whose contexts
   * fit what was clicked, with the selection put in where the title asks.
   *
   * @param {{selectionText?: string, linkURL?: string, srcURL?: string, mediaType?: string, isEditable?: boolean}} params
   */
  menuItemsFor(params, pageUrl) {
    const kinds = new Set(['all']);
    if (params.selectionText) kinds.add('selection');
    if (params.linkURL) kinds.add('link');
    if (params.isEditable) kinds.add('editable');
    if (params.srcURL && params.mediaType === 'image') kinds.add('image');
    if (params.srcURL && params.mediaType === 'video') kinds.add('video');
    if (params.srcURL && params.mediaType === 'audio') kinds.add('audio');
    // "page" only when nothing more particular is under the pointer, as in Chrome.
    if (kinds.size === 1) kinds.add('page');
    const out = [];
    const pattern = (p) => new RegExp(`^${String(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    for (const ext of this.list()) {
      for (const item of (this.menus.get(ext.id) || new Map()).values()) {
        if (item.visible === false || item.type === 'separator' || item.parentId !== undefined) continue;
        const contexts = item.contexts || ['page'];
        if (!contexts.some((c) => kinds.has(c))) continue;
        if (Array.isArray(item.documentUrlPatterns) && !item.documentUrlPatterns.some((p) => pattern(p).test(pageUrl))) continue;
        const sel = String(params.selectionText || '').slice(0, 40);
        out.push({ extId: ext.id, menuId: item.id, enabled: item.enabled !== false,
          label: String(item.title || ext.name).replace(/%s/g, sel) });
      }
    }
    return out;
  }

  /** The installed copies, newest first, as Settings lists them. Read once, until one changes. */
  list() {
    if (this.cached) return this.cached.slice();
    let names = [];
    try { names = fs.readdirSync(this.root); } catch { return []; }
    const out = [];
    for (const id of names) {
      const dir = path.join(this.root, id);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')); } catch { /* none */ }
        out.push({
          id, dir, name: displayName(dir, manifest), version: String(manifest.version || ''),
          from: meta.from || 'chrome', addedAt: meta.addedAt || 0, manifestVersion: manifest.manifest_version || 2,
          popup: popupOf(manifest), background: meta.background || null, token: meta.token || null,
          rules: Boolean(manifest.declarative_net_request),
          worker: Boolean(manifest.background && manifest.background.service_worker)
        });
      } catch { /* a half-written folder: not listed, not loaded */ }
    }
    this.cached = out.sort((a, b) => b.addedAt - a.addedAt);
    return this.cached.slice();
  }

  /**
   * Install from a folder, a .crx, or a .xpi/.zip. Returns the listed entry.
   *
   * @param {string} source
   */
  install(source) {
    let files;
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      files = [];
      const walk = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), r);
          else if (entry.isFile()) files.push({ name: r, data: fs.readFileSync(path.join(dir, entry.name)) });
        }
      };
      walk(source, '');
    } else {
      files = readZip(crxZip(fs.readFileSync(source)));
    }
    const base = rootOf(files);
    const own = files.filter((f) => f.name.startsWith(base)).map((f) => ({ name: f.name.slice(base.length), data: f.data }));
    let manifest = JSON.parse(own.find((f) => f.name === 'manifest.json').data.toString('utf8').replace(/^﻿/, ''));
    if (!manifest.manifest_version || !manifest.name) throw new Error('manifest.json has no name or version');
    const from = isFirefox(manifest) ? 'firefox' : 'chrome';
    // Named for what it is, so installing it again replaces it.
    const key = manifest.browser_specific_settings?.gecko?.id || manifest.applications?.gecko?.id ||
      manifest.key || `${manifest.name}@${from}`;
    const adapted = adaptManifest(manifest);
    manifest = adapted.manifest;
    const id = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24);
    const dir = path.join(this.root, id);
    const temp = `${dir}.part`;
    fs.rmSync(temp, { recursive: true, force: true });
    for (const f of own) {
      const target = path.join(temp, f.name);
      if (!target.startsWith(temp + path.sep)) throw new Error(`unsafe path: ${f.name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.name === 'manifest.json' ? JSON.stringify(manifest, null, 2)
        : /\.html?$/i.test(f.name) ? adaptPage(f.data.toString('utf8')) : f.data);
    }
    fs.writeFileSync(path.join(temp, COMPAT_FILE), COMPAT_SOURCE());
    // Kept across reinstalls, so a page open on the old copy keeps working.
    let token = null;
    try { token = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')).token; } catch { /* new */ }
    token = token || crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(path.join(temp, CONTEXT_FILE), contextSource(null, token));
    fs.writeFileSync(path.join(temp, RELAY_FILE), adaptPage('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>\n'));
    if (adapted.worker) fs.writeFileSync(path.join(temp, WORKER_FILE), adapted.worker);
    // Through adaptPage, so the layer and the context load first, as on every page.
    if (adapted.backgroundHtml) fs.writeFileSync(path.join(temp, BACKGROUND_FILE), adaptPage(adapted.backgroundHtml));
    fs.writeFileSync(path.join(temp, META_FILE), JSON.stringify({ from, addedAt: Date.now(), source: path.basename(source),
      background: adapted.background, token }));
    this.unloadEverywhere(id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(temp, dir);
    this.cached = null;
    this.log(`extensions: installed ${manifest.name} (${from})`);
    return this.list().find((e) => e.id === id);
  }

  /** Tell an extension's pages which tab a popup is being opened over. */
  setActiveTab(id, tabId) {
    const ext = this.list().find((e) => e.id === id);
    if (ext) fs.writeFileSync(path.join(ext.dir, CONTEXT_FILE), contextSource(tabId, ext.token));
  }

  /** The id Chromium gave an installed copy in a session, for chrome-extension:// addresses. */
  loadedId(ses, id) {
    return ses.__debrowserExt?.get(id) || null;
  }

  /** Remove one: out of every session now, and off the disk. */
  remove(id) {
    if (!/^[0-9a-f]{24}$/.test(String(id))) return false;
    this.unloadEverywhere(id);
    fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
    this.cached = null;
    return true;
  }

  /**
   * Load every installed copy into a session, and remember the session so a
   * later install reaches it too. Failures are logged and listed, not thrown:
   * one extension Electron refuses must not keep the rest out.
   *
   * @returns {Promise<Array<{id: string, ok: boolean, error?: string}>>}
   */
  async attach(ses) {
    this.sessions.add(ses);
    const results = [];
    for (const ext of this.list()) results.push(await this.loadInto(ses, ext));
    return results;
  }

  async loadInto(ses, ext) {
    if (ses.__debrowserExt?.has(ext.id)) return { id: ext.id, ok: true };
    try {
      const api = ses.extensions || ses;
      const loaded = await api.loadExtension(ext.dir, { allowFileAccess: false });
      (ses.__debrowserExt ||= new Map()).set(ext.id, loaded.id);
      if (ext.background) this.hostBackground(ses, ext, loaded.id);
      if (ext.worker) this.ensureRelay(ses, ext, loaded.id);
      // Its request rules, run by Debrowser (extension-dnr.js).
      if (ext.rules) {
        this.dnr.forExtension(ext);
        this.dnr.setOrigin(ext.id, `chrome-extension://${loaded.id}`);
      }
      const hooks = require('./web-hooks').WebHooks.for(ses);
      this.dnr.attach(hooks);
      this.attachRequests(hooks);
      this.alarmSchedule(ext);
      return { id: ext.id, ok: true };
    } catch (err) {
      this.log(`extensions: ${ext.name} did not load: ${err.message}`);
      this.errors = { ...(this.errors || {}), [ext.id]: err.message };
      return { id: ext.id, ok: false, error: err.message };
    }
  }

  /** Into every session already attached: after an install. */
  async loadEverywhere(id) {
    const ext = this.list().find((e) => e.id === id);
    if (!ext) return [];
    if (this.errors) delete this.errors[id];
    return Promise.all([...this.sessions].map((ses) => this.loadInto(ses, ext)));
  }

  /**
   * An extension's background page, run by Debrowser: an off-screen view in
   * the extension's session, at the extension's own address, so it has the
   * whole extension API and a DOM, and its listeners answer the extension's
   * content scripts and popup. Not a window: a window, even hidden, would
   * keep the browser running after its last real one closed.
   */
  hostBackground(ses, ext, loadedId) {
    const { WebContentsView } = require('electron');
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
    (ses.__debrowserBg ||= new Map()).set(ext.id, view);
    view.webContents.loadURL(`chrome-extension://${loadedId}/${ext.background}`)
      .then(() => { if (Number.isInteger(this.activeTab)) this.tellBackground(view, this.activeTab); })
      .catch((err) => {
        this.log(`extensions: ${ext.name}'s background did not start: ${err.message}`);
        this.errors = { ...(this.errors || {}), [ext.id]: `its background did not start: ${err.message}` };
      });
  }

  /** Which tab is in front, for the backgrounds' tabs.query (extension-compat.js). */
  announceActiveTab(tabId) {
    this.activeTab = tabId;
    for (const ses of this.sessions) for (const view of (ses.__debrowserBg || new Map()).values()) this.tellBackground(view, tabId);
  }

  tellBackground(view, tabId) {
    if (view.webContents.isDestroyed() || !Number.isInteger(tabId)) return;
    view.webContents.executeJavaScript(`globalThis.__debrowserActiveTab = ${tabId};`).catch(() => {});
  }

  unloadEverywhere(id) {
    this.dnr.drop(id);
    this.listeners.delete(id);
    this.subscriptions.delete(id);
    clearTimeout(this.alarmTimers.get(id));
    if (this.menus.delete(id) && this.hooks.menusChanged) this.hooks.menusChanged();
    for (const ses of this.sessions) {
      const relay = ses.__debrowserRelay?.get(id);
      if (relay) {
        clearTimeout(relay.timer);
        try { relay.view.webContents.close(); } catch { /* gone */ }
        ses.__debrowserRelay.delete(id);
      }
      const host = ses.__debrowserBg?.get(id);
      if (host) {
        try { host.webContents.close(); } catch { /* already gone */ }
        ses.__debrowserBg.delete(id);
      }
      const loadedId = ses.__debrowserExt?.get(id);
      if (!loadedId) continue;
      try { (ses.extensions || ses).removeExtension(loadedId); } catch { /* already gone */ }
      ses.__debrowserExt.delete(id);
    }
  }

  /** Out of every session, for the Lab being turned off. Copies stay on disk. */
  detachAll() {
    for (const ext of this.list()) this.unloadEverywhere(ext.id);
  }
}

module.exports = { Extensions, readZip, crxZip, adaptManifest, adaptPage, isFirefox, storeTarget, downloadFromStore, COMPAT_FILE };
