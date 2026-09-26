'use strict';

/**
 * User preferences, on disk.
 *
 * Kept deliberately small and boring. Every key has a default, an explicit
 * validator, and survives a file that has been hand-edited into nonsense - a
 * browser that refuses to start because its settings file has a stray comma is
 * a browser nobody can recover without a terminal.
 *
 * Lives in `userData`, which is the one directory an update does not touch. That
 * is the whole reason settings, session and (later) saved credentials go here
 * rather than beside the app: installing a new version replaces the program and
 * leaves this alone.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Every setting, with its default and what counts as a valid value.
 *
 * The validator is not decoration. These values reach the governor and the
 * Chromium command line, so "a number the user typed into a JSON file" is
 * untrusted input: a budget of `-1` or a string where a boolean belongs would
 * either crash a tick or silently disable a protection.
 */
/**
 * Tab strip colours that were offered once and are not any more, and what each
 * one became.
 *
 * Mapped rather than reset: someone who chose Plum wanted a purple strip, and
 * the honest answer is the purple that exists now, not the default. They are
 * still valid hex, so nothing else would have caught them - the swatch would
 * simply have shown nothing as chosen while the strip stayed the old colour.
 */
const RETIRED_STRIP_COLOURS = {
  '#1b2430': '#1b1f22',   // Slate  -> Graphite
  '#241c2e': '#1d1c22',   // Plum   -> Aubergine
  '#1a2622': '#171f1c',   // Pine
  '#2b2119': '#221c16',   // Umber
  '#2a1c22': '#231a1a'    // Wine   -> Oxblood
};

/** The zoom ladder, shared with main.js so a saved default is always a step. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** The range a saved budget may take; the task manager's slider clamps to it. */
const BUDGET_MB = { min: 256, max: 65536 };

const SCHEMA = {
  /* --- Personalisation ------------------------------------------- */
  theme:        { def: 'system', ok: (v) => ['system', 'dark', 'light'].includes(v) },

  /**
   * The look: shapes, neutrals and type. Colour stays the user's - the accent,
   * the strip colour and its translucency apply on top of every design, and
   * `theme` still picks light or dark within it.
   *
   * 'legacy' is how the browser looked up to 1.7, kept because a look someone
   * is used to is not something an update should take away.
   */
  design:       { def: 'ledger', ok: (v) => ['ledger', 'paper', 'grid', 'legacy'].includes(v) },
  // "Continue with these tabs" under the new tab page's search. Its own menu
  // turns it off; Settings turns it back on. Never shown in a private window,
  // which keeps no history for it to come from.
  continueCard: { def: true, ok: (v) => typeof v === 'boolean' },
  // Sites whose new tab tile the user took away. History forgets itself; a
  // bookmark does not, so without this a forgotten tile filled back in from
  // the bookmarks on the next new tab.
  hiddenTiles:  { def: [], ok: (v) => Array.isArray(v) && v.length <= 200 &&
                  v.every((o) => typeof o === 'string' && o.length < 300) },
  accent:       { def: '#2f857b', ok: (v) => /^#[0-9a-f]{6}$/i.test(v) },
  tabWidth:     { def: 'roomy',  ok: (v) => ['roomy', 'compact'].includes(v) },

  /**
   * The tab strip's colour, kept separate from the accent on purpose: the strip
   * is the largest painted area in the chrome, and the colour that works as a
   * 3px focus ring is rarely the one you want across the top of the window.
   * 'mirror' follows the accent for anyone who would rather not choose twice.
   */
  tabBarColor:  { def: 'default', ok: (v) => v === 'default' || v === 'mirror' || /^#[0-9a-f]{6}$/i.test(v) },

  /**
   * How opaque the tab strip is. The strip, and nothing else.
   *
   * It was `setOpacity` on the window once, and that comment outlived the
   * mechanism by several versions: fading the window fades the page text with
   * it, so a translucent browser was an unreadable one. The alpha is applied to
   * the one surface the user asked to see through - see `--strip-alpha` in
   * chrome.css - and pages stay fully opaque.
   *
   * Down to 40%, which is as far as the strip can go before the tab titles
   * stop being legible against a bright window behind them.
   */
  windowOpacity: { def: 1, ok: (v) => Number.isFinite(v) && v >= 0.4 && v <= 1 },


  /**
   * Where the tab strip lives.
   *
   * 'left' is the Arc/Zen shape: a column down the side, where a tab's title
   * has room to be read and thirty tabs do not shrink each other to a favicon.
   * It costs horizontal space, which is why it is not the default - most pages
   * are laid out for width, and most windows are wider than they are tall.
   */
  tabBarPosition: { def: 'top', ok: (v) => v === 'top' || v === 'left' },

  /**
   * Whether the side strip stays out, or slides away when the pointer leaves.
   *
   * Off by default, which is the Zen behaviour and the point of putting the
   * strip down the side at all: the page gets the whole window, and the tabs
   * are a pointer-flick away rather than a permanent 240px tax. Pinning is
   * there for anyone who would rather see them all the time, and the button
   * that does it sits at the bottom of the strip.
   *
   * Only meaningful with `tabBarPosition: 'left'`. Across the top there is
   * nothing to slide.
   */
  sidebarPinned: { def: false, ok: (v) => typeof v === 'boolean' },

  /**
   * Windows 11 only: let the OS paint its own blurred material behind the
   * window. Cheaper than doing it ourselves, because the compositor is already
   * blurring what is behind every other window on the system.
   */
  backgroundMaterial: { def: 'none', ok: (v) => ['none', 'acrylic', 'mica', 'tabbed'].includes(v) },
  /**
   * Stillness, on request. The OS setting is honoured regardless; this is for
   * anyone whose machine is not set that way but who wants nothing moving here.
   */
  reduceMotion: { def: false,    ok: (v) => typeof v === 'boolean' },

  showMemoryMeter: { def: true,  ok: (v) => typeof v === 'boolean' },
  showTierDots: { def: true,     ok: (v) => typeof v === 'boolean' },

  /* --- Browsing --------------------------------------------------- */
  searchEngine: { def: 'google', ok: (v) => Object.hasOwn(SEARCH_ENGINES, v) },
  homepage:     { def: '',       ok: (v) => typeof v === 'string' && v.length < 2048 },

  /**
   * Whether visited pages are written to the history list.
   *
   * On, because a browser that cannot answer "what was that page yesterday" is
   * missing something people rely on daily. Off stops recording immediately -
   * it is read on every visit rather than captured at startup - and leaves
   * whatever is already stored alone, because deleting the user's data is a
   * separate decision from not adding to it. The history page has the button
   * for that.
   */
  saveHistory:  { def: true,     ok: (v) => typeof v === 'boolean' },

  /**
   * Whether the tabs you had open come back when the browser starts.
   *
   * Off, as the owner asked: a browser that opens on whatever you were looking
   * at yesterday shows it to anyone at the screen. On, they come back
   * unrealised - a row in the strip and a saved address - so a restored
   * session costs about what one tab costs until you touch them.
   *
   * What comes back is the page, not the scroll position or anything typed into
   * it. That state is never written to disk on purpose; see session.js.
   *
   * Named afresh rather than `restoreSession` with a new default: every profile
   * saves every value, so an old profile would have kept its saved "on".
   */
  restoreTabs: { def: false, ok: (v) => typeof v === 'boolean' },

  /**
   * Where a bookmark opens when it is clicked.
   *
   * A new tab by default. Replacing the page in front of you is the other
   * reasonable answer - it is what a bookmarks bar did for twenty years - but
   * it throws away what you were reading, and the one thing you cannot get
   * back by clicking again is the page you just lost. Ctrl-click and the
   * middle button still mean "new tab" whichever way this is set, because
   * those two gestures mean that everywhere.
   */
  bookmarkOpensIn: { def: 'new-tab', ok: (v) => ['new-tab', 'current-tab'].includes(v) },

  // On wipes the list as the browser closes, which is the private-window
  // habit for someone who wants recording without a record of last week.
  clearHistoryOnExit: { def: false, ok: (v) => typeof v === 'boolean' },

  // A completion that is wrong more often than right for someone's habits is
  // worse than none: Enter takes the suggestion, not what was typed.
  inlineAutocomplete: { def: true, ok: (v) => typeof v === 'boolean' },

  /*
   * The page zoom a new page starts at, and where "reset zoom" returns to.
   * One of the steps the zoom shortcuts move between (`stepZoom` in main.js),
   * so the first Ctrl+plus lands on a step rather than between two.
   */
  defaultZoom: { def: 1, ok: (v) => ZOOM_STEPS.includes(v) },

  /* --- Tabs and windows ------------------------------------------- */

  // 'quit' is what every browser does; 'new-tab' keeps the window for
  // someone who closes tabs faster than they mean to close the browser.
  lastTabCloses: { def: 'quit', ok: (v) => ['quit', 'new-tab'].includes(v) },

  // On by default now that tabs are not reopened by default: closing a window
  // of twenty tabs by accident would otherwise lose all twenty.
  confirmCloseTabs: { def: true, ok: (v) => typeof v === 'boolean' },

  // Where a tab opened from a link lands. 'after-current' keeps a page's
  // spawned tabs beside it rather than at the far end of a long strip.
  newTabPosition: { def: 'after-current', ok: (v) => ['end', 'after-current'].includes(v) },

  // Links opened in a new tab stay behind the page you are reading by default,
  // which is also what keeps them unrealised and free until visited.
  linkTabsInBackground: { def: true, ok: (v) => typeof v === 'boolean' },

  // 'hover' keeps a narrow strip clean; 'always' is for anyone who aims for
  // the cross before the pointer is on the tab.
  tabCloseButton: { def: 'hover', ok: (v) => ['hover', 'always'].includes(v) },

  // Speculative realisation on a hover dwell costs a renderer the user may not
  // want, on a machine where memory is the point.
  hoverPrefetch: { def: true, ok: (v) => typeof v === 'boolean' },
  // Fetching the page behind a link the pointer rests on; see speculation.js.
  // Never in a private window, whatever this says.
  preloadPages: { def: true, ok: (v) => typeof v === 'boolean' },

  // Size, position and maximised state, put back on the next launch.
  rememberWindowBounds: { def: true, ok: (v) => typeof v === 'boolean' },

  /* --- Resources -------------------------------------------------- */
  // Null means "size this to the machine", which is different from any number
  // the user could pick, so it needs to be representable. It matters most for
  // the tab cap, where 0 is itself a meaningful choice: it removes the cap.
  memoryBudgetMB: { def: null,   ok: (v) => v === null || (Number.isFinite(v) && v >= BUDGET_MB.min && v <= BUDGET_MB.max) },
  maxLiveTabs:  { def: null,     ok: (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 200) },

  /**
   * Whether the task manager explains itself.
   *
   * Off by default. The panel is a live instrument - what each tab is holding
   * and why - and a wall of explanation beside a number you are trying to read
   * is noise. The explanations did not deserve deleting either, so they moved
   * here and appear on request.
   */
  showMemoryDetail: { def: false, ok: (v) => typeof v === 'boolean' },

  /**
   * Hardware acceleration. Off is a real diagnostic setting: a bad GPU driver
   * shows up as flicker, blank views or a crash on launch, and this is the
   * first thing to try. It cannot be applied live - Chromium decides at startup
   * - so the settings page says a restart is needed rather than pretending.
   */
  hardwareAcceleration: { def: true, ok: (v) => typeof v === 'boolean' },

  /**
   * Fill a saved password automatically when a page loads and exactly one
   * saved sign-in matches its origin.
   *
   * Passwords only, and that asymmetry is deliberate rather than unfinished:
   * a password is bound to an origin the user can see in the address bar, and
   * card numbers are bound to nothing, so a page can place a hidden payment
   * field and harvest whatever arrives in it. Payment details are filled only
   * on a click, always.
   */
  fillPasswords: { def: true, ok: (v) => typeof v === 'boolean' },

  /* --- Downloads -------------------------------------------------- */

  /**
   * How many connections a download may open at once.
   *
   * The IDM idea: ask for byte ranges in parallel rather than pulling one
   * stream end to end. It helps where a single connection is not the
   * bottleneck - a server shaping per-connection, a long fat path one TCP flow
   * never fills - and does nothing where it is. 1 turns it off.
   *
   * Four rather than eight or sixteen because past a handful the gain flattens
   * while the cost to the server does not, and a browser that opens sixteen
   * sockets per file is a browser that gets rate-limited.
   */
  downloadConnections: { def: 4, ok: (v) => Number.isInteger(v) && v >= 1 && v <= 16 },

  // Empty means the system's Downloads folder. Absolute only: a relative path
  // would resolve against wherever the browser happened to be launched from.
  downloadDir: { def: '', ok: (v) => typeof v === 'string' && v.length < 1024 &&
                                      (v === '' || path.isAbsolute(v)) },

  // Ask with a save dialog for every file instead of writing straight into
  // the folder above.
  askWhereToSave: { def: false, ok: (v) => typeof v === 'boolean' },

  /* --- Updates ---------------------------------------------------- */
  // Off means the browser never reaches the network to look for a version,
  // which is a privacy choice as much as a bandwidth one.
  autoUpdate:   { def: true,     ok: (v) => typeof v === 'boolean' },

  /* --- Developer tools -------------------------------------------- */
  // Where the inspector goes. `right` and `bottom` host it in a view of the
  // browser's own, beside or under the page; `window` hands it to Chromium to
  // put in a window of its own, which is what it used to do unconditionally.
  devToolsDock: { def: 'right',  ok: (v) => ['right', 'bottom', 'window'].includes(v) },

  /* --- Bookmarks --------------------------------------------------- */
  // The strip of saved sites under the toolbar. On by default, because a
  // bookmark you cannot see is a bookmark you will not use - and it costs the
  // content area 34px only while it is showing.
  showBookmarksBar: { def: true, ok: (v) => typeof v === 'boolean' },

  /* --- Private windows --------------------------------------------- */
  // Set here, in the ordinary browser, and read by the private window, which
  // never writes a preference itself. See src/main/incognito/.

  // Which of V8's compilers run. `balanced` drops only the optimising tiers,
  // which is where most V8 exploits land; `maximum` is the interpreter alone,
  // as GrapheneOS's browser does. Takes effect when a private window opens.
  incognitoJsLevel: { def: 'balanced', ok: (v) => ['maximum', 'balanced', 'full'].includes(v) },

  // How Tor connects: through built-in bridges, through your own, or plain.
  incognitoBridges: { def: 'auto', ok: (v) => ['auto', 'obfs4', 'custom', 'none'].includes(v) },
  incognitoBridgeLines: { def: '', ok: (v) => typeof v === 'string' && v.length <= 20_000 },

  // Keep Tor's entry guard and its copy of the network between sessions,
  // encrypted with the OS keystore. On: the same guard every time, as Tor is
  // designed to use, and a connection in seconds. Off: nothing about Tor is
  // left on this computer, at the cost of a new guard and a slower start.
  incognitoKeepTorState: { def: true, ok: (v) => typeof v === 'boolean' },

  // Go to a site's onion address whenever it advertises one.
  incognitoPreferOnion: { def: false, ok: (v) => typeof v === 'boolean' },

  // Load a decoy page alongside every real one, to blur what traffic analysis
  // can learn from timing and size. Costs about double the bandwidth.
  incognitoCamouflage: { def: false, ok: (v) => typeof v === 'boolean' },

  // Close every private window after this many minutes with no input. 0 is never.
  incognitoIdleWipeMinutes: { def: 0, ok: (v) => Number.isInteger(v) && v >= 0 && v <= 240 },
  incognitoKeepWarm: { def: false, ok: (v) => typeof v === 'boolean' },
  // Its own engine, and not Google's by default: a private window that sends
  // every search to the company that most wants to link them to you undoes
  // part of what Tor is for, and Google answers most Tor exits with a captcha.
  incognitoSearchEngine: { def: 'duckduckgo', ok: (v) => Object.hasOwn(SEARCH_ENGINES, v) }

  // Still nothing here for the resource profile: it decides Chromium switches
  // applied before the app starts, so it cannot take effect without a restart.
  // A settings page whose controls do nothing is worse than one that is short.
};

/** Search engines, as query templates. `%s` is the URL-encoded term. */
const SEARCH_ENGINES = {
  google:     { name: 'Google',     url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing:       { name: 'Bing',       url: 'https://www.bing.com/search?q=%s' },
  // One of the few engines with an index of its own rather than a reseller of
  // Google's or Bing's. Thinner on obscure queries, and that is the trade.
  mojeek:     { name: 'Mojeek',     url: 'https://www.mojeek.com/search?q=%s' },
  startpage:  { name: 'Startpage',  url: 'https://www.startpage.com/sp/search?query=%s' }
};

class Prefs {
  /**
   * @param {Function} log
   * @param {object} [options]
   * @param {string} [options.file]      - another profile's file, for incognito
   * @param {boolean} [options.readOnly] - changes last for this process only
   */
  constructor(log = () => {}, { file = null, readOnly = false } = {}) {
    this.log = log;
    this.file = file || path.join(app.getPath('userData'), 'preferences.json');
    this.readOnly = readOnly;
    this.values = this.load();
  }

  /** Defaults, overlaid with whatever of the file is valid. */
  load() {
    const values = {};
    for (const [key, spec] of Object.entries(SCHEMA)) values[key] = spec.def;

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      // A missing file is the ordinary first run. Anything else is worth one
      // line in the log, and then the defaults - never a failure to start.
      if (err.code !== 'ENOENT') this.log(`preferences unreadable, using defaults: ${err.message}`);
      return values;
    }

    if (!raw || typeof raw !== 'object') return values;

    for (const [key, value] of Object.entries(raw)) {
      const spec = SCHEMA[key];
      if (!spec) continue;                       // a key from a newer version
      // The palette moved, and a saved colour outlives it.
      //
      // `save()` writes every value, so any profile that has ever changed a
      // setting carries the old default on disk - and the old default is still
      // a valid `#rrggbb`, so it loads cleanly and the browser comes up in warm
      // neutral surfaces under a cornflower blue that is no longer offered in
      // Settings, with no swatch showing as chosen. A value the user picked
      // deliberately is left alone; only the ones that *were* our defaults move.
      // `String(value)`, because this runs over whatever is in the file. A
      // hand-edited `"accent": 12` would have thrown out of the constructor on
      // `.toLowerCase()`, and the constructor runs before the window exists -
      // so the browser would not start at all, which is the one outcome this
      // whole file is written to avoid.
      if (key === 'accent' && String(value).toLowerCase() === '#5b8cff') {
        this.log('accent was the old default; moving to the new one');
        continue;
      }
      if (key === 'tabBarColor' && RETIRED_STRIP_COLOURS[String(value).toLowerCase()]) {
        values[key] = RETIRED_STRIP_COLOURS[String(value).toLowerCase()];
        this.log(`tab strip colour ${value} was retired; using its replacement`);
        continue;
      }
      if (key === 'searchEngine' && value === 'brave') {
        // Brave was replaced by Mojeek. Without this the validator rejects the
        // stored value and silently resets the user to Google - their setting
        // changed on their behalf, explained only in a log line nobody reads.
        values[key] = 'mojeek';
        this.log('search engine "brave" is no longer offered; using Mojeek');
        continue;
      }
      if (!spec.ok(value)) {
        this.log(`preference "${key}" is not valid (${JSON.stringify(value)}); using the default`);
        continue;
      }
      values[key] = value;
    }
    return values;
  }

  get(key) { return this.values[key]; }
  all() { return { ...this.values }; }

  /**
   * Set one preference. Returns whether it was accepted, so the UI can tell
   * "rejected" from "applied and happened to look the same".
   */
  set(key, value) {
    const spec = SCHEMA[key];
    if (!spec || !spec.ok(value)) {
      this.log(`refusing preference "${key}" = ${JSON.stringify(value)}`);
      return false;
    }
    if (this.values[key] === value) return true;
    this.values[key] = value;
    this.save();
    return true;
  }

  /** Write atomically: a crash mid-write must not leave a truncated file. */
  save() {
    // Incognito reads the normal profile's settings and must never write to
    // it: a setting changed there lasts until the window closes.
    if (this.readOnly) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log(`could not save preferences: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    }
  }

  /**
   * The chosen engine's query template, for whoever decides that a piece of
   * omnibox input is a search.
   *
   * Deliberately *not* a resolveQuery() that also decides URL-vs-search:
   * `normaliseUrl` in main.js already makes that call, and it is the kind of
   * judgement that must be made in exactly one place or the address bar starts
   * disagreeing with itself about what a bare hostname means.
   */
  /**
   * The engines the settings page offers, by id and display name.
   *
   * Sent rather than hard-coded in the renderer so that adding an engine is one
   * entry in SEARCH_ENGINES above, and so a label can never end up attached to
   * a different engine's URL than the one it names.
   */
  engines() {
    return Object.entries(SEARCH_ENGINES).map(([id, { name }]) => ({ id, name }));
  }

  /** The engine this window searches with: a private window has its own. */
  engine() {
    const id = this.readOnly ? this.values.incognitoSearchEngine : this.values.searchEngine;
    return SEARCH_ENGINES[id] || SEARCH_ENGINES.google;
  }

  searchTemplate() {
    return this.engine().url;
  }

  /**
   * The chosen engine's name, for the one place a menu has to say it.
   *
   * "Search Google for …" is a promise about where the text is going, so it
   * comes from the same table the query template does rather than from a label
   * written beside it.
   */
  engineName() {
    return this.engine().name;
  }
}

module.exports = { Prefs, SCHEMA, SEARCH_ENGINES, ZOOM_STEPS, BUDGET_MB };

/**
 * Fold saved preferences into the runtime config.
 *
 * Three sources want to set the same two numbers, and the order matters:
 *
 *   1. a command-line flag, which wins outright - someone who launched with
 *      `--budget=1200` meant it for this run, and a stored preference quietly
 *      overriding it would make the flag look broken
 *   2. a saved preference
 *   3. the automatic value, sized to this machine
 *
 * `null` is the third case, and it must survive a round trip: clearing the field
 * in Settings has to go back to the machine-sized number, not leave whatever was
 * there before. That is why the automatic values are kept on `cfg` rather than
 * computed once at startup and forgotten - this runs again on every change.
 */
function applyPrefs(cfg, prefs, log = () => {}) {
  const pinned = cfg.pinned || {};
  const budget = prefs.get('memoryBudgetMB');
  const liveTabs = prefs.get('maxLiveTabs');

  if (!pinned.memoryBudgetMB) {
    cfg.memoryBudgetMB = budget != null ? budget : cfg.autoBudgetMB;
  }
  if (!pinned.maxLiveTabs) {
    cfg.maxLiveTabs = liveTabs != null ? liveTabs : cfg.autoLiveTabs;
  }

  log('prefs', `budget=${cfg.memoryBudgetMB}MB liveTabs=${cfg.maxLiveTabs} ` +
               `theme=${prefs.get('theme')} search=${prefs.get('searchEngine')}`);
}

module.exports.applyPrefs = applyPrefs;
