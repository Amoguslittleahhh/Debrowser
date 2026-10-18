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
 *  - Through the browser (debrowser://ext-bridge, or a worker's relay page):
 *    right-click items, alarms, notifications, tabs opened and closed,
 *    declarativeNetRequest, webRequest listeners, tabs and webNavigation
 *    events, the toolbar badge, and runtime.reload.
 *  - What Chrome has and Electron lacks, through the browser: the side panel
 *    (drawn beside the page), runtime.getContexts for it, identity's
 *    launchWebAuthFlow (signing in with the browsing session's cookies), the
 *    debugger on a tab, tabs.captureVisibleTab, and action.onClicked and the
 *    badge where Electron's own action has no toolbar behind it, and
 *    cookies, on the sites the extension may reach, and storage.sync (kept
 *    locally: there is no account to sync it with).
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
  // Events the browser sends only to extensions that listen (tabs.*,
  // webNavigation.*): the first listener says so (`events.listen`).
  const SUBSCRIBED = /^(tabs|webNavigation)\./;
  let callLater = null;
  const event = (name) => {
    const ls = new Set();
    let told = false;
    const ev = {
      addListener: (f) => {
        ls.add(f);
        if (name && !told && SUBSCRIBED.test(name)) {
          told = true;
          Promise.resolve().then(() => callLater && callLater('events.listen', { name })).catch(() => {});
        }
      },
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
    const had = obj[key];
    try { obj[key] = value; } catch { /* refused: wrapped below */ }
    if (obj[key] !== value) {
      if (!extra.has(obj)) extra.set(obj, {});
      extra.get(obj)[key] = value;
      // An event of Electron's that will not make way - in a service worker,
      // where the extension's code reaches it past the wrapper: its listeners
      // are added to ours as well, so what the browser fires reaches them.
      // Electron's own action.onClicked never fires; ours does.
      if (replace && had && typeof had.addListener === 'function' && value && typeof value.addListener === 'function') {
        try {
          const add = had.addListener.bind(had);
          const remove = had.removeListener.bind(had);
          had.addListener = (fn, ...rest) => { value.addListener(fn); return add(fn, ...rest); };
          had.removeListener = (fn) => { value.removeListener(fn); return remove(fn); };
        } catch { /* sealed: this one event stays Electron's */ }
      }
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
    const base = `debrowser://ext-bridge/?t=${encodeURIComponent(token)}&op=${encodeURIComponent(op)}`;
    const json = JSON.stringify(args === undefined ? null : args);
    // Small calls in the address; large ones - updateDynamicRules with
    // thousands of rules - as a body, past the length an address may have.
    // text/plain, so the request needs no preflight.
    const call = json.length < 8000
      ? fetch(`${base}&a=${encodeURIComponent(json)}`)
      : fetch(base, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: json });
    return call.then((r) => r.json()).then((r) => {
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
  callLater = call;
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
  // Restarting itself: Electron unloads the extension and never loads it
  // again, so the browser does both, as Chrome does. uBlock Origin restarts
  // once on its first run in a Chromium browser, on purpose.
  if (c.runtime && token) define(c.runtime, 'reload', () => { call('runtime.reload', {}).catch(() => {}); }, true);

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

  // Alarms, kept by the browser (extensions.js): one set for an hour from now
  // goes off then, even if this worker has stopped meanwhile - its arrival
  // starts it again.
  const onAlarm = event('alarms.onAlarm');
  define(c, 'alarms', {
    create: (name, info, cb) => {
      if (typeof name === 'object' && name !== null) { cb = info; info = name; name = ''; }
      return answer(call('alarms.create', { name: String(name || ''), info: info || {} }), cb);
    },
    get: (name, cb) => {
      if (typeof name === 'function') { cb = name; name = ''; }
      return answer(call('alarms.get', { name: String(name || '') }).then((a) => a || undefined), cb);
    },
    getAll: (cb) => answer(call('alarms.getAll', {}), cb),
    clear: (name, cb) => {
      if (typeof name === 'function') { cb = name; name = ''; }
      return answer(call('alarms.clear', { name: String(name || '') }), cb);
    },
    clearAll: (cb) => answer(call('alarms.clear', {}), cb),
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

  // Tab and navigation events, from the browser's own tabs.
  if (c.tabs) {
    for (const n of ['onCreated', 'onUpdated', 'onActivated', 'onRemoved', 'onReplaced', 'onMoved', 'onHighlighted',
      'onAttached', 'onDetached', 'onZoomChange']) define(c.tabs, n, event(`tabs.${n}`), true);
  }
  const navigation = {};
  for (const n of ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onErrorOccurred',
    'onCreatedNavigationTarget', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onTabReplaced']) {
    navigation[n] = event(`webNavigation.${n}`);
  }
  navigation.getFrame = (d, cb) => answer((c.tabs && c.tabs.get ? Promise.resolve(c.tabs.get(d.tabId)) : Promise.resolve(null))
    .then((t) => (t ? { frameId: d.frameId || 0, parentFrameId: d.frameId ? 0 : -1, url: t.url, errorOccurred: false } : null)), cb);
  navigation.getAllFrames = (d, cb) => answer((c.tabs && c.tabs.get ? Promise.resolve(c.tabs.get(d.tabId)) : Promise.resolve(null))
    .then((t) => (t ? [{ frameId: 0, parentFrameId: -1, url: t.url, errorOccurred: false }] : [])), cb);
  define(c, 'webNavigation', navigation, true);

  /*
   * webRequest: the extension's listeners on the request path. Adding one
   * tells the browser which requests it wants; the browser hands each over
   * (__debrowserWebRequest, or a message for a worker) and, for a blocking
   * listener in a background page, waits for the answer.
   */
  const wr = new Map();
  let wrCount = 0;
  const takes = (filter, d) => {
    if (filter && Array.isArray(filter.types) && filter.types.length && !filter.types.includes(d.type)) return false;
    return true;   // URL patterns are matched by the browser before it asks
  };
  const wrEvent = (name) => {
    const mine = new Map();
    return {
      addListener(fn, filter, extra) {
        const id = `w${++wrCount}`;
        mine.set(fn, id);
        wr.set(id, { fn, name, filter: filter || {} });
        call('webRequest.listen', { id, event: name, filter: filter || {}, extra: extra || [],
          blocking: Array.isArray(extra) && extra.includes('blocking') }).catch(() => {});
      },
      removeListener(fn) {
        const id = mine.get(fn);
        if (!id) return;
        mine.delete(fn);
        wr.delete(id);
        call('webRequest.unlisten', { id }).catch(() => {});
      },
      hasListener: (fn) => mine.has(fn),
      hasListeners: () => mine.size > 0
    };
  };
  const runRequest = async (name, details, ids) => {
    const out = {};
    for (const id of ids || []) {
      const l = wr.get(id);
      if (!l || l.name !== name || !takes(l.filter, details)) continue;
      let r;
      try { r = await l.fn({ ...details }); } catch (e) { console.error(e); }
      if (r && typeof r === 'object') {
        if (r.cancel) return { cancel: true };
        if (r.redirectUrl) out.redirectUrl = r.redirectUrl;
        if (r.requestHeaders) out.requestHeaders = r.requestHeaders;
        if (r.responseHeaders) out.responseHeaders = r.responseHeaders;
      }
    }
    return out;
  };
  g.__debrowserWebRequest = runRequest;
  event('webRequest.event').addListener((name, details, ids) => { runRequest(name, details, ids); });
  const webRequest = { MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
    handlerBehaviorChanged: (cb) => answer(Promise.resolve(), cb),
    OnBeforeRequestOptions: {}, OnBeforeSendHeadersOptions: {}, OnHeadersReceivedOptions: {}, ResourceType: {} };
  for (const n of ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired',
    'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']) webRequest[n] = wrEvent(n);
  define(c, 'webRequest', webRequest, true);

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
  // Where Electron has neither (a V2 background), Debrowser's: the badge text
  // goes beside the extension's name in the puzzle menu, a click on an
  // extension with no popup arrives as onClicked, and the rest - icon, title,
  // colours - is accepted.
  if (!c.action && !c.browserAction) {
    const badges = {};
    const later = (v) => (_d, cb) => answer(Promise.resolve(v), typeof _d === 'function' ? _d : cb);
    define(c, 'action', {
      setBadgeText: (d, cb) => {
        const text = String((d && d.text) || '');
        badges[(d && d.tabId) ?? 'all'] = text;
        return answer(call('action.badge', { text, tabId: d && d.tabId }).catch(() => {}), cb);
      },
      getBadgeText: (d, cb) => answer(Promise.resolve(badges[(d && d.tabId) ?? 'all'] || badges.all || ''), cb),
      setIcon: later(undefined), setTitle: later(undefined), getTitle: later(''),
      setBadgeBackgroundColor: later(undefined), getBadgeBackgroundColor: later([0, 0, 0, 0]),
      setBadgeTextColor: later(undefined), getBadgeTextColor: later([255, 255, 255, 255]),
      setPopup: later(undefined), getPopup: later(''), enable: later(undefined), disable: later(undefined),
      isEnabled: later(true), getUserSettings: later({ isOnToolbar: true }), openPopup: later(undefined),
      onClicked: event('action.onClicked')
    });
  }
  // Electron has an `action` of its own for a V3 extension, with no toolbar
  // behind it: its onClicked never fires, and its badge is drawn nowhere.
  // A click from the puzzle menu arrives as ours, and the badge is told to
  // the browser too - otherwise every V3 extension without a popup, Claude
  // among them, did nothing at all when chosen.
  else {
    const act = c.action || c.browserAction;
    define(act, 'onClicked', event('action.onClicked'), true);
    const nativeBadge = typeof act.setBadgeText === 'function' ? act.setBadgeText.bind(act) : null;
    define(act, 'setBadgeText', (d, cb) => {
      call('action.badge', { text: String((d && d.text) || ''), tabId: d && d.tabId }).catch(() => {});
      if (!nativeBadge) return answer(Promise.resolve(), cb);
      try { return nativeBadge(d, cb); } catch { return answer(Promise.resolve(), cb); }
    }, true);
  }
  if (c.action && !c.browserAction) define(c, 'browserAction', c.action);
  if (c.browserAction && !c.action) define(c, 'action', c.browserAction);
  if (c.action && !c.pageAction) define(c, 'pageAction', c.action);

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
   * The side panel: a page of the extension's beside the page in front,
   * drawn by Debrowser (window.js, extension panel). Its page is the
   * manifest's side_panel.default_path, or what setOptions last said - for
   * every tab, or for one (Claude gives each tab its own). open() shows it;
   * a click on the extension's button opens it too where setPanelBehavior
   * asked for that.
   */
  const panelCall = (op) => (arg, cb) => answer(call(`sidePanel.${op}`, typeof arg === 'function' ? {} : (arg || {})),
    typeof arg === 'function' ? arg : cb);
  define(c, 'sidePanel', {
    setOptions: panelCall('setOptions'),
    getOptions: panelCall('getOptions'),
    open: panelCall('open'),
    close: panelCall('close'),
    setPanelBehavior: panelCall('setPanelBehavior'),
    getPanelBehavior: panelCall('getPanelBehavior'),
    setLayout: (_o, cb) => answer(Promise.resolve(), cb),
    getLayout: (cb) => answer(Promise.resolve({ side: 'right' }), cb),
    onOpened: event('sidePanel.onOpened'),
    onClosed: event('sidePanel.onClosed'),
    Side: { LEFT: 'left', RIGHT: 'right' }
  });
  // Which of the extension's pages are open: asked by extensions that toggle
  // their side panel, as Claude does. Only the side panel is known here.
  if (c.runtime) {
    define(c.runtime, 'ContextType', { TAB: 'TAB', POPUP: 'POPUP', BACKGROUND: 'BACKGROUND',
      OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT', SIDE_PANEL: 'SIDE_PANEL', DEVELOPER_TOOLS: 'DEVELOPER_TOOLS' });
    define(c.runtime, 'getContexts', (filter, cb) => answer(call('runtime.getContexts', filter || {}).then((l) => l || []), cb));
  }

  /*
   * Signing in, as Chrome's identity API does it: the browser opens the
   * address with the browsing session's cookies - so a site already signed
   * in to answers at once, unseen - and hands back the address the sign-in
   * finally sends it to, https://<extension id>.chromiumapp.org/...
   * Interactive, it shows a window if the site asks for anything.
   */
  if (c.runtime) {
    const later = (v) => (...args) => answer(Promise.resolve(v), args.find((x) => typeof x === 'function'));
    define(c, 'identity', {
      getRedirectURL: (p) => `https://${c.runtime.id}.chromiumapp.org/${String(p || '').replace(/^\/+/, '')}`,
      launchWebAuthFlow: (details, cb) => answer(call('identity.launchWebAuthFlow', {
        url: String(details && details.url || ''),
        interactive: Boolean(details && details.interactive),
        timeout: Number(details && details.timeoutMsForNonInteractive) || 0
      }), cb),
      getAuthToken: later(undefined),
      removeCachedAuthToken: later(undefined),
      clearAllCachedAuthTokens: later(undefined),
      getProfileUserInfo: later({ email: '', id: '' }),
      getAccounts: later([]),
      onSignInChanged: event()
    });
  }

  /*
   * Native messaging: a program on the computer, through the browser, which
   * finds it as Chrome would (native-messaging.js). Each port's calls go in
   * order, so nothing posted is lost while the program starts.
   */
  if (c.runtime && token && (manifest.permissions || []).includes('nativeMessaging')) {
    const ports = new Map();
    event('native.onMessage').addListener((id, msg) => { const p = ports.get(id); if (p) p.onMessage.fire(msg, p); });
    event('native.onDisconnect').addListener((id, error) => {
      const p = ports.get(id);
      if (!p) return;
      ports.delete(id);
      if (error) p.error = { message: String(error) };
      p.onDisconnect.fire(p);
    });
    const portId = () => (g.crypto && g.crypto.randomUUID ? g.crypto.randomUUID() : String(Math.random()).slice(2));
    define(c.runtime, 'connectNative', (name) => {
      const id = portId();
      let queue = call('native.connect', { id, name: String(name) });
      const port = {
        name: String(name), sender: undefined, onMessage: event(), onDisconnect: event(),
        postMessage: (msg) => { queue = queue.then(() => call('native.post', { id, msg }), () => {}); },
        disconnect: () => { if (ports.delete(id)) queue = queue.then(() => call('native.disconnect', { id }), () => {}); }
      };
      ports.set(id, port);
      queue.catch((e) => {
        if (!ports.delete(id)) return;
        port.error = { message: String((e && e.message) || e) };
        port.onDisconnect.fire(port);
      });
      return port;
    }, true);
    define(c.runtime, 'sendNativeMessage', (name, msg, cb) => answer(call('native.send', { name: String(name), msg }), cb), true);
  }

  /*
   * The debugger: Chrome's DevTools protocol on a tab, for extensions that
   * declare the permission - Claude reads and operates pages through it. The
   * browser attaches to the tab and says so, as Chrome's bar across the top
   * does, while it is attached.
   */
  define(c, 'debugger', {
    attach: (target, version, cb) => answer(call('debugger.attach', { target, version }), cb),
    detach: (target, cb) => answer(call('debugger.detach', { target }), cb),
    sendCommand: (target, method, params, cb) => {
      if (typeof params === 'function') { cb = params; params = undefined; }
      return answer(call('debugger.sendCommand', { target, method, params: params || {} }), cb);
    },
    getTargets: (cb) => answer(call('debugger.getTargets', {}), cb),
    onEvent: event('debugger.onEvent'),
    onDetach: event('debugger.onDetach'),
    DetachReason: { CANCELED_BY_USER: 'canceled_by_user', TARGET_CLOSED: 'target_closed' },
    TargetInfoType: { PAGE: 'page', BACKGROUND_PAGE: 'background_page', WORKER: 'worker', OTHER: 'other' }
  });

  // A picture of the page in front, for extensions that look at it.
  if (c.tabs) {
    define(c.tabs, 'captureVisibleTab', (windowId, options, cb) => {
      if (typeof windowId === 'function') { cb = windowId; windowId = undefined; options = undefined; }
      if (typeof windowId === 'object' && windowId !== null) { cb = options; options = windowId; }
      if (typeof options === 'function') { cb = options; options = undefined; }
      return answer(call('tabs.captureVisibleTab', options || {}), cb);
    });
  }

  // storage.sync: Electron's answers every call with "not available", and
  // Dark Reader and others keep their settings there - they read null and stop. There is no
  // account to sync with, so it is local storage under Chrome's sync limits,
  // as Chrome itself has it when signed out.
  if (c.storage && c.storage.local) {
    const local = c.storage.local;
    define(c.storage, 'sync', {
      get: (...a) => local.get(...a),
      set: (...a) => local.set(...a),
      remove: (...a) => local.remove(...a),
      clear: (...a) => local.clear(...a),
      getBytesInUse: (...a) => (local.getBytesInUse ? local.getBytesInUse(...a) : answer(Promise.resolve(0), a.find((x) => typeof x === 'function'))),
      setAccessLevel: (d, cb) => answer(Promise.resolve(), cb),
      onChanged: local.onChanged || event('storage.sync.onChanged'),
      QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512,
      MAX_WRITE_OPERATIONS_PER_HOUR: 1800, MAX_WRITE_OPERATIONS_PER_MINUTE: 120
    }, true);
  }

  // storage.session in a background page: Firefox has it in every version of
  // the manifest, Chromium only in V3, and Ghostery stopped without it. Kept
  // in this page's memory, which for a background page is what "session" means.
  if (c.storage && !c.storage.session) {
    const data = new Map();
    const changed = event('storage.session.onChanged');
    const pick = (keys) => (keys === null || keys === undefined ? [...data.keys()]
      : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys));
    const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
    define(c.storage, 'session', {
      get: (keys, cb) => {
        if (typeof keys === 'function') { cb = keys; keys = null; }
        const out = keys && typeof keys === 'object' && !Array.isArray(keys) ? { ...keys } : {};
        for (const k of pick(keys)) if (data.has(k)) out[k] = clone(data.get(k));
        return answer(Promise.resolve(out), cb);
      },
      set: (items, cb) => {
        for (const [k, v] of Object.entries(items || {})) data.set(k, clone(v));
        return answer(Promise.resolve(), cb);
      },
      remove: (keys, cb) => { for (const k of pick(keys)) data.delete(k); return answer(Promise.resolve(), cb); },
      clear: (cb) => { data.clear(); return answer(Promise.resolve(), cb); },
      getBytesInUse: (keys, cb) => answer(Promise.resolve(0), typeof keys === 'function' ? keys : cb),
      setAccessLevel: (d, cb) => answer(Promise.resolve(), cb),
      onChanged: changed,
      QUOTA_BYTES: 10485760
    }, true);
  }

  // scripting in a V2 background page: Firefox has it there, Chromium only in
  // V3. Built on tabs.executeScript and insertCSS, which V2 does have.
  if (!c.scripting && c.tabs && typeof c.tabs.executeScript === 'function') {
    const run = (tabId, details) => new Promise((resolve, reject) => {
      c.tabs.executeScript(tabId, details, (res) => {
        const err = c.runtime && c.runtime.lastError;
        if (err) reject(new Error(err.message)); else resolve(res || []);
      });
    });
    const css = (method, tabId, details) => new Promise((resolve, reject) => {
      if (typeof c.tabs[method] !== 'function') { resolve(); return; }
      c.tabs[method](tabId, details, () => {
        const err = c.runtime && c.runtime.lastError;
        if (err) reject(new Error(err.message)); else resolve();
      });
    });
    const each = async (inj, fn) => {
      const target = inj.target || {};
      const base = { allFrames: Boolean(target.allFrames), ...(Array.isArray(target.frameIds) && target.frameIds.length === 1 ? { frameId: target.frameIds[0] } : {}) };
      if (Array.isArray(inj.files) && inj.files.length) {
        let last = [];
        for (const file of inj.files) last = await fn(target.tabId, { ...base, file });
        return last;
      }
      return fn(target.tabId, base);
    };
    define(c, 'scripting', {
      executeScript: (inj, cb) => answer(each(inj || {}, (tabId, d) => run(tabId, d.file ? d
        : { ...d, code: `(${String(inj.func || inj.function)})(...${JSON.stringify(inj.args || [])})` }))
        .then((res) => (res || []).map((result, i) => ({ frameId: i, result }))), cb),
      insertCSS: (inj, cb) => answer(each(inj || {}, (tabId, d) => css('insertCSS', tabId, d.file ? d : { ...d, code: String(inj.css || '') })), cb),
      removeCSS: (inj, cb) => answer(each(inj || {}, (tabId, d) => css('removeCSS', tabId, d.file ? d : { ...d, code: String(inj.css || '') })), cb),
      ExecutionWorld: { ISOLATED: 'ISOLATED', MAIN: 'MAIN' }
    }, true);
  }
  if (c.extension) {
    define(c.extension, 'isAllowedIncognitoAccess', (cb) => answer(Promise.resolve(false), cb));
    define(c.extension, 'isAllowedFileSchemeAccess', (cb) => answer(Promise.resolve(false), cb));
  }

  // storage.managed: settings an administrator set by policy. Electron's
  // answers every call with "not available"; there is no policy here, so it
  // is empty, which is what Chrome says on a computer without one.
  if (c.storage) {
    define(c.storage, 'managed', {
      get: (keys, cb) => answer(Promise.resolve({}), typeof keys === 'function' ? keys : cb),
      getBytesInUse: (keys, cb) => answer(Promise.resolve(0), typeof keys === 'function' ? keys : cb),
      onChanged: event('storage.managed.onChanged')
    }, true);
  }

  // Registered content scripts, which Electron's scripting lacks: none are
  // registered, and registering one is accepted, so an extension that reads
  // or sets them at start goes on starting.
  if (c.scripting) {
    define(c.scripting, 'getRegisteredContentScripts', (f, cb) =>
      answer(Promise.resolve([]), typeof f === 'function' ? f : cb));
    for (const n of ['registerContentScripts', 'unregisterContentScripts', 'updateContentScripts']) {
      define(c.scripting, n, (d, cb) => answer(Promise.resolve(), typeof d === 'function' ? d : cb));
    }
  }

  // Message names as installed: anything but letters, digits and "_" became
  // "_" (extensions.js, adaptMessages), so Firefox's "moz-vpn-connected" is
  // found again under the name it was stored as.
  if (c.i18n && typeof c.i18n.getMessage === 'function') {
    const getMessage = c.i18n.getMessage.bind(c.i18n);
    define(c.i18n, 'getMessage', (name, ...rest) => getMessage(String(name).replace(/[^A-Za-z0-9_@]/g, '_'), ...rest), true);
  }

  // The browsing session's cookies, for an extension that asked for them and
  // only on the sites it may reach: password managers, coupon finders and
  // screen recorders read their own site's sign-in this way. Its own pages
  // and worker only, as in Chrome; content scripts have no chrome.cookies.
  if (extPage || isWorker) {
    define(c, 'cookies', {
      get: (d, cb) => answer(call('cookies.get', d || {}), cb),
      getAll: (d, cb) => answer(call('cookies.getAll', d || {}).then((v) => v || []), cb),
      set: (d, cb) => answer(call('cookies.set', d || {}), cb),
      remove: (d, cb) => answer(call('cookies.remove', d || {}), cb),
      getAllCookieStores: (cb) => answer(Promise.resolve([{ id: '0', tabIds: [] }]), cb),
      onChanged: event('cookies.onChanged'),
      OnChangedCause: { EVICTED: 'evicted', EXPIRED: 'expired', EXPLICIT: 'explicit', EXPIRED_OVERWRITE: 'expired_overwrite', OVERWRITE: 'overwrite' },
      SameSiteStatus: { NO_RESTRICTION: 'no_restriction', LAX: 'lax', STRICT: 'strict', UNSPECIFIED: 'unspecified' }
    }, true);
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
    'declarativeContent', 'downloads', 'fontSettings', 'history', 'idle', 'offscreen', 'omnibox', 'pageCapture', 'power', 'privacy', 'proxy', 'search', 'sessions',
    'tabGroups', 'topSites', 'tts', 'userScripts'];
  const standIns = new Map();
  const isStandIn = new WeakSet();
  // Any depth: privacy.network.networkPredictionEnabled.set(...) is a chain
  // of members, each callable. A setting's get answers as Chrome's does, with
  // a value no extension controls.
  const member = (path) => {
    if (standIns.has(path)) return standIns.get(path);
    const leaf = path.split('.').pop();
    const fn = function standInCall(...args) {
      const value = leaf === 'get' ? { value: undefined, levelOfControl: 'not_controllable' } : undefined;
      return answer(Promise.resolve(value), args.find((x) => typeof x === 'function'));
    };
    const proxy = new Proxy(fn, {
      get(_t, key) {
        if (typeof key !== 'string' || key === 'then') return undefined;
        if (/^on[A-Z]/.test(key)) {
          const name = `${path}.${key}`;
          if (!standIns.has(name)) standIns.set(name, event(name));
          return standIns.get(name);
        }
        if (/^[A-Z_]+$/.test(key)) return {};
        return member(`${path}.${key}`);
      }
    });
    standIns.set(path, proxy);
    isStandIn.add(proxy);
    return proxy;
  };
  const standIn = (name) => member(name);

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
          // Stand-ins already answer with promises, and carry their events.
          if (isStandIn.has(value)) return value;
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
