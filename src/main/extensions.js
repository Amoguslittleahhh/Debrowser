'use strict';

/**
 * Extensions: Chrome's and Firefox's.
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
/** Which compatibility layer an installed copy's service worker was last started with (`refresh`). */
const LAYER_FILE = 'debrowser-layer.txt';
/** State an extension builds up while running, carried over when it is updated. */
const KEPT_FILES = ['debrowser-dnr.json', 'debrowser-alarms.json'];

/**
 * Each extension's own settings, as Chrome's details page has them: which
 * sites it may reach, whether it is pinned beside the puzzle button, whether
 * it may read file:// pages, and whether its errors are kept.
 */
const EXT_SETTINGS = { siteAccess: 'all', sites: [], fileAccess: false, collectErrors: true, pinned: false };

/** A site as typed - "example.com" or a whole address - as its host name, or null. */
function siteHost(text) {
  let t = String(text || '').trim().toLowerCase().replace(/^\*\./, '');
  if (!t) return null;
  if (!/^[a-z]+:\/\//.test(t)) t = `https://${t}`;
  let host;
  try { host = new URL(t).hostname; } catch { return null; }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) && (host.includes('.') || host === 'localhost') ? host : null;
}

/**
 * Its manifest's reach, narrowed to the sites the user allows: "click" keeps
 * none, "specific" keeps what fell on those sites. A pattern covering a whole
 * allowed site becomes that site; one inside an allowed site is kept as it is.
 */
function restrictAccess(orig, settings) {
  if (settings.siteAccess === 'all') return orig;
  const allowed = settings.siteAccess === 'specific' ? settings.sites : [];
  const isHost = (p) => p === '<all_urls>' || String(p).includes('://');
  const narrow = (list) => [...new Set((list || []).filter(isHost).flatMap((p) => allowed.flatMap((h) => {
    if (matchesPattern(p, `https://${h}/`) || matchesPattern(p, `http://${h}/`)) {
      const scheme = p === '<all_urls>' ? '*' : String(p).split('://')[0];
      return [`${scheme}://${h}/*`, `${scheme}://*.${h}/*`];
    }
    const m = /^[^:]+:\/\/(?:\*\.)?([^/]+)/.exec(String(p));
    return m && (m[1] === h || m[1].endsWith(`.${h}`)) ? [p] : [];
  })))];
  return {
    host_permissions: orig.host_permissions && narrow(orig.host_permissions),
    permissions: orig.permissions && [...orig.permissions.filter((p) => !isHost(p)), ...narrow(orig.permissions)],
    content_scripts: orig.content_scripts && orig.content_scripts
      .map((cs) => ({ ...cs, matches: narrow(cs.matches) })).filter((cs) => cs.matches.length)
  };
}

/** Where it came from, by the file or folder it was added from (a store's download is named for the store). */
function sourceOf(meta, from) {
  const m = /^(chrome|edge|firefox)-(.+)\.(crx|xpi)$/.exec(String(meta.source || ''));
  if (m) {
    const id = m[2];
    return m[1] === 'chrome' ? { label: 'Chrome Web Store', url: `https://chromewebstore.google.com/detail/${id}` }
      : m[1] === 'edge' ? { label: 'Edge Add-ons', url: `https://microsoftedge.microsoft.com/addons/detail/${id}` }
      : { label: 'Firefox Add-ons', url: `https://addons.mozilla.org/firefox/addon/${encodeURIComponent(id)}/` };
  }
  if (/\.(crx|xpi|zip)$/i.test(String(meta.source || ''))) return { label: `A ${from === 'firefox' ? 'Firefox' : 'Chrome'} extension file`, url: null };
  return { label: meta.source ? 'An unpacked folder' : 'Unknown', url: null };
}

/** The size of a folder on disk, in bytes. */
function folderSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    try { n += e.isDirectory() ? folderSize(f) : fs.statSync(f).size; } catch { /* gone */ }
  }
  return n;
}

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
/**
 * The public key a .crx (version 3) was signed with, as a manifest's "key":
 * with it Chromium gives the extension the same ID it has in Chrome and on
 * the store, rather than one made up from where its folder is. Null for
 * anything else.
 */
function crxKey(buf) {
  if (buf.toString('latin1', 0, 4) !== 'Cr24' || buf.readUInt32LE(4) !== 3) return null;
  const header = buf.subarray(12, 12 + buf.readUInt32LE(8));
  // A protobuf, read by hand: CrxFileHeader { 2: AsymmetricKeyProof { 1: public_key } ...,
  // 10000: signed_header_data (SignedData { 1: crx_id }) }.
  const fields = (b) => {
    const out = [];
    let i = 0;
    const varint = () => {
      let v = 0;
      let shift = 0;
      for (;;) {
        const byte = b[i++];
        v += (byte & 0x7f) * 2 ** shift;
        if (!(byte & 0x80)) return v;
        shift += 7;
      }
    };
    while (i < b.length) {
      const tag = varint();
      const type = tag % 8;
      if (type === 2) {
        const len = varint();
        out.push({ field: Math.floor(tag / 8), data: b.subarray(i, i + len) });
        i += len;
      } else if (type === 0) varint();
      else return out;
    }
    return out;
  };
  try {
    const top = fields(header);
    const signed = top.find((f) => f.field === 10000);
    const crxId = signed && fields(signed.data).find((f) => f.field === 1);
    const keys = top.filter((f) => f.field === 2).map((f) => fields(f.data).find((g) => g.field === 1)).filter(Boolean)
      .map((f) => f.data);
    const own = keys.find((k) => crxId && crypto.createHash('sha256').update(k).digest().subarray(0, 16).equals(crxId.data));
    return own ? own.toString('base64') : null;
  } catch {
    return null;
  }
}

/** The ID Chrome gives the extension with this manifest key: its store ID. */
function idFromKey(key) {
  try {
    return [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)]
      .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
  } catch {
    return null;
  }
}

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
/**
 * A page policy that lets the extension reach the browser's bridge
 * (debrowser://ext-bridge). An extension that lists where its pages may
 * connect - Claude allows its own servers and nothing else - had every call
 * to Debrowser refused by its own policy: its button, menus, alarms, side
 * panel and sign-in all silently did nothing. Only `connect-src` is widened,
 * and only by the browser's own scheme.
 */
function allowBridge(policy) {
  if (typeof policy !== 'string' || !policy.trim()) return policy;
  const parts = policy.split(';').map((p) => p.trim()).filter(Boolean);
  const at = parts.findIndex((p) => /^connect-src(\s|$)/i.test(p));
  if (at >= 0) {
    if (/(^|\s)debrowser:(\s|$)/i.test(parts[at])) return policy;
    // 'none' stands alone; with a source beside it, it is dropped.
    parts[at] = `${parts[at].replace(/\s'none'/i, '')} debrowser:`;
  } else {
    const fallback = parts.find((p) => /^default-src(\s|$)/i.test(p));
    if (!fallback) return policy;
    parts.push(`connect-src ${fallback.replace(/^default-src\s*/i, '').replace(/'none'/i, '').trim()} debrowser:`.replace(/\s+/g, ' '));
  }
  return `${parts.join('; ')};`;
}

/** The manifest's page policy, either shape (V3's object, V2's string), with the bridge allowed. */
function allowBridgeIn(manifest) {
  const csp = manifest.content_security_policy;
  if (typeof csp === 'string') manifest.content_security_policy = allowBridge(csp);
  else if (csp && typeof csp === 'object' && typeof csp.extension_pages === 'string') csp.extension_pages = allowBridge(csp.extension_pages);
  return manifest;
}

function adaptManifest(manifest) {
  const out = JSON.parse(JSON.stringify(manifest));
  allowBridgeIn(out);
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
    // Not into the page's own world: there it has no extension API to fill
    // in, and would hand every page a `browser` object to find - a tell that
    // an extension is installed, and a wrong answer to Firefox sniffing.
    for (const cs of out.content_scripts) {
      if (Array.isArray(cs.js) && String(cs.world || '').toUpperCase() !== 'MAIN') cs.js = [COMPAT_FILE, ...cs.js];
    }
  }
  // Keyboard commands named with anything but letters, digits and "_" -
  // Firefox allows "add-site-p1", Chromium refuses to load the extension.
  if (out.commands && typeof out.commands === 'object') {
    out.commands = Object.fromEntries(Object.entries(out.commands).map(([k, v]) =>
      [/^_execute_/.test(k) ? k : k.replace(/[^A-Za-z0-9_]/g, '_'), v]));
    // Chromium takes at most four suggested keys and refuses more; the rest
    // stay as commands without a key, as Chrome lists them.
    let keyed = 0;
    for (const v of Object.values(out.commands)) {
      if (v && v.suggested_key && ++keyed > 4) delete v.suggested_key;
    }
  }
  delete out.browser_specific_settings;
  delete out.applications;
  return { manifest: out, worker, background, backgroundHtml };
}

/**
 * A locale's messages with names Chromium accepts: Firefox allows
 * "moz-vpn-connected", Chromium refuses to load the whole extension over it.
 * The layer looks names up the same way (extension-compat.js, i18n).
 */
function adaptMessages(data) {
  try {
    const messages = JSON.parse(data.toString('utf8').replace(/^\uFEFF/, ''));
    if (!Object.keys(messages).some((k) => /[^A-Za-z0-9_]/.test(k))) return data;
    return JSON.stringify(Object.fromEntries(Object.entries(messages).map(([k, v]) => [k.replace(/[^A-Za-z0-9_]/g, '_'), v])));
  } catch {
    return data;
  }
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

/**
 * The extension's own logo, as its manifest names it: the toolbar button's
 * icon first, as Chrome shows it there, else the extension's icons. The
 * smallest that is at least 32px, so it stays sharp at 16px on a 2x screen.
 */
function iconOf(manifest) {
  const action = manifest.action || manifest.browser_action || manifest.page_action || {};
  const pick = (set) => {
    if (typeof set === 'string') return set;
    if (!set || typeof set !== 'object') return null;
    const sizes = Object.keys(set).map(Number).filter((n) => Number.isFinite(n) && set[n]).sort((a, b) => a - b);
    if (!sizes.length) return null;
    return set[sizes.find((n) => n >= 32) ?? sizes[sizes.length - 1]];
  };
  const file = pick(action.default_icon) || pick(manifest.icons);
  return file ? String(file).replace(/^\/+/, '') : null;
}

const ICON_TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp' };

/**
 * Whether a match pattern ("<all_urls>", "*://*.example.com/*") covers an
 * address: what an extension's host permissions allow it to reach.
 */
function matchesPattern(pattern, address) {
  let u;
  try { u = new URL(address); } catch { return false; }
  if (!/^(https?|wss?|ftp):$/.test(u.protocol)) return false;
  if (pattern === '<all_urls>') return true;
  const m = /^(\*|https?|wss?|ftp):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)?$/.exec(String(pattern));
  if (!m) return false;
  const [, scheme, host] = m;
  if (scheme === '*' ? !/^(https?|wss?):$/.test(u.protocol) : u.protocol !== `${scheme}:`) return false;
  if (host === '*') return true;
  if (host.startsWith('*.')) return u.hostname === host.slice(2) || u.hostname.endsWith(host.slice(1));
  return u.hostname === host;
}

/** A cookie as Electron has it, as Chrome's cookies API describes it. */
function chromeCookie(k) {
  return {
    name: k.name, value: k.value, domain: k.domain, hostOnly: Boolean(k.hostOnly), path: k.path || '/',
    secure: Boolean(k.secure), httpOnly: Boolean(k.httpOnly), sameSite: k.sameSite || 'unspecified',
    session: Boolean(k.session), ...(k.expirationDate ? { expirationDate: k.expirationDate } : {}), storeId: '0'
  };
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

/** The same, from an extension's files before they are written anywhere. */
function localName(files, manifest) {
  const raw = String(manifest.name || '');
  const m = /^__MSG_(.+)__$/.exec(raw);
  if (!m) return raw;
  try {
    const file = files.find((f) => f.name === `_locales/${manifest.default_locale || 'en'}/messages.json`);
    const messages = JSON.parse(file.data.toString('utf8').replace(/^\uFEFF/, ''));
    const hit = Object.entries(messages).find(([k]) => k.toLowerCase() === m[1].toLowerCase());
    return hit ? String(hit[1].message) : raw;
  } catch {
    return raw;
  }
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
    // Each extension's side panel, as it set it: { path, tabs: Map(tabId ->
    // {path, enabled}), openOnClick }.
    this.panels = new Map();
    // Tabs an extension has the debugger on: `${extId}:${webContentsId}` -> detach().
    this.debugging = new Map();
  }

  /** An extension's side panel settings, made on first use. */
  panelFor(ext) {
    if (!this.panels.has(ext.id)) this.panels.set(ext.id, { path: ext.sidePanel || null, tabs: new Map(), openOnClick: false });
    return this.panels.get(ext.id);
  }

  /** The page an extension's side panel shows for a tab, or null if it has none there. */
  panelPath(ext, tabId) {
    const panel = this.panelFor(ext);
    const own = Number.isInteger(tabId) ? panel.tabs.get(tabId) : null;
    if (own && own.enabled === false) return null;
    if (own && own.path) return own.path;
    return panel.path;
  }

  /**
   * The DevTools protocol on a tab, for an extension that declared it. Only
   * the browser's tabs, and only websites and the extension's own pages - not
   * Debrowser's own pages, which see passwords and settings.
   */
  debugTarget(ext, target) {
    if (!ext.permissions || !ext.permissions.includes('debugger')) throw new Error('This extension did not ask to use the debugger');
    const tabId = Number(target && target.tabId);
    const wc = Number.isInteger(tabId) && this.hooks.tabContents ? this.hooks.tabContents(tabId) : null;
    if (!wc || wc.isDestroyed()) throw new Error(`No tab with id: ${target && target.tabId}.`);
    if (!/^(https?|file|chrome-extension):/i.test(wc.getURL()) && wc.getURL() !== 'about:blank') {
      throw new Error('Cannot access contents of the page');
    }
    return wc;
  }

  debuggerAttach(ext, target, version) {
    const wc = this.debugTarget(ext, target);
    const key = `${ext.id}:${wc.id}`;
    if (this.debugging.has(key)) throw new Error('Debugger is already attached to the tab with id: ' + wc.id);
    if (wc.debugger.isAttached()) throw new Error('Another debugger is already attached to the tab with id: ' + wc.id);
    wc.debugger.attach(String(version || '1.3'));
    const tabId = wc.id;
    const onMessage = (_e, method, params, sessionId) => {
      this.dispatch(ext.id, 'debugger.onEvent', [{ tabId, ...(sessionId ? { sessionId } : {}) }, method, params]);
    };
    const onDetach = (_e, reason) => {
      if (!this.debugging.has(key)) return;
      this.debugging.delete(key);
      wc.debugger.removeListener('message', onMessage);
      if (this.hooks.debugging) this.hooks.debugging(ext, wc, false);
      this.dispatch(ext.id, 'debugger.onDetach', [{ tabId }, reason === 'target closed' ? 'target_closed' : 'canceled_by_user']);
    };
    wc.debugger.on('message', onMessage);
    wc.debugger.once('detach', onDetach);
    const stop = () => {
      if (!this.debugging.has(key)) return;
      this.debugging.delete(key);
      wc.debugger.removeListener('message', onMessage);
      wc.debugger.removeListener('detach', onDetach);
      try { if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* gone */ }
      if (this.hooks.debugging) this.hooks.debugging(ext, wc, false);
    };
    this.debugging.set(key, stop);
    if (this.hooks.debugging) this.hooks.debugging(ext, wc, true);
  }

  /** Let go of every tab an extension is debugging: it was removed, or asked. */
  debuggerDetachAll(extId) {
    for (const [key, stop] of [...this.debugging]) if (key.startsWith(`${extId}:`)) stop();
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
      case 'sidePanel.setOptions': {
        const panel = this.panelFor(ext);
        const page = typeof a.path === 'string' ? a.path.replace(/^\/+/, '') : undefined;
        if (Number.isInteger(a.tabId)) {
          const had = panel.tabs.get(a.tabId) || {};
          panel.tabs.set(a.tabId, { path: page ?? had.path ?? null, enabled: a.enabled ?? had.enabled ?? true });
        } else {
          if (page !== undefined) panel.path = page;
          if (a.enabled === false) panel.path = null;
        }
        if (a.enabled === false && this.hooks.closeSidePanel) this.hooks.closeSidePanel(ext, Number.isInteger(a.tabId) ? a.tabId : null);
        return undefined;
      }
      case 'sidePanel.getOptions': {
        const tabId = Number.isInteger(a.tabId) ? a.tabId : undefined;
        const p = this.panelPath(ext, tabId);
        return { ...(tabId !== undefined ? { tabId } : {}), path: p || undefined, enabled: Boolean(p) };
      }
      case 'sidePanel.setPanelBehavior': this.panelFor(ext).openOnClick = a.openPanelOnActionClick === true; return undefined;
      case 'sidePanel.getPanelBehavior': return { openPanelOnActionClick: this.panelFor(ext).openOnClick };
      case 'sidePanel.open': {
        const tabId = Number.isInteger(a.tabId) ? a.tabId : (this.hooks.activeTabId ? this.hooks.activeTabId() : null);
        const page = this.panelPath(ext, tabId);
        if (!page) throw new Error('No active side panel for tabId: ' + tabId);
        if (!this.hooks.openSidePanel) throw new Error('side panels aren’t available here');
        // Opened for one tab when its page was set for one tab; for all, otherwise.
        const forTab = Number.isInteger(tabId) && this.panelFor(ext).tabs.has(tabId) ? tabId : null;
        this.hooks.openSidePanel(ext, page, forTab);
        return undefined;
      }
      case 'sidePanel.close':
        if (this.hooks.closeSidePanel) this.hooks.closeSidePanel(ext, Number.isInteger(a.tabId) ? a.tabId : null);
        return undefined;
      case 'runtime.getContexts': {
        const types = Array.isArray(a.contextTypes) ? a.contextTypes : null;
        if (types && !types.includes('SIDE_PANEL')) return [];
        const open = this.hooks.sidePanelsOf ? this.hooks.sidePanelsOf(ext) : [];
        return open.map((o, i) => ({ contextType: 'SIDE_PANEL', contextId: `side-panel-${i}`, documentUrl: o.url,
          documentOrigin: new URL(o.url).origin, frameId: 0, documentId: `side-panel-${i}`, incognito: false,
          tabId: Number.isInteger(o.tabId) ? o.tabId : -1, windowId: 1 }));
      }
      case 'identity.launchWebAuthFlow': {
        if (!this.hooks.webAuthFlow) throw new Error('sign-in isn’t available here');
        if (!/^https?:\/\//i.test(String(a.url || ''))) throw new Error('Authorization page could not be loaded.');
        return this.hooks.webAuthFlow(ext, { url: String(a.url), interactive: a.interactive === true,
          timeout: Math.min(120000, Math.max(1000, Number(a.timeout) || 15000)) });
      }
      case 'debugger.attach': this.debuggerAttach(ext, a.target, a.version); return undefined;
      case 'debugger.detach': {
        const wc = this.debugTarget(ext, a.target);
        const stop = this.debugging.get(`${ext.id}:${wc.id}`);
        if (!stop) throw new Error('Debugger is not attached to the tab with id: ' + wc.id);
        stop();
        return undefined;
      }
      case 'debugger.sendCommand': {
        const wc = this.debugTarget(ext, a.target);
        if (!this.debugging.has(`${ext.id}:${wc.id}`)) throw new Error('Debugger is not attached to the tab with id: ' + wc.id);
        return wc.debugger.sendCommand(String(a.method), a.params || {}, a.target && a.target.sessionId);
      }
      case 'debugger.getTargets': {
        const tabs = this.hooks.listTabs ? this.hooks.listTabs() : [];
        return tabs.map((t) => ({ type: 'page', id: String(t.id), tabId: t.id, url: t.url, title: t.title,
          attached: this.debugging.has(`${ext.id}:${t.id}`) }));
      }
      case 'cookies.get':
      case 'cookies.getAll':
      case 'cookies.set':
      case 'cookies.remove': return this.cookies(ext, op.slice(8), a);
      case 'tabs.captureVisibleTab': {
        if (!this.hooks.captureActive) throw new Error('pictures of the page aren’t available here');
        return this.hooks.captureActive(a);
      }
      default: throw new Error(`${op} isn’t available in Debrowser yet`);
    }
  }

  /**
   * chrome.cookies, on the browsing session: only for an extension that asked
   * for "cookies", and only for the sites its host permissions reach - in
   * Chrome a cookie outside them is not there to read or write.
   */
  async cookies(ext, method, a) {
    if (!ext.permissions.includes('cookies')) throw new Error('This extension did not ask for "cookies".');
    const ses = [...this.sessions][0];
    if (!ses) return method === 'getAll' ? [] : null;
    const may = (address) => (ext.hosts || []).some((p) => matchesPattern(p, address));
    const siteOf = (k) => `http${k.secure ? 's' : ''}://${String(k.domain || '').replace(/^\./, '')}${k.path || '/'}`;
    const url = a.url ? String(a.url) : null;
    if (url && !may(url)) {
      if (method === 'getAll') return [];
      throw new Error(`No host permissions for cookies at url: "${url}".`);
    }
    if (method === 'get') {
      if (!url) throw new Error('A url is needed.');
      const [found] = await ses.cookies.get({ url, name: String(a.name || '') });
      return found ? chromeCookie(found) : null;
    }
    if (method === 'getAll') {
      const filter = {};
      if (url) filter.url = url;
      for (const k of ['name', 'domain', 'path', 'secure', 'session']) if (a[k] !== undefined) filter[k] = a[k];
      const all = await ses.cookies.get(filter);
      return all.filter((k) => may(siteOf(k))).map(chromeCookie);
    }
    if (method === 'set') {
      if (!url) throw new Error('A url is needed.');
      const details = { url };
      for (const k of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'expirationDate', 'sameSite']) {
        if (a[k] !== undefined) details[k] = a[k];
      }
      await ses.cookies.set(details);
      const [found] = await ses.cookies.get({ url, name: String(a.name || '') });
      return found ? chromeCookie(found) : null;
    }
    if (!url) throw new Error('A url is needed.');
    await ses.cookies.remove(url, String(a.name || ''));
    return { url, name: String(a.name || ''), storeId: '0' };
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
          popup: popupOf(manifest), icon: iconOf(manifest), background: meta.background || null, token: meta.token || null,
          // The page its side panel opens on, if the manifest names one; it
          // may name it later instead, with sidePanel.setOptions.
          sidePanel: manifest.side_panel && manifest.side_panel.default_path
            ? String(manifest.side_panel.default_path).replace(/^\/+/, '') : null,
          permissions: [...(manifest.permissions || [])].map(String),
          // The sites it may reach: MV3's own list, or MV2's patterns among its permissions.
          hosts: [...(manifest.host_permissions || []), ...(manifest.permissions || [])].map(String)
            .filter((p) => p === '<all_urls>' || p.includes('://')),
          // Rules it ships, or only ones it adds while running: those are
          // saved too, and must be in force from the next start.
          rules: Boolean(manifest.declarative_net_request) || [...(manifest.permissions || [])].some((p) =>
            /^declarativeNetRequest/.test(String(p))),
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
    let signedKey = null;
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
      const buf = fs.readFileSync(source);
      signedKey = crxKey(buf);
      files = readZip(crxZip(buf));
    }
    const base = rootOf(files);
    const own = files.filter((f) => f.name.startsWith(base)).map((f) => ({ name: f.name.slice(base.length), data: f.data }));
    let manifest = JSON.parse(own.find((f) => f.name === 'manifest.json').data.toString('utf8').replace(/^﻿/, ''));
    if (!manifest.manifest_version || !manifest.name) throw new Error('manifest.json has no name or version');
    const from = isFirefox(manifest) ? 'firefox' : 'chrome';
    // Named for what it is, so installing it again replaces it.
    // By its real name, not a "__MSG_extName__" placeholder: uBlock Origin
    // Lite, Grammarly and AdGuard all have that one, so each replaced the last.
    const key = manifest.browser_specific_settings?.gecko?.id || manifest.applications?.gecko?.id ||
      manifest.key || `${localName(own, manifest)}@${from}`;
    // After the name above, so a copy added before this keeps its folder.
    if (signedKey && !manifest.key) manifest.key = signedKey;
    const original = manifest;
    const adapted = adaptManifest(manifest);
    manifest = adapted.manifest;
    // A "__MSG_name__" the default locale does not define: Firefox shows
    // nothing, Chromium refuses the extension. Defined, empty but for its name.
    if (manifest.default_locale) {
      const file = own.find((f) => f.name === `_locales/${manifest.default_locale}/messages.json`);
      if (file) {
        try {
          const messages = JSON.parse(file.data.toString('utf8').replace(/^\uFEFF/, ''));
          const known = new Set(Object.keys(messages).map((k) => k.toLowerCase()));
          const used = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+?)__/g)].map((m) => m[1]);
          const missing = used.filter((n) => !known.has(n.toLowerCase()) && !/^@@/.test(n));
          if (missing.length) {
            for (const n of missing) messages[n] = { message: n };
            file.data = Buffer.from(JSON.stringify(messages));
          }
        } catch { /* left as it is */ }
      }
    }
    const id = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24);
    const dir = path.join(this.root, id);
    const temp = `${dir}.part`;
    fs.rmSync(temp, { recursive: true, force: true });
    for (const f of own) {
      const target = path.join(temp, f.name);
      if (!target.startsWith(temp + path.sep)) throw new Error(`unsafe path: ${f.name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.name === 'manifest.json' ? JSON.stringify(manifest, null, 2)
        : /^_locales\/[^/]+\/messages\.json$/.test(f.name) ? adaptMessages(f.data)
        : /\.html?$/i.test(f.name) ? adaptPage(f.data.toString('utf8')) : f.data);
    }
    fs.writeFileSync(path.join(temp, COMPAT_FILE), COMPAT_SOURCE());
    // Kept across reinstalls, so a page open on the old copy keeps working.
    let token = null;
    let settings;
    try { ({ token, settings } = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8'))); } catch { /* new */ }
    token = token || crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(path.join(temp, CONTEXT_FILE), contextSource(null, token));
    fs.writeFileSync(path.join(temp, RELAY_FILE), adaptPage('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>\n'));
    if (adapted.worker) fs.writeFileSync(path.join(temp, WORKER_FILE), adapted.worker);
    // Through adaptPage, so the layer and the context load first, as on every page.
    if (adapted.backgroundHtml) fs.writeFileSync(path.join(temp, BACKGROUND_FILE), adaptPage(adapted.backgroundHtml));
    fs.writeFileSync(path.join(temp, META_FILE), JSON.stringify({ from, addedAt: Date.now(), source: path.basename(source),
      background: adapted.background, token,
      // Its settings survive an update, as in Chrome; the site access they
      // set is applied to the new manifest when it loads.
      ...(settings ? { settings } : {}),
      // A Firefox add-on's own ID, which adaptManifest takes out of the manifest.
      geckoId: original.browser_specific_settings?.gecko?.id || original.applications?.gecko?.id || null }));
    // What the extension built up while running - its own request rules, the
    // rulesets it switched, its alarms - survives an update, as in Chrome.
    for (const kept of KEPT_FILES) {
      try { fs.copyFileSync(path.join(dir, kept), path.join(temp, kept)); } catch { /* none yet */ }
    }
    this.unloadEverywhere(id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(temp, dir);
    this.cached = null;
    this.settingCache?.delete(id);
    this.log(`extensions: installed ${manifest.name} (${from})`);
    return this.list().find((e) => e.id === id);
  }

  /**
   * Its logo as a data: address, for the browser's own pages to draw: they
   * cannot load chrome-extension:// or file:// addresses. Null without one.
   */
  iconData(id) {
    const ext = this.list().find((e) => e.id === id);
    if (!ext || !ext.icon) return null;
    const file = path.resolve(ext.dir, ext.icon);
    const type = ICON_TYPES[path.extname(file).toLowerCase()];
    if (!type || !file.startsWith(ext.dir + path.sep)) return null;
    try {
      const data = fs.readFileSync(file);
      return data.length <= 512 * 1024 ? `data:${type};base64,${data.toString('base64')}` : null;
    } catch { return null; }
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
    // Errors from extensions' service workers, for their developer details.
    if (!ses.__debrowserErrorWatch && ses.serviceWorkers) {
      ses.__debrowserErrorWatch = true;
      ses.serviceWorkers.on('console-message', (_e, d) => {
        if (d && d.level >= 3) this.noteError(ses, d.sourceUrl, d.message, d.lineNumber);
      });
    }
    const results = [];
    for (const ext of this.list()) results.push(await this.loadInto(ses, ext));
    return results;
  }

  /**
   * Bring an installed copy up to this version of Debrowser before it loads:
   * the compatibility layer as this version has it, and the page policy that
   * lets it reach the browser. Both were written once, at install, so an
   * extension added before an update kept the old layer and the old policy.
   */
  refresh(ext) {
    try {
      const layer = path.join(ext.dir, COMPAT_FILE);
      const now = COMPAT_SOURCE();
      let had = '';
      try { had = fs.readFileSync(layer, 'utf8'); } catch { /* none */ }
      if (had !== now) fs.writeFileSync(layer, now);
      const file = path.join(ext.dir, 'manifest.json');
      const before = fs.readFileSync(file, 'utf8');
      const manifest = allowBridgeIn(JSON.parse(before));
      const after = JSON.stringify(manifest, null, 2);
      if (after !== before) fs.writeFileSync(file, after);
    } catch (err) {
      this.log(`extensions: ${ext.name} could not be updated for this version: ${err.message}`);
    }
  }

  /**
   * Whether an extension's service worker may still be running an older
   * layer. Chromium keeps a registered worker's scripts and does not look at
   * them again - not even when its own file changes - so a worker registered
   * before this version of Debrowser kept the old layer for good: Claude's
   * worker never saw its button clicked. The answer is what to write once the
   * worker has been started afresh (`freshWorker`), or null if it is current.
   */
  staleWorker(ext) {
    if (!ext.worker) return null;
    const want = crypto.createHash('sha256').update(COMPAT_SOURCE()).digest('hex');
    let had = '';
    try { had = fs.readFileSync(path.join(ext.dir, LAYER_FILE), 'utf8').trim(); } catch { /* never recorded */ }
    return had === want ? null : want;
  }

  /**
   * Start an extension's service worker again from its files: its registration
   * dropped (the worker only - its saved data is kept), and the extension
   * loaded again, which registers it anew.
   */
  async freshWorker(ses, ext, loaded, stamp) {
    const api = ses.extensions || ses;
    try {
      await ses.clearStorageData({ origin: `chrome-extension://${loaded.id}`, storages: ['serviceworkers'] });
      api.removeExtension(loaded.id);
      const again = await api.loadExtension(ext.dir, { allowFileAccess: this.settingsOf(ext.id).fileAccess });
      fs.writeFileSync(path.join(ext.dir, LAYER_FILE), stamp);
      return again;
    } catch (err) {
      this.log(`extensions: ${ext.name}'s worker could not be restarted: ${err.message}`);
      return loaded;
    }
  }

  async loadInto(ses, ext) {
    if (ses.__debrowserExt?.has(ext.id)) return { id: ext.id, ok: true };
    this.refresh(ext);
    this.applyAccess(ext);
    try {
      const api = ses.extensions || ses;
      let loaded = await api.loadExtension(ext.dir, { allowFileAccess: this.settingsOf(ext.id).fileAccess });
      const stale = this.staleWorker(ext);
      if (stale) loaded = await this.freshWorker(ses, ext, loaded, stale);
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
    view.webContents.on('console-message', (e) => {
      if (e.level === 'error') this.noteError(ses, e.sourceId || `chrome-extension://${loadedId}/`, e.message, e.lineNumber);
    });
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
    this.debuggerDetachAll(id);
    if (this.hooks.closeSidePanel) this.hooks.closeSidePanel({ id }, null);
    this.panels.delete(id);
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

  /* -- Developer details, per extension (Settings → Extensions). -- */

  /** An error an extension's own code logged or threw: the last 100 are kept, newest last. */
  noteError(ses, sourceUrl, message, line) {
    const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(String(sourceUrl || ''));
    if (!m) return;
    const entry = [...(ses.__debrowserExt || new Map())].find(([, loaded]) => loaded === m[1]);
    if (!entry || !this.settingsOf(entry[0]).collectErrors) return;
    const list = (this.logged ||= new Map()).get(entry[0]) || [];
    list.push({ at: Date.now(), message: String(message || '').slice(0, 2000), source: String(sourceUrl).slice(0, 300),
      line: Number(line) || 0 });
    this.logged.set(entry[0], list.slice(-100));
  }

  /** What Chrome's developer mode shows for one, and a little more. */
  details(id) {
    const ext = this.list().find((e) => e.id === id);
    if (!ext) return null;
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(ext.dir, 'manifest.json'), 'utf8')); } catch { /* listed, so readable */ }
    const ses = [...this.sessions][0];
    const loaded = ses ? this.loadedId(ses, id) : null;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(ext.dir, META_FILE), 'utf8')); } catch { /* none */ }
    const gecko = meta.geckoId || null;
    const options = (manifest.options_ui && manifest.options_ui.page) || manifest.options_page || null;
    let running = false;
    if (ses && loaded && ext.worker) {
      running = Object.values(ses.serviceWorkers.getAllRunning?.() || {})
        .some((w) => String(w.scope || '').startsWith(`chrome-extension://${loaded}/`));
    } else if (ses && ses.__debrowserBg?.get(id)) running = !ses.__debrowserBg.get(id).webContents.isDestroyed();
    return {
      id: loaded || (manifest.key ? idFromKey(manifest.key) : null),
      storeId: manifest.key ? idFromKey(manifest.key) : null,
      geckoId: gecko,
      folderId: id,
      name: ext.name,
      version: ext.version,
      description: String(manifest.description || '').startsWith('__MSG_') ? '' : String(manifest.description || ''),
      manifestVersion: ext.manifestVersion,
      from: ext.from,
      dir: ext.dir,
      addedAt: ext.addedAt,
      loaded: Boolean(loaded),
      background: ext.worker ? 'service worker' : ext.background ? 'background page' : null,
      running,
      popup: ext.popup,
      options: options ? String(options).replace(/^\/+/, '') : null,
      sidePanel: ext.sidePanel,
      permissions: ext.permissions.filter((p) => !p.includes('://') && p !== '<all_urls>'),
      hosts: ext.hosts,
      optionalPermissions: [...(manifest.optional_permissions || []), ...(manifest.optional_host_permissions || [])].map(String),
      contentScripts: (manifest.content_scripts || []).map((cs) => ({ matches: cs.matches || [], js: (cs.js || []).length,
        css: (cs.css || []).length, world: cs.world || 'ISOLATED' })),
      commands: Object.entries(manifest.commands || {}).map(([name, c]) => ({ name,
        key: (c && c.suggested_key && (c.suggested_key.default || Object.values(c.suggested_key)[0])) || '' })),
      rules: (manifest.declarative_net_request?.rule_resources || []).map((r) => r.id),
      webAccessible: (manifest.web_accessible_resources || []).reduce((n, w) => n + (Array.isArray(w) ? 1 : (w.resources || []).length), 0),
      csp: typeof manifest.content_security_policy === 'string' ? manifest.content_security_policy
        : manifest.content_security_policy?.extension_pages || null,
      size: (() => { try { return folderSize(ext.dir); } catch { return 0; } })(),
      source: sourceOf(meta, ext.from),
      settings: this.settingsOf(id),
      startError: this.errors?.[id] || null,
      errors: (this.logged?.get(id) || []).slice(-50)
    };
  }

  /** Start it again from its files, as Chrome's Reload does. */
  /* -- Its own settings (Settings → Extensions → Details). -- */

  settingsOf(id) {
    const cache = (this.settingCache ||= new Map());
    if (!cache.has(id)) {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(this.root, id, META_FILE), 'utf8')); } catch { /* none */ }
      cache.set(id, { ...EXT_SETTINGS, ...(meta.settings || {}) });
    }
    return { ...cache.get(id) };
  }

  /** Change one; what changes what it may reach loads it again. */
  async setSetting(id, key, value) {
    const ext = this.list().find((e) => e.id === id);
    if (!ext || !Object.hasOwn(EXT_SETTINGS, key)) return null;
    const v = key === 'siteAccess' ? (['all', 'specific', 'click'].includes(value) ? value : 'all')
      : key === 'sites' ? [...new Set((Array.isArray(value) ? value : []).map(siteHost).filter(Boolean))].slice(0, 100)
      : value === true;
    const file = path.join(ext.dir, META_FILE);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none */ }
    meta.settings = { ...EXT_SETTINGS, ...(meta.settings || {}), [key]: v };
    fs.writeFileSync(file, JSON.stringify(meta));
    this.settingCache?.delete(id);
    if (key === 'collectErrors' && !v) this.logged?.delete(id);
    if (key === 'pinned' && this.hooks.pinsChanged) this.hooks.pinsChanged();
    if (key === 'siteAccess' || key === 'sites' || key === 'fileAccess') await this.reload(id);
    return this.settingsOf(id);
  }

  /**
   * Write its manifest's reach as its site access says. The manifest's own
   * lists are kept in its meta the first time it is narrowed, so "On all
   * sites" gives back exactly what it shipped with; an update brings a new
   * manifest and a fresh meta, and so its own lists again.
   */
  applyAccess(ext) {
    const file = path.join(ext.dir, 'manifest.json');
    const metaFile = path.join(ext.dir, META_FILE);
    try {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* none */ }
      const settings = { ...EXT_SETTINGS, ...(meta.settings || {}) };
      if (!meta.access && settings.siteAccess === 'all') return;
      const before = fs.readFileSync(file, 'utf8');
      const manifest = JSON.parse(before);
      if (!meta.access) {
        meta.access = { host_permissions: manifest.host_permissions, permissions: manifest.permissions,
          content_scripts: manifest.content_scripts };
        fs.writeFileSync(metaFile, JSON.stringify(meta));
      }
      const after = JSON.stringify({ ...manifest, ...restrictAccess(meta.access, settings) }, null, 2);
      if (after !== before) { fs.writeFileSync(file, after); this.cached = null; }
    } catch (err) {
      this.log(`extensions: ${ext.name}'s site access could not be set: ${err.message}`);
    }
  }

  async reload(id) {
    this.unloadEverywhere(id);
    if (this.errors) delete this.errors[id];
    this.cached = null;
    return this.loadEverywhere(id);
  }

  /**
   * Its background's developer tools: the hosted page's own, or the service
   * worker's, opened through its relay page, which the worker controls.
   */
  inspectBackground(id) {
    const ext = this.list().find((e) => e.id === id);
    const ses = [...this.sessions][0];
    const loaded = ses && ext && this.loadedId(ses, id);
    if (!loaded) return false;
    const host = ses.__debrowserBg?.get(id);
    if (host && !host.webContents.isDestroyed()) {
      host.webContents.openDevTools({ mode: 'detach' });
      return true;
    }
    if (!ext.worker) return false;
    const relay = this.ensureRelay(ses, ext, loaded);
    relay.ready.then(() => { if (!relay.view.webContents.isDestroyed()) relay.view.webContents.inspectServiceWorker(); });
    return true;
  }

  /** Out of every session, for extensions being turned off. Copies stay on disk. */
  detachAll() {
    for (const ext of this.list()) this.unloadEverywhere(ext.id);
  }
}

module.exports = {
  restrictAccess, siteHost,
  allowBridge, Extensions, readZip, crxZip, adaptManifest, adaptPage, isFirefox, iconOf, matchesPattern, crxKey, idFromKey, storeTarget, downloadFromStore, COMPAT_FILE };
