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
  // Events this layer fires itself, by name ("contextMenus.onClicked"), from
  // the browser (through the relay page, extensions.js `dispatch`) or from
  // its own timers.
  const named = new Map();
  const event = (name) => {
    const ls = new Set();
    const ev = {
      addListener: (f) => { ls.add(f); },
      removeListener: (f) => { ls.delete(f); },
      hasListener: (f) => ls.has(f),
      hasListeners: () => ls.size > 0,
      fire: (...args) => { for (const f of [...ls]) { try { f(...args); } catch (e) { console.error(e); } } }
    };
    if (name) named.set(name, ev);
    return ev;
  };
  const fire = (msg) => {
    const ev = msg && named.get(msg.__debrowserEvent);
    if (ev) ev.fire(...(msg.args || []));
  };
  g.__debrowserFire = fire;
  // Answer as a promise, or through the callback if one was given.
  const answer = (promise, cb) => {
    if (typeof cb === 'function') { promise.then(cb, () => cb()); return undefined; }
    return promise;
  };
  // What could not be added in place - in a service worker the API objects
  // can refuse new keys - is served through a wrapper instead (below).
  const extra = new Map();
  // `replace` for the few Electron has but does not run (alarms that never
  // go off, request rules nobody enforces): ours, whatever is there.
  const define = (obj, key, value, replace = false) => {
    if (!obj || (obj[key] !== undefined && !replace)) return;
    if (replace && obj[key] !== undefined) {
      try { Object.defineProperty(obj, key, { value, configurable: true, writable: true }); } catch { /* below */ }
      if (obj[key] === value) return;
    }
    try { obj[key] = value; } catch { /* refused: wrapped below */ }
    if (obj[key] !== value) {
      if (!extra.has(obj)) extra.set(obj, {});
      extra.get(obj)[key] = value;
    }
  };

  /*
   * The bridge to the browser: a call to debrowser://ext-bridge carrying this
   * extension's token, which only its own pages and worker are given. Where
   * there is no token - a content script - the calls that need it say so.
   */
  const token = g.__debrowserExt && g.__debrowserExt.token;
  const fetchBridge = (op, args) => {
    if (!token) return Promise.reject(new Error(`${op} isn’t available from here in Debrowser`));
    const url = `debrowser://ext-bridge/?t=${encodeURIComponent(token)}&op=${encodeURIComponent(op)}` +
      `&a=${encodeURIComponent(JSON.stringify(args === undefined ? null : args))}`;
    return fetch(url).then((r) => r.json()).then((r) => {
      if (r && r.error) throw new Error(r.error);
      return r ? r.value : undefined;
    });
  };
  // A service worker's requests never reach the browser's own scheme, so it
  // asks the extension's relay page (debrowser-relay.html), which makes the
  // call for it - retrying while the relay is still loading.
  const isWorker = typeof document === 'undefined' && typeof importScripts === 'function';
  const viaRelay = (op, args) => new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      try {
        c.runtime.sendMessage({ __debrowserCall: op, args }, (res) => {
          const err = c.runtime.lastError;
          if (err || res === undefined) {
            if (++tries < 30) { setTimeout(attempt, 200); return; }
            reject(new Error(err ? err.message : `${op} got no answer`));
            return;
          }
          if (res && res.error) reject(new Error(res.error));
          else resolve(res ? res.value : undefined);
        });
      } catch (e) { reject(e); }
    };
    attempt();
  });
  const call = isWorker ? viaRelay : fetchBridge;
  const isRelay = typeof location !== 'undefined' && location.pathname === '/debrowser-relay.html';
  // The browser's events arrive as runtime messages; the extension's own
  // onMessage listeners never see them.
  if (c.runtime && c.runtime.onMessage) {
    const om = c.runtime.onMessage;
    const addListener = om.addListener.bind(om);
    const removeListener = om.removeListener.bind(om);
    const inner = new WeakMap();
    try {
      om.addListener = (fn) => {
        const f = (msg, ...rest) => (msg && (msg.__debrowserEvent || msg.__debrowserCall) ? undefined : fn(msg, ...rest));
        inner.set(fn, f);
        addListener(f);
      };
      om.removeListener = (fn) => removeListener(inner.get(fn) || fn);
    } catch { /* read-only: the extension sees the event messages too */ }
    addListener((msg, _sender, sendResponse) => {
      if (msg && msg.__debrowserEvent) fire(msg);
      // The relay page answers the worker's calls.
      if (isRelay && msg && msg.__debrowserCall) {
        fetchBridge(msg.__debrowserCall, msg.args)
          .then((value) => sendResponse({ value }), (e) => sendResponse({ error: String(e && e.message || e) }));
        return true;
      }
      return undefined;
    });
  }

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

  // Right-click menu items: shown in Debrowser's own menu, after its items.
  let menuCount = 0;
  const onclicks = new Map();
  const menusClicked = event('contextMenus.onClicked');
  menusClicked.addListener((info, tab) => {
    const f = onclicks.get(String(info && info.menuItemId));
    if (f) f(info, tab);
  });
  const plain = (props) => {
    const out = {};
    for (const [k, v] of Object.entries(props || {})) if (typeof v !== 'function') out[k] = v;
    return out;
  };
  define(c, 'contextMenus', {
    create: (props, cb) => {
      const id = props && props.id !== undefined ? props.id : `m${++menuCount}`;
      if (props && typeof props.onclick === 'function') onclicks.set(String(id), props.onclick);
      call('menus.create', { ...plain(props), id }).then(() => cb && cb(), () => cb && cb());
      return id;
    },
    update: (id, props, cb) => {
      if (props && typeof props.onclick === 'function') onclicks.set(String(id), props.onclick);
      return answer(call('menus.update', { id, props: plain(props) }), cb);
    },
    remove: (id, cb) => { onclicks.delete(String(id)); return answer(call('menus.remove', { id }), cb); },
    removeAll: (cb) => { onclicks.clear(); return answer(call('menus.removeAll', {}), cb); },
    onClicked: menusClicked,
    ContextType: {}, ItemType: {}
  });

  // Alarms, on this page's own timers - for a service worker, while it runs.
  const alarms = new Map();
  const onAlarm = event('alarms.onAlarm');
  define(c, 'alarms', {
    create: (name, info, cb) => {
      if (typeof name === 'object') { cb = info; info = name; name = ''; }
      name = String(name || '');
      info = info || {};
      const had = alarms.get(name);
      if (had) { clearTimeout(had.timer); clearInterval(had.repeat); }
      const delay = info.when ? Math.max(0, info.when - Date.now())
        : Math.max(0, (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000);
      const alarm = { name, scheduledTime: Date.now() + delay, periodInMinutes: info.periodInMinutes };
      alarm.timer = setTimeout(() => {
        onAlarm.fire({ name, scheduledTime: alarm.scheduledTime, periodInMinutes: alarm.periodInMinutes });
        if (alarm.periodInMinutes) {
          alarm.repeat = setInterval(() => {
            alarm.scheduledTime = Date.now();
            onAlarm.fire({ name, scheduledTime: alarm.scheduledTime, periodInMinutes: alarm.periodInMinutes });
          }, alarm.periodInMinutes * 60000);
        } else {
          alarms.delete(name);
        }
      }, delay);
      alarms.set(name, alarm);
      return answer(Promise.resolve(), cb);
    },
    get: (name, cb) => {
      if (typeof name === 'function') { cb = name; name = ''; }
      const a = alarms.get(String(name || ''));
      return answer(Promise.resolve(a ? { name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes } : undefined), cb);
    },
    getAll: (cb) => answer(Promise.resolve([...alarms.values()].map((a) =>
      ({ name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes }))), cb),
    clear: (name, cb) => {
      if (typeof name === 'function') { cb = name; name = ''; }
      const a = alarms.get(String(name || ''));
      if (a) { clearTimeout(a.timer); clearInterval(a.repeat); alarms.delete(a.name); }
      return answer(Promise.resolve(Boolean(a)), cb);
    },
    clearAll: (cb) => {
      for (const a of alarms.values()) { clearTimeout(a.timer); clearInterval(a.repeat); }
      alarms.clear();
      return answer(Promise.resolve(true), cb);
    },
    onAlarm
  }, true);

  // Notifications: the system's own, shown by the browser.
  define(c, 'notifications', {
    create: (id, options, cb) => {
      if (typeof id === 'object') { cb = options; options = id; id = undefined; }
      return answer(call('notifications.create', { id, options }), cb);
    },
    clear: (_id, cb) => answer(Promise.resolve(true), cb),
    update: (_id, _o, cb) => answer(Promise.resolve(false), cb),
    getAll: (cb) => answer(Promise.resolve({}), cb),
    getPermissionLevel: (cb) => answer(Promise.resolve('granted'), cb),
    onClicked: event('notifications.onClicked'), onClosed: event('notifications.onClosed'),
    onButtonClicked: event('notifications.onButtonClicked'), TemplateType: { BASIC: 'basic', IMAGE: 'image', LIST: 'list', PROGRESS: 'progress' }
  });

  // Request rules: run by Debrowser (extension-dnr.js).
  const dnr = (op) => (arg, cb) => answer(call(`dnr.${op}`, typeof arg === 'function' ? {} : (arg || {})),
    typeof arg === 'function' ? arg : cb);
  define(c, 'declarativeNetRequest', {
    updateDynamicRules: dnr('updateDynamicRules'), getDynamicRules: dnr('getDynamicRules'),
    updateSessionRules: dnr('updateSessionRules'), getSessionRules: dnr('getSessionRules'),
    updateEnabledRulesets: dnr('updateEnabledRulesets'), getEnabledRulesets: dnr('getEnabledRulesets'),
    updateStaticRules: dnr('updateStaticRules'), getDisabledRuleIds: dnr('getDisabledRuleIds'),
    getAvailableStaticRuleCount: dnr('getAvailableStaticRuleCount'),
    isRegexSupported: (o, cb) => {
      let ok = true;
      try { new RegExp(o && o.regex); } catch { ok = false; }
      return answer(Promise.resolve(ok ? { isSupported: true } : { isSupported: false, reason: 'syntaxError' }), cb);
    },
    getMatchedRules: (_f, cb) => answer(Promise.resolve({ rulesMatchedInfo: [] }), typeof _f === 'function' ? _f : cb),
    testMatchOutcome: (_r, cb) => answer(Promise.resolve({ matchedRules: [] }), cb),
    setExtensionActionOptions: (_o, cb) => answer(Promise.resolve(), cb),
    onRuleMatchedDebug: event(),
    MAX_NUMBER_OF_REGEX_RULES: 1000, MAX_NUMBER_OF_DYNAMIC_RULES: 30000, MAX_NUMBER_OF_SESSION_RULES: 5000,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000, MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50, MAX_NUMBER_OF_STATIC_RULESETS: 100,
    GUARANTEED_MINIMUM_STATIC_RULES: 30000, DYNAMIC_RULESET_ID: '_dynamic', SESSION_RULESET_ID: '_session',
    RuleActionType: { BLOCK: 'block', REDIRECT: 'redirect', ALLOW: 'allow', UPGRADE_SCHEME: 'upgradeScheme',
      MODIFY_HEADERS: 'modifyHeaders', ALLOW_ALL_REQUESTS: 'allowAllRequests' },
    ResourceType: {}, RequestMethod: {}, DomainType: { FIRST_PARTY: 'firstParty', THIRD_PARTY: 'thirdParty' },
    HeaderOperation: { APPEND: 'append', SET: 'set', REMOVE: 'remove' }
  }, true);

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
    // Opened and closed by the browser, from anywhere the extension runs -
    // its background included, which has no window.open.
    define(c.tabs, 'create', (props, cb) => {
      const base = typeof location !== 'undefined' ? location.href : undefined;
      const url = props && props.url ? new URL(props.url, base).href : 'about:blank';
      const viaBridge = call('tabs.create', { url, active: !(props && props.active === false) })
        .then((t) => ({ ...t, windowId: 1, index: 0, pinned: false, highlighted: Boolean(t && t.active), incognito: false }));
      const p = token ? viaBridge : typeof g.open === 'function'
        ? Promise.resolve(g.open(url, '_blank')).then(() => ({ id: -1, url, windowId: 1 }))
        : viaBridge;
      return answer(p, cb);
    });
    define(c.tabs, 'getCurrent', (cb) => answer(Promise.resolve(undefined), cb));
    define(c.tabs, 'remove', (ids, cb) => answer(call('tabs.remove', { ids: [].concat(ids) }), cb));

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
  const NAMESPACES = ['bookmarks', 'browsingData', 'commands', 'contentSettings', 'cookies',
    'declarativeContent', 'downloads', 'fontSettings', 'history', 'identity', 'idle', 'offscreen', 'omnibox', 'pageCapture', 'power', 'privacy', 'proxy', 'search', 'sessions',
    'sidePanel', 'tabGroups', 'topSites', 'tts', 'userScripts', 'webNavigation', 'webRequest'];
  const standIns = new Map();
  const standIn = (name) => {
    if (!standIns.has(name)) {
      const members = new Map();
      standIns.set(name, new Proxy({}, {
        get(_t, key) {
          if (typeof key !== 'string' || key === 'then') return undefined;
          if (!members.has(key)) {
            members.set(key, /^on[A-Z]/.test(key) ? event(`${name}.${key}`)
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
        if (extra.has(t) && p in extra.get(t)) return extra.get(t)[p];
        const v = t[p];
        if (v !== undefined) return v && typeof v === 'object' && extra.has(v) ? cover(v, false) : v;
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
