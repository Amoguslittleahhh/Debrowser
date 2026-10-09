/*
 * Debrowser's extension compatibility layer.
 *
 * Copied into every installed extension as `__debrowser_compat.js` and run
 * before the extension's own code: on its pages (popup, options, background
 * page), in its service worker, and with its content scripts. It fills in
 * what Electron's extension API lacks, so an extension that calls it starts
 * instead of stopping at the first missing name:
 *
 *  - `chrome.windows`: the one window, as Chrome would describe it.
 *  - `chrome.contextMenus`: accepted, never shown (Debrowser draws its own
 *    menus), so an extension that adds an item at start still starts.
 *  - `chrome.tabs.create`, `getCurrent` and `remove`: create opens a tab
 *    through the page's own window.open, which Debrowser turns into a tab.
 *  - `chrome.tabs.query` from a popup: Electron counts the popup itself as
 *    the active tab, so "the page I am on" was the popup. Debrowser writes
 *    the real one into `__debrowser_context.js` as it opens the popup.
 *  - Firefox's `browser.*`: the same API with promises, `menus` for
 *    `contextMenus`, and `onMessage` listeners that answer with a promise -
 *    installed over the `browser` newer Chromium has, which lacks all of
 *    the above.
 *
 * Plain script, no modules: it has to run in a page, a worker and a content
 * script alike. Kept small, and never touches anything that already exists.
 */
/* global location */
(() => {
  const g = globalThis;
  const c = g.chrome;
  if (!c || g.__debrowserCompat) return;
  g.__debrowserCompat = true;

  const extPage = typeof document !== 'undefined' && typeof location !== 'undefined' &&
    location.protocol === 'chrome-extension:';
  const event = () => {
    const ls = new Set();
    return {
      addListener: (f) => { ls.add(f); },
      removeListener: (f) => { ls.delete(f); },
      hasListener: (f) => ls.has(f),
      hasListeners: () => ls.size > 0
    };
  };
  // Answer as a promise, or through the callback if one was given.
  const answer = (promise, cb) => {
    if (typeof cb === 'function') { promise.then(cb, () => cb()); return undefined; }
    return promise;
  };
  // What could not be added in place - in a service worker the API objects
  // can refuse new keys - is served through a wrapper instead (below).
  const extra = new Map();
  const define = (obj, key, value) => {
    if (!obj || obj[key] !== undefined) return;
    try { obj[key] = value; } catch { /* refused: wrapped below */ }
    if (obj[key] === undefined) {
      if (!extra.has(obj)) extra.set(obj, {});
      extra.get(obj)[key] = value;
    }
  };

  if (c.extension && c.runtime && c.runtime.getURL) define(c.extension, 'getURL', (p) => c.runtime.getURL(p));

  const theWindow = () => ({ id: 1, focused: true, top: 0, left: 0, type: 'normal', state: 'normal',
    incognito: false, alwaysOnTop: false });
  define(c, 'windows', {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    get: (_id, _q, cb) => answer(Promise.resolve(theWindow()), [_q, cb].find((f) => typeof f === 'function')),
    getCurrent: (q, cb) => answer(Promise.resolve(theWindow()), typeof q === 'function' ? q : cb),
    getLastFocused: (q, cb) => answer(Promise.resolve(theWindow()), typeof q === 'function' ? q : cb),
    getAll: (q, cb) => answer(Promise.resolve([theWindow()]), typeof q === 'function' ? q : cb),
    create: (info, cb) => {
      const url = info && [].concat(info.url || [])[0];
      const p = url && c.tabs && c.tabs.create ? Promise.resolve(c.tabs.create({ url })).then(theWindow) : Promise.resolve(theWindow());
      return answer(p, cb);
    },
    update: (_id, _info, cb) => answer(Promise.resolve(theWindow()), cb),
    remove: (_id, cb) => answer(Promise.resolve(), cb),
    onCreated: event(), onRemoved: event(), onFocusChanged: event(), onBoundsChanged: event()
  });

  let menuId = 0;
  define(c, 'contextMenus', {
    create: (props, cb) => {
      if (typeof cb === 'function') setTimeout(cb, 0);
      return (props && props.id) || ++menuId;
    },
    update: (_id, _p, cb) => answer(Promise.resolve(), cb),
    remove: (_id, cb) => answer(Promise.resolve(), cb),
    removeAll: (cb) => answer(Promise.resolve(), cb),
    onClicked: event(),
    ContextType: {},
    ItemType: {}
  });

  // Permissions: everything the manifest asked for is granted at install, as
  // Chrome does for an extension from its store; optional ones are granted on
  // request rather than prompting, which this browser has no sheet for yet.
  const manifest = c.runtime && c.runtime.getManifest ? c.runtime.getManifest() : {};
  define(c, 'permissions', {
    contains: (_p, cb) => answer(Promise.resolve(true), cb),
    request: (_p, cb) => answer(Promise.resolve(true), cb),
    remove: (_p, cb) => answer(Promise.resolve(false), cb),
    getAll: (cb) => answer(Promise.resolve({
      permissions: [...(manifest.permissions || []), ...(manifest.optional_permissions || [])],
      origins: [...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])]
    }), cb),
    onAdded: event(), onRemoved: event()
  });
  // The toolbar API under both names: V2's browserAction and V3's action.
  if (c.action && !c.browserAction) define(c, 'browserAction', c.action);
  if (c.browserAction && !c.action) define(c, 'action', c.browserAction);

  if (c.tabs) {
    define(c.tabs, 'create', (props, cb) => {
      const base = typeof location !== 'undefined' ? location.href : undefined;
      const url = props && props.url ? new URL(props.url, base).href : 'about:blank';
      let p;
      if (typeof g.open === 'function') {
        g.open(url, '_blank');
        p = Promise.resolve({ id: -1, url, active: !(props && props.active === false), windowId: 1 });
      } else if (g.clients && g.clients.openWindow) {
        p = g.clients.openWindow(url).then(() => ({ id: -1, url, windowId: 1 }));
      } else {
        p = Promise.reject(new Error('tabs.create isn’t available here in Debrowser yet'));
      }
      return answer(p, cb);
    });
    define(c.tabs, 'getCurrent', (cb) => answer(Promise.resolve(undefined), cb));
    define(c.tabs, 'remove', (_ids, cb) =>
      answer(Promise.reject(new Error('tabs.remove isn’t available in Debrowser yet')), cb));

    // From the extension's own pages - its popup, and the background page
    // Debrowser hosts - "the active tab" is the page in front, which Debrowser
    // writes into __debrowserActiveTab; Electron would answer with the popup or
    // the background itself, which it counts as tabs.
    if (extPage && typeof c.tabs.query === 'function') {
      const real = c.tabs.query.bind(c.tabs);
      c.tabs.query = (q, cb) => {
        const want = { ...(q || {}) };
        for (const k of ['active', 'currentWindow', 'lastFocusedWindow', 'highlighted', 'windowId']) delete want[k];
        const p = new Promise((resolve) => real(want, resolve)).then((tabs) => {
          const own = (tabs || []).filter((t) => !String(t.url || '').startsWith(location.origin));
          const active = Number.isInteger(g.__debrowserActiveTab) ? g.__debrowserActiveTab
            : (own.find((t) => t.active) || {}).id;
          const pages = own.map((t) => ({ ...t, active: t.id === active, highlighted: t.id === active, windowId: 1 }));
          if (q && q.active === true) return pages.filter((t) => t.active);
          if (q && q.active === false) return pages.filter((t) => !t.active);
          return pages;
        });
        return answer(p, cb);
      };
    }
  }

  /*
   * The rest of Chrome's extension API that Electron does not have, as
   * stand-ins: a call settles with nothing, an event takes listeners and never
   * fires. An extension that registers a keyboard command or an alarm at
   * start then starts, with that one feature doing nothing, rather than
   * stopping at the first missing name. Only these names, so a check for
   * something that is not an extension API at all still finds nothing.
   */
  const NAMESPACES = ['alarms', 'bookmarks', 'browsingData', 'commands', 'contentSettings', 'cookies',
    'declarativeContent', 'declarativeNetRequest', 'downloads', 'fontSettings', 'history', 'identity', 'idle',
    'notifications', 'offscreen', 'omnibox', 'pageCapture', 'power', 'privacy', 'proxy', 'search', 'sessions',
    'sidePanel', 'tabGroups', 'topSites', 'tts', 'userScripts', 'webNavigation', 'webRequest'];
  const standIns = new Map();
  const standIn = (name) => {
    if (!standIns.has(name)) {
      const members = new Map();
      standIns.set(name, new Proxy({}, {
        get(_t, key) {
          if (typeof key !== 'string' || key === 'then') return undefined;
          if (!members.has(key)) {
            members.set(key, /^on[A-Z]/.test(key) ? event()
              : /^[A-Z_]+$/.test(key) ? {}
                : (...args) => answer(Promise.resolve(undefined), args.find((a) => typeof a === 'function')));
          }
          return members.get(key);
        }
      }));
    }
    return standIns.get(name);
  };

  // `chrome` itself becomes a wrapper serving what was refused in place and
  // the stand-ins, and `browser` (below) is built on it whether or not the
  // global could be replaced.
  let base = c;
  {
    const cover = (obj, top) => new Proxy(obj, {
      get: (t, p) => {
        const v = t[p];
        if (v !== undefined) return v && typeof v === 'object' && extra.has(v) ? cover(v, false) : v;
        if (extra.has(t) && p in extra.get(t)) return extra.get(t)[p];
        if (top && NAMESPACES.includes(p)) return standIn(p);
        return undefined;
      },
      has: (t, p) => p in t || (extra.has(t) && p in extra.get(t)) || (top && NAMESPACES.includes(p))
    });
    base = cover(c, true);
    try {
      Object.defineProperty(g, 'chrome', { value: base, configurable: true, writable: true });
    } catch {
      try { g.chrome = base; } catch { /* the extension sees Electron's chrome as it is */ }
    }
  }

  /*
   * Firefox's `browser`: every function returns a promise, settled from the
   * callback Chrome's takes. A few are synchronous in both and are passed
   * straight through; events are passed through too, except onMessage,
   * whose listeners may answer by returning a promise.
   */
  // Always ours, even where Chromium now has a `browser` of its own: that one
  // is a separate object without the additions above, and answers messages
  // differently from Firefox's.
  {
    const SYNC = new Set(['runtime.getURL', 'runtime.getManifest', 'runtime.connect', 'runtime.connectNative',
      'runtime.reload', 'extension.getURL', 'extension.getBackgroundPage', 'extension.getViews',
      'i18n.getMessage', 'i18n.getUILanguage', 'tabs.connect', 'contextMenus.create', 'menus.create']);
    const ALIAS = { menus: 'contextMenus', browserAction: 'action', pageAction: 'action' };
    const wrapped = new WeakMap();
    const messageListeners = new WeakMap();
    const wrapMessages = (ev) => ({
      addListener(fn) {
        const inner = (msg, sender, sendResponse) => {
          const r = fn(msg, sender, sendResponse);
          if (r === true) return true;
          if (r && typeof r.then === 'function') {
            r.then((v) => sendResponse(v), (e) => sendResponse({ __debrowserError: String(e && e.message || e) }));
            return true;
          }
          return undefined;
        };
        messageListeners.set(fn, inner);
        ev.addListener(inner);
      },
      removeListener(fn) { const inner = messageListeners.get(fn); if (inner) ev.removeListener(inner); },
      hasListener(fn) { return messageListeners.has(fn); }
    });
    const wrapFn = (fn, owner, path) => function (...args) {
      if (SYNC.has(path) || typeof args[args.length - 1] === 'function') return fn.apply(owner, args);
      return new Promise((resolve, reject) => {
        const done = (...res) => {
          const err = c.runtime && c.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(res.length > 1 ? res : res[0]);
        };
        try {
          const r = fn.apply(owner, [...args, done]);
          if (r && typeof r.then === 'function') r.then(resolve, reject);
        } catch {
          // Promise-only in this build: call it as such.
          try { Promise.resolve(fn.apply(owner, args)).then(resolve, reject); } catch (e2) { reject(e2); }
        }
      });
    };
    const wrap = (obj, path) => {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
      if (wrapped.has(obj)) return wrapped.get(obj);
      const proxy = new Proxy(obj, {
        get(target, prop) {
          let value = target[prop];
          if (value === undefined && typeof prop === 'string' && ALIAS[prop] && !path) value = target[ALIAS[prop]];
          const name = path ? `${path}.${String(prop)}` : String(prop);
          if (typeof value === 'function') return wrapFn(value, target, name);
          if (value && typeof value === 'object') {
            if (/(^|\.)on(Message|MessageExternal)$/.test(name)) return wrapMessages(value);
            if (typeof value.addListener === 'function') return value;
            return wrap(value, name);
          }
          return value;
        }
      });
      wrapped.set(obj, proxy);
      return proxy;
    };
    const ours = wrap(base, '');
    try {
      Object.defineProperty(g, 'browser', { value: ours, configurable: true, writable: true });
    } catch {
      try { g.browser = ours; } catch { /* Chromium's browser stays */ }
    }
  }
})();
