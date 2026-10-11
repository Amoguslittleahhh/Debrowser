'use strict';

/**
 * The tabs you had open, kept across a restart.
 *
 * This browser's whole argument is that a tab should be cheap enough to leave
 * open - and until now it closed with twenty of them and remembered none. That
 * is the one gap that sends somebody back to the browser they came from, and it
 * is worse here than elsewhere precisely because the rest of the design invites
 * you to keep tabs rather than close them.
 *
 * ## What is stored, and what deliberately is not
 *
 * An address, a title and whether the tab was pinned. Nothing else.
 *
 * Not the page state - the scroll position and unsubmitted input a discarded
 * tab keeps in memory. That store is explicitly never written to disk: it can
 * hold whatever was typed into a form, and `probe-preload.js` already refuses
 * to read password and payment fields into it for exactly that reason. Keeping
 * it in memory is a decision, and writing it out here would quietly undo it.
 *
 * Not thumbnails either. They live in the OS temp directory and are swept on
 * startup and on quit, because a picture of a logged-in page is the thing this
 * browser refuses to leave lying around.
 *
 * So a restored tab is the page you were on, not the exact pixel you were at.
 * That is the honest trade and it is the one every browser makes for a
 * *discarded* tab anyway.
 *
 * ## Restoring costs almost nothing
 *
 * Tabs come back unrealised - session state and a strip entry, no renderer -
 * which is the same state a tab reaches after the idle ladder discards it.
 * Forty restored tabs are forty rows in the strip and one renderer for the one
 * you are looking at, so a restart is cheap in exactly the way the governor
 * makes a long session cheap.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { TabGroups, GROUP_ID } = require('../tab-groups');
const { setAside } = require('../set-aside');

const FILE = 'session.json';

/** A window with more tabs than this is a file we should not trust. */
const MAX_TABS = 500;

/** More windows than this is a file we should not trust either. */
const MAX_WINDOWS = 20;

/** A window's position and size, or null when they are not ones to trust. */
function validBounds(b) {
  const [x, y, width, height] = [b?.x, b?.y, b?.width, b?.height].map(Number);
  if (![x, y, width, height].every(Number.isInteger) || width < 200 || height < 200) return null;
  return { x, y, width, height, maximized: b.maximized === true };
}

/** Longest title kept; anything past this is decoration. */
const MAX_TITLE = 300;

/**
 * Schemes a restored tab may carry.
 *
 * The same list bookmarks use, and for the same reason: this file is read at
 * startup and turned into navigations, so a hand-edited or tampered session
 * must not be able to make the browser open `javascript:` or `file:` on launch.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'debrowser:']);

function safeUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return SAFE_SCHEMES.has(parsed.protocol) ? parsed.href : null;
}

class Session {
  constructor(log = () => {}, dir = null) {
    this.log = log;
    this.file = path.join(dir || app.getPath('userData'), FILE);
    /** Pending debounce timer; see `schedule`. */
    this.timer = null;
    /** What was last written, so an unchanged session is not rewritten. */
    this.lastWritten = null;
  }

  /**
   * The tabs from the last run, oldest first, with the one that was in front.
   *
   * Never throws. A missing file is a first run; a corrupt one is a file
   * somebody hand-edited or a disk that lied, and a browser that refuses to
   * start because of either would be a browser you cannot recover from without
   * a terminal.
   */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log('session', `could not read: ${err.message}`);
      return { tabs: [], activeIndex: 0 };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log('session', 'the saved session is not readable; starting fresh');
      // Kept, not overwritten by the fresh one: it is every tab someone had open.
      setAside(this.file, (line) => this.log('session', line));
      return { tabs: [], activeIndex: 0 };
    }

    const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs : [];
    const kept = [];
    for (const entry of tabs.slice(0, MAX_TABS)) {
      const url = safeUrl(entry?.url);
      if (!url) continue;
      kept.push({
        url,
        title: typeof entry?.title === 'string' ? entry.title.slice(0, MAX_TITLE) : '',
        pinned: entry?.pinned === true,
        spaceId: typeof entry?.spaceId === 'string' && /^[a-z0-9-]{1,24}$/.test(entry.spaceId) ? entry.spaceId : 'home',
        groupId: typeof entry?.groupId === 'string' && GROUP_ID.test(entry.groupId) ? entry.groupId : null,
        lastActiveAt: Number.isFinite(entry?.lastActiveAt) ? entry.lastActiveAt : null,
        // Which window it was in, by order: 0 is the first, and every tab of
        // a session from before there were several.
        window: Number.isInteger(entry?.window) && entry.window > 0 && entry.window < MAX_WINDOWS ? entry.window : 0
      });
    }

    const index = Number(parsed?.activeIndex);
    // Each window after the first: where it was, and the tab in front of it
    // (an index into `tabs`, as `activeIndex` is for the first).
    const windows = (Array.isArray(parsed?.windows) ? parsed.windows : []).slice(0, MAX_WINDOWS).map((w) => {
      const at = Number(w?.activeIndex);
      return {
        activeIndex: Number.isInteger(at) && at >= 0 && at < kept.length ? at : null,
        bounds: validBounds(w?.bounds)
      };
    });
    return {
      tabs: kept,
      groups: Array.isArray(parsed?.groups) ? parsed.groups : [],
      activeIndex: Number.isInteger(index) && index >= 0 && index < kept.length ? index : 0,
      windows
    };
  }

  /**
   * What the browser looks like right now, as the next run should find it.
   *
   * Takes the live tabs rather than being told, so there is one description of
   * a session and no second list to keep in step.
   */
  snapshot(tabs, activeId) {
    // One window's front tab, or every window: [{ id, activeId, bounds }],
    // oldest first.
    const windows = Array.isArray(activeId) ? activeId : null;
    const windowOf = (tab) => (windows ? Math.max(0, windows.findIndex((w) => w.id === tab.windowId)) : 0);
    const open = tabs
      .filter((tab) => safeUrl(tab.url))
      .map((tab) => ({
        id: tab.id,
        url: safeUrl(tab.url),
        title: typeof tab.title === 'string' ? tab.title.slice(0, MAX_TITLE) : '',
        pinned: tab.pinned === true,
        spaceId: tab.spaceId || 'home',
        groupId: tab.groupId || null,
        lastActiveAt: Number.isFinite(tab.lastActiveAt) ? tab.lastActiveAt : null,
        window: windowOf(tab)
      }));

    const indexOf = (id) => open.findIndex((t) => t.id === id);
    const activeIndex = Math.max(0, indexOf(windows ? windows[0]?.activeId : activeId));
    return {
      version: 1,
      activeIndex,
      tabs: open.map(({ url, title, pinned, spaceId, groupId, lastActiveAt, window }) =>
        ({ url, title, pinned, spaceId, groupId, lastActiveAt, ...(window ? { window } : {}) })),
      // The windows after the first, when there are any.
      ...(windows && windows.length > 1 ? {
        windows: windows.slice(1).map((w) => ({ activeIndex: Math.max(0, indexOf(w.activeId)), bounds: validBounds(w.bounds) }))
      } : {}),
      // Tab groups (tab-groups.js): only those a saved tab is in.
      groups: TabGroups.current ? TabGroups.current.save(open) : []
    };
  }

  /**
   * Write it, unless nothing has changed.
   *
   * Atomic tmp-and-rename, like every other store here: an interrupted write
   * would otherwise leave half a file, and half a session file is no session
   * at all - which on this particular store means losing every tab you had.
   */
  save(tabs, activeId) {
    const state = this.snapshot(tabs, activeId);
    const body = JSON.stringify(state);
    if (body === this.lastWritten) return true;

    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.lastWritten = body;
      return true;
    } catch (err) {
      this.log('session', `could not save: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      return false;
    }
  }

  /**
   * Save shortly, rather than now.
   *
   * Opening a tab, navigating and closing a tab all change the session, and a
   * page that redirects twice fires three of them in a second. Every one of
   * those would otherwise be a synchronous write of the whole list on the
   * browser's main thread.
   */
  schedule(tabs, activeId, delayMs = 2000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(tabs(), activeId()), delayMs);
    // Never the reason the process stays alive.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Write whatever is pending, now. Called on the way out. */
  flush(tabs, activeId) {
    clearTimeout(this.timer);
    this.timer = null;
    return this.save(tabs, activeId);
  }

  /*
   * Crash detection. A marker is written as the browser starts and removed as
   * it quits; one still there at the next start means the last run never
   * reached its quit - a crash, a forced kill, the power going. That run's tabs
   * were saved as it went (`schedule`), so they can be offered back.
   */
  get marker() { return `${this.file}.running`; }

  /** Whether the last run ended without quitting; this run is marked either way. */
  claimRun() {
    const unclean = fs.existsSync(this.marker);
    try { fs.writeFileSync(this.marker, String(process.pid), { mode: 0o600 }); } catch { /* read-only profile */ }
    return unclean;
  }

  /** The browser is quitting properly. */
  releaseRun() {
    try { fs.unlinkSync(this.marker); } catch { /* never written */ }
  }
}

/**
 * The window's size, position and maximised state, in a file of its own.
 *
 * Separate from the tab list because it is written once, on close, rather than
 * on every navigation - and because it is kept even with session restore off.
 */
const WINDOW_FILE = 'window.json';

function loadWindowState(dir = null) {
  try {
    return validBounds(JSON.parse(fs.readFileSync(path.join(dir || app.getPath('userData'), WINDOW_FILE), 'utf8')));
  } catch {
    return null;                                 // first run, or a file not worth trusting
  }
}

function saveWindowState(state, dir = null) {
  const file = path.join(dir || app.getPath('userData'), WINDOW_FILE);
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* losing the window's position is not worth a failed quit */ }
}

module.exports = { Session, safeUrl, MAX_TABS, loadWindowState, saveWindowState };
