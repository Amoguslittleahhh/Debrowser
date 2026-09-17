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
const SCHEMA = {
  /* --- Personalisation ------------------------------------------- */
  theme:        { def: 'system', ok: (v) => ['system', 'dark', 'light'].includes(v) },
  accent:       { def: '#5b8cff', ok: (v) => /^#[0-9a-f]{6}$/i.test(v) },
  tabWidth:     { def: 'roomy',  ok: (v) => ['roomy', 'compact'].includes(v) },

  /**
   * The tab strip's colour, kept separate from the accent on purpose: the strip
   * is the largest painted area in the chrome, and the colour that works as a
   * 3px focus ring is rarely the one you want across the top of the window.
   * 'mirror' follows the accent for anyone who would rather not choose twice.
   */
  tabBarColor:  { def: 'default', ok: (v) => v === 'default' || v === 'mirror' || /^#[0-9a-f]{6}$/i.test(v) },

  /**
   * Window translucency, as plain opacity.
   *
   * Deliberately the cheap mechanism. Real per-element transparency needs a
   * transparent window, which forces the whole surface through the compositor
   * with an alpha channel and costs GPU memory on every frame. `setOpacity` is
   * a property of the window the OS compositor already draws, so it is close to
   * free - which is what was asked for.
   */
  windowOpacity: { def: 1, ok: (v) => Number.isFinite(v) && v >= 0.6 && v <= 1 },

  /**
   * Ask for a fingerprint, face or PIN before a saved secret is shown or filled.
   *
   * Off by default, and that is not timidity: the check is only as good as the
   * machine's support for it, and turning it on where nothing can satisfy it
   * would lock the user out of their own passwords. Settings turns it on only
   * where `presence.capability()` reports something usable.
   */
  requirePresence: { def: false, ok: (v) => typeof v === 'boolean' },

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

  /* --- Resources -------------------------------------------------- */
  // Null means "size this to the machine", which is different from any number
  // the user could pick, so it needs to be representable. It matters most for
  // the tab cap, where 0 is itself a meaningful choice: it removes the cap.
  memoryBudgetMB: { def: null,   ok: (v) => v === null || (Number.isFinite(v) && v >= 256 && v <= 65536) },
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

  /* --- Updates ---------------------------------------------------- */
  // Off means the browser never reaches the network to look for a version,
  // which is a privacy choice as much as a bandwidth one.
  autoUpdate:   { def: true,     ok: (v) => typeof v === 'boolean' }

  // Still nothing here for session restore or the resource profile: the first
  // is not built, and the second cannot take effect without a restart, since a
  // profile decides Chromium switches applied before the app starts. A settings
  // page whose controls do nothing is worse than one that is short.
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
  constructor(log = () => {}) {
    this.log = log;
    this.file = path.join(app.getPath('userData'), 'preferences.json');
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

  searchTemplate() {
    return (SEARCH_ENGINES[this.values.searchEngine] || SEARCH_ENGINES.google).url;
  }
}

module.exports = { Prefs, SCHEMA, SEARCH_ENGINES };

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
