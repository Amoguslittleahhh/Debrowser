'use strict';

/**
 * The browser window: chrome UI, tab content area, and the optional side panel.
 *
 * The window is a `BaseWindow` hosting three kinds of `WebContentsView`:
 *
 *   chrome  - the tab strip and toolbar, a normal web page we render ourselves
 *   tabs    - one per live tab, only the active one visible
 *   panel   - the task manager, created on first use and destroyed on close
 *
 * The chrome is its own renderer, which costs one process, and earns it: the
 * browser UI stays responsive while a page is busy or hung, and a page can
 * never reach the chrome's DOM.
 */

const path = require('path');
const { paletteFor } = require('./palette');
const { BaseWindow, WebContentsView, ImageView, nativeImage, nativeTheme,
        shell, systemPreferences, screen } = require('electron');
const { INCOGNITO } = require('./incognito/mode');
const { letterbox } = require('./incognito/fingerprint');

const CHROME_HEIGHT = 84;
const PANEL_WIDTH = 360;
/** The toast view: wide enough for a sentence and a button, tall enough for its shadow. */
const TOAST_WIDTH = 460;
const TOAST_HEIGHT = 84;
/** The gap between two tabs side by side: the divider's width. */
const SPLIT_GAP = 8;
/** Peek's card: its corners, and the room above it for the buttons. */
const PEEK_RADIUS = 12;
const PEEK_TOP = 52;
/** The quick window (a Lab): its size, and the bar above its page. */
const QUICK_SIZE = { width: 900, height: 640 };
const QUICK_BAR = 44;

/**
 * Height the bookmarks bar adds to the chrome when it is showing.
 *
 * The chrome is one web page, so the bar is drawn inside it - but the *window*
 * has to know, because the content area starts below the chrome and the page
 * would otherwise be painted over by it.
 */
const BOOKMARKS_BAR_HEIGHT = 34;

/**
 * Height the find bar adds while it is open.
 *
 * Drawn inside the chrome, like the bookmarks bar, rather than floating over
 * the page as Chrome's does. Over the page it would cover whatever is in the
 * top right corner - which on a search results page is the first result - and
 * this browser already owns the mechanism for a strip of chrome that takes its
 * room from the content rather than borrowing it.
 */
const FIND_BAR_HEIGHT = 38;

/** Width of the chrome when it runs down the side instead of across the top. */
const SIDEBAR_WIDTH = 240;

/**
 * How wide the sidebar's view stays while it is hidden.
 *
 * Zen's sidebar is out of the way until the pointer reaches the left edge, and
 * this is that edge. It has to be a real strip rather than nothing, because a
 * view is what receives the pointer: there is no way to be told the pointer
 * approached a view that is not there. Wide enough to hit without aiming,
 * narrow enough that the page effectively starts at the window edge.
 *
 * It also bounds the cost of the whole idea. A view swallows every click inside
 * its bounds, so a full-width transparent sidebar waiting to be hovered would
 * make the leftmost 240px of every page unclickable.
 */
const SIDEBAR_EDGE = 10;

/** How close to the left edge the pointer must be for it to be watched closely. */
const EDGE_NEAR = 160;

/**
 * The gap around the page, and the radius of its corners.
 *
 * The other half of what was asked for: with the strip down the side the
 * content used to meet the sidebar edge to edge, so the two read as one surface
 * and the browser's own pages - which have their own dark background - looked
 * fused to it. Inset by a few pixels over the window's own colour, the page
 * reads as a card the sidebar sits beside.
 *
 * `setBorderRadius` was measured before this was built on: with a red window
 * behind a white view, the pixel three in from the corner reads red and the
 * centre reads white, so the corner really is clipped rather than the call
 * merely being accepted.
 */
const CONTENT_GAP = 8;
const CONTENT_RADIUS = 10;

/**
 * How long the sidebar waits before sliding away.
 *
 * The pointer crossing the sidebar on its way somewhere else should not close
 * it mid-movement, and a menu or a dropdown opened from it takes the pointer
 * out of the view for a moment. Short enough to feel like it is following the
 * pointer rather than lagging behind it.
 */
const SIDEBAR_CLOSE_MS = 150;
const SIDEBAR_OPEN_MS = 60;    // enough to tell a brush past the edge from a visit, short enough not to feel

/**
 * How long a detached strip takes to slide back out; see setSidebarOpen.
 * The strip says when it has finished (`sidebar-slid`), and that is when its
 * view goes: a timer alone started before the slide did - the message has to
 * reach the strip and be styled first - and hid the view a frame or two short
 * of the end. This is the fallback, with room for that message.
 */
const DETACH_SLIDE_MS = 150;   // chrome.css, .sliding-out and the band's slide out
const DETACH_SLIDE_GRACE_MS = 100;

/**
 * How much of the content area a docked inspector takes, and the least it may
 * have. Chromium's own default split is close to this; the minimum exists so
 * that docking into a narrow window leaves the inspector usable rather than a
 * sliver, and `dockBounds` gives up on the dock entirely rather than squeeze
 * the page out of existence.
 */
const DEVTOOLS_SHARE = 0.42;
const DEVTOOLS_MIN = 320;
/** The title band's whole page (placeTitleBand): drag region, and nothing else. */
const TITLE_BAND_PAGE = '<style>html{height:100%;-webkit-app-region:drag}</style>';

/** The least the page keeps beside it, however far the edge is dragged. */
const DEVTOOLS_PAGE_MIN = 240;
/** How wide the edge between them is to the pointer: astride the boundary. */
const DEVTOOLS_GRIP = 8;

/**
 * How long to wait before reopening the inspector somewhere else.
 *
 * Closing one is asynchronous, and an open that races the teardown does
 * nothing at all - measured, not guessed. This is comfortably longer than the
 * teardown took and short enough to read as immediate.
 */
const DEVTOOLS_REDOCK_MS = 250;

/**
 * Height of the band left clear above the content in sidebar mode.
 *
 * The system draws minimise/maximise/close at the *window's* top right, and in
 * sidebar mode the chrome is nowhere near there - so without this band those
 * buttons would be painted straight over the web page, covering its top-right
 * corner and making it unclickable. The band is window background, which is
 * also what gives the buttons something to sit on.
 */
const SIDEBAR_TOP_BAND = 40;

/**
 * Width of the tab list's own view, tucked away: the panel card (224px, 16px
 * in from the window's edge, chrome.css) and a little room for its shadow.
 */
const STRIP_VIEW_WIDTH = 252;

/*
 * Full screen, where the chrome gets out of the way.
 *
 * Across the top the strip simply goes: the point of full screen is the page,
 * and a browser that keeps a toolbar across it is one that did not do what was
 * asked. Down the side it cannot go - the strip is the only way to see a tab in
 * that layout - so it becomes a panel floating over the page instead: the page
 * takes the whole screen, and the strip sits on top of it, inset from the
 * corner and only as tall as its own contents need.
 *
 * That height is the one number this side cannot work out for itself. What a
 * column of tabs comes to depends on how many there are, on the bookmarks bar,
 * on the find bar - so the chrome measures itself and says, and this clamps the
 * answer. See `setChromeHeight`.
 */
const FLOAT_GAP = 10;
const FLOAT_RADIUS = 14;
const FLOAT_MIN_HEIGHT = 120;

/**
 * Hard ceiling on how long a restore placeholder may stay up. Generous enough
 * to cover a slow page, short enough that a page which never paints does not
 * leave the user looking at a frozen screenshot.
 */
const PLACEHOLDER_MAX_MS = 1500;

/**
 * The panels that can occupy the sheet, and the page each one is.
 *
 * Named here rather than passed in: the sheet loads a file from disk into a
 * view with the chrome's preload, so what may go in it is a fixed list in the
 * browser process, not something a caller chooses.
 */
/** Sheets that are asking the user something, which another question must not close. */
const QUESTION_SHEETS = new Set(['ask', 'site', 'update']);

const SHEET_PAGES = {
  menu: 'menu.html',
  downloads: 'flyout.html',
  // Not anchored to anything - it centres itself. It is in the sheet because
  // everything the sheet gives it is what a prompt needs: a view over the whole
  // window, a backdrop that catches a click, the keyboard, and nothing held
  // while it is closed.
  update: 'update.html',
  // Every other question the browser asks: closing a window of tabs, saving a
  // password, opening a downloaded program. Drawn here rather than by the
  // system for the reason update.html is - see `ask`.
  ask: 'ask.html',
  // Right-click on a page. Same view, same dismissal, same styling as the app
  // menu - a context menu that looked like a different program's would be the
  // most obvious seam in the browser, and it is the menu people open most.
  context: 'context.html',
  // The padlock's panel: the site's connection, its permissions, its zoom,
  // and "Clear data". Also where a site's request for the camera, microphone,
  // location or notifications is asked.
  site: 'site.html',
  // Ctrl+/: every keyboard shortcut. Centred, like the update prompt.
  shortcuts: 'shortcuts.html'
};

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const CHROME_PRELOAD = path.join(__dirname, '..', 'preload', 'chrome-preload.js');

/**
 * Round a view's corners, where the running Electron can.
 *
 * Measured working under Electron 44 before anything was built on it - with a
 * red window behind a white view, the pixel three in from the corner reads red
 * while the centre reads white, so the corner really is clipped. Guarded
 * anyway: a browser that will not start because a cosmetic API moved would be a
 * poor trade, and square corners are a miss rather than a fault.
 */
/**
 * What a view of ours is told before it runs a line of script.
 *
 * Only the preferences, and only so the view can theme itself at parse time
 * rather than a frame after it paints - see `initialPrefs` in the preload. It
 * is a snapshot of something the same view receives on every broadcast anyway,
 * so nothing crosses this boundary that was not already crossing it.
 */
/**
 * Only what the first paint needs. A process's command line is readable by
 * other users and programs (/proc/<pid>/cmdline, `ps`), and the whole set used
 * to go there - private bridge lines, hidden new-tab sites, the download
 * folder - in every view. The rest arrives with the first broadcast, over IPC.
 */
const FIRST_PAINT_PREFS = ['theme', 'design', 'accent', 'accentFromSystem', 'tabWidth', 'tabBarPosition',
  'tabBarColor', 'windowOpacity', 'backgroundMaterial', 'reduceMotion', 'showMemoryMeter', 'showTierDots',
  'tabCloseButton', 'sidebarPinned', 'showBookmarksBar', 'settingsLayout', 'batteryMode'];

function preloadArgs(prefs) {
  if (!prefs) return [];
  const all = prefs.all();
  const look = {};
  for (const key of FIRST_PAINT_PREFS) if (key in all) look[key] = all[key];
  return [`--prefs=${JSON.stringify(look)}`];
}

function setRadius(view, radius) {
  if (!view || typeof view.setBorderRadius !== 'function') return;
  try {
    view.setBorderRadius(radius);
  } catch { /* not supported here; square corners */ }
}


/** The browser commands whose keys the inspector answers; see openDevTools. */
const DEVTOOLS_KEYS = new Set([
  'new-tab', 'new-incognito-window', 'close-tab', 'reopen-closed-tab', 'cycle-tab', 'select-tab',
  'reload', 'reload-hard', 'toggle-devtools', 'toggle-fullscreen'
]);
/** `#rrggbb` with an alpha, as Electron's '#aarrggbb' or a CSS rgba(). */
function withAlpha(hex, alpha, form) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return hex;
  const a = Math.max(0, Math.min(1, Number(alpha) || 0));
  if (form === 'argb') return `#${Math.round(a * 255).toString(16).padStart(2, '0')}${m[1]}`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

class BrowserShell {
  /**
   * @param {object} deps - { tabManager, log, onCommand }
   */
  constructor({ tabManager, prefs = null, updater = null, log = () => {}, onCommand = () => {},
                bindShortcuts = () => {}, bounds = null, held = false }) {
    this.tabs = tabManager;
    /**
     * Built but not shown until release(): a private window kept ready in the
     * background (main.js, WARM) waits here, Tor connecting behind it.
     */
    this.held = held;
    this.prefs = prefs;
    this.updater = updater;
    /** @type {import('./bookmarks').Bookmarks|null} */
    this.bookmarks = null;
    /** @type {import('./downloads').DownloadManager|null} */
    this.downloads = null;
    /** Incognito only: what the window says about the private connection. */
    this.incognito = null;
    this.log = log;
    this.onCommand = onCommand;
    /**
     * Give a view of ours the browser's keyboard shortcuts.
     *
     * Every view that can hold focus: the chrome, the task manager, the menu,
     * the downloads flyout, the context menu and the update prompt. A view that
     * holds focus and ignores Ctrl+T is a browser whose keyboard has stopped
     * working as far as anyone can tell.
     */
    this.bindShortcuts = bindShortcuts;

    // Where the window was last time, already fitted to a display by the
    // caller; otherwise the fixed size the smoke suite asserts on.
    this.startMaximized = Boolean(bounds && bounds.maximized);
    this.window = new BaseWindow({
      ...(bounds
        ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        : { width: 1280, height: 820 }),
      minWidth: 620,
      minHeight: 420,
      title: 'Debrowser',
      // A private window wears its own icon on Windows and Linux, where the
      // window's icon is the taskbar's (private-icon.js). macOS takes the
      // Dock's, set in main.js.
      ...(INCOGNITO && process.platform !== 'darwin' && require('./private-icon').privateIconPath()
        ? { icon: require('./private-icon').privateIconPath() } : {}),
      // The theme's own surface from the first frame. A fixed dark one flashed
      // on every launch in the light theme.
      backgroundColor: this.surface(),
      show: false,

      // The tab strip *is* the title bar, as in every modern browser. A
      // separate OS title bar above the tabs wastes a row of screen to display
      // a name the user already knows, and the app menu that came with it -
      // File/Edit/View/Window - was Electron's default rather than anything
      // this browser does. Both are gone; see `app.applicationMenu` in main.js.
      //
      // `titleBarOverlay` keeps the real minimise/maximise/close buttons, drawn
      // by the system in the system's own style, sitting over our strip. Rolling
      // our own would mean reimplementing snap layouts, double-click-to-maximise
      // and the accessibility behaviour that comes free with the real ones.
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } }
        : {
            titleBarStyle: 'hidden',
            titleBarOverlay: { color: this.surface(), symbolColor: this.symbolColour(), height: 40 }
          })
    });

    // A private window cannot be captured: screenshots, screen recording and
    // a screen shared in a meeting show it blank (Windows and macOS). It also
    // gets in the way of screen-grabbing malware, partly. Linux has no such
    // control, which the connection page says.
    if (INCOGNITO) this.window.setContentProtection(true);

    this.panelView = null;
    // Tucked away in a window, the tab list's own view (see `layout`).
    this.stripView = null;
    this.panelOpen = false;

    /** Whether the find bar is showing, which the content area has to know. */
    this.findOpen = false;

    /**
     * The sheet, while one is open: the app menu or the downloads flyout.
     *
     * One mechanism rather than two. Both are a panel anchored to a toolbar
     * button that has to be able to overflow the chrome's 84px strip, both are
     * dismissed by clicking away, and both should cost nothing while closed -
     * so they are the same window-sized transparent view loading a different
     * page, not two copies of that idea drifting apart. See openSheet.
     *
     * @type {Electron.WebContentsView|null}
     */
    this.sheetView = null;
    /** The address bar's suggestion list; see showSuggestions. */
    this.suggestView = null;
    this.crashView = null;
    this.toastView = null;
    /** Two tabs side by side: { left, right } tab ids and the left one's share. */
    this.split = null;
    this.dividerView = null;
    /** Peek: a page in a card over the tab - its page view and the backdrop with its buttons. */
    this.peek = null;
    this.suggestOpen = false;
    this.suggestSelected = -1;
    setImmediate(() => this.releaseSidebar());
    /** Which page the open sheet is showing, or null. */
    this.sheetPage = null;
    /** The sheet whose close armed the reopen guard, and when. */
    this.sheetClosedPage = null;
    this.sheetClosedAt = 0;

    /**
     * One reused ImageView showing the outgoing tab's thumbnail while a
     * restored tab loads. See showPlaceholder.
     * @type {Electron.ImageView|null}
     */
    this.placeholderView = null;
    this.placeholderTimer = null;

    /**
     * The inspector, when it is docked inside this window.
     *
     * Electron's own docking (`openDevTools({ mode: 'right' })`) is implemented
     * by the owning BrowserWindow, and this browser does not have one - it is a
     * BaseWindow holding sibling views. So the inspector is hosted the other way
     * round: `setDevToolsWebContents` points it at a view we create, and we lay
     * that view out ourselves like any other. Measured working under Electron 44
     * before this was built on.
     *
     * @type {Electron.WebContentsView|null}
     */
    this.devToolsView = null;
    /** @type {import('./tabs/tab').Tab|null} the tab being inspected */
    this.devToolsTab = null;
    /** The dock mode in force when it was opened, so a change can re-dock it. */
    this.devToolsMode = null;
    /** Its share of the room, which dragging the edge beside it changes. */
    this.devToolsShare = (prefs && prefs.get('devToolsShare')) || DEVTOOLS_SHARE;
    /** That edge: a divider view, as split view's, over the page's side of it. */
    this.devToolsDivider = null;
    /** The title bar over the page, with the tabs pinned down the side (placeTitleBand). */
    this.titleBand = null;
    this.devToolsRedock = null;

    /**
     * Full screen, across the top: does the chrome have focus right now?
     *
     * Tracked rather than asked, because the answer decides whether the chrome
     * is on screen at all - and a view that has been hidden cannot report
     * anything about itself.
     */
    this.chromeFocused = false;
    /** The floating panel's height, as the chrome last measured itself. */
    this.chromeWantsHeight = 0;

    /**
     * Whether the auto-hiding sidebar is currently slid out.
     *
     * Only meaningful with the strip down the side and unpinned; pinned, it is
     * simply always out. Held here rather than in the chrome because the
     * *window* is what changes - the view's own width is what slides.
     */
    this.sidebarOpen = false;
    this.sidebarCloseTimer = null;
    /** The card treatment currently applied to tab views, so it is set on change. */
    this.laidOutCard = null;

    this.createChrome();
    this.applyWindowPrefs();

    // Layout is driven by resize, which is not the whole story on Windows.
    //
    // Minimising fires `resize` with a client area of zero, so laying out from
    // it collapses every view to nothing - and the good bounds are gone. If
    // `resize` then does not fire again on restore, or fires before the window
    // has its size back, the window comes back empty: no tab strip, no page,
    // just the background colour. `layout` refuses to compute from a minimised
    // or degenerate window for that reason, and `restore`/`show` re-run it so
    // the views are sized again the moment there is something real to size
    // them to.
    // A resize with the menu open would leave it anchored to a button that has
    // moved. Closed rather than re-anchored: the user is dragging a window
    // edge, not reading a menu.
    this.window.on('resize', () => { this.closeSheet(); this.hideSuggestions(); this.layout(); });
    this.window.on('restore', () => { this.revive(); this.reapplyMaterial(); });
    this.window.on('show', () => this.revive());
    // Full screen changes which rectangle everything gets, in both layouts, so
    // it is a relayout like a resize - and a publish, because the chrome draws
    // itself differently as a floating panel and only the window knows.
    // The window's background too: tucked away, full screen has no band to see
    // through (translucentNow).
    this.window.on('enter-full-screen', () => { this.applyWindowPrefs(); this.layout(); this.publishSidebar(); });
    // Laid out again a moment later too: the event can arrive before the
    // window's final size, and the views kept the full-screen size - wider
    // than the window, clipping the menu button - until the next resize.
    this.window.on('leave-full-screen', () => {
      this.applyWindowPrefs();
      this.layout();
      this.publishSidebar();
      setTimeout(() => { if (!this.window.isDestroyed()) this.layout(); }, 150);
    });
    /*
     * The two extra buttons on a mouse.
     *
     * Windows and Linux deliver them to the window as `app-command`, not as a
     * click in the page, so nothing sees them unless this does - and anyone
     * whose thumb reaches for back has a browser that ignores it. macOS has no
     * equivalent event, and a two-finger swipe there is a different mechanism
     * this does not implement.
     *
     * Unverified on real hardware: there is no mouse in the container this was
     * written in, and a synthetic event cannot raise this. The failure mode if
     * the name is wrong is the behaviour that exists today - nothing happens.
     */
    this.window.on('app-command', (event, command) => {
      if (command === 'browser-backward') this.onCommand('back');
      else if (command === 'browser-forward') this.onCommand('forward');
      else return;
      event.preventDefault();
    });

    this.window.on('maximize', () => { this.layout(); this.reapplyMaterial(); });
    this.window.on('unmaximize', () => { this.layout(); this.reapplyMaterial(); });
    this.window.once('ready-to-show', () => this.reveal());
  }

  /** Show the window, maximised the first time if that is how it was left. */
  reveal() {
    if (this.window.isDestroyed() || this.held) return;
    if (this.startMaximized) {
      this.startMaximized = false;
      this.window.maximize();
    }
    this.window.show();
    setImmediate(() => this.reapplyMaterial());
  }

  /** Show a window that was being held back. */
  release() {
    if (!this.held) return;
    this.held = false;
    this.reveal();
    if (!this.window.isDestroyed()) this.window.focus();
  }

  createChrome() {
    this.chromeView = new WebContentsView({
      webPreferences: {
        preload: CHROME_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The chrome must never be throttled: it owns the tab strip, and a
        // throttled tab strip is a browser that feels broken.
        backgroundThrottling: false,
        additionalArguments: preloadArgs(this.prefs)
      }
    });

    this.window.contentView.addChildView(this.chromeView);
    // The chrome answers the same shortcut table as every other view. It used
    // to run a second one in its own DOM, which is how the browser ended up
    // with shortcuts that existed only while the toolbar had focus.
    this.bindShortcuts(this.chromeView.webContents);

    // The address bar is in here, and in full screen across the top the chrome
    // is not on screen until something reaches for it. Focus is that signal:
    // Ctrl+L brings the bar back, and leaving it lets the page have the room
    // again. Harmless in every other layout, where nothing reads the flag.
    this.chromeView.webContents.on('focus', () => this.setChromeFocused(true));
    this.chromeView.webContents.on('blur', () => this.setChromeFocused(false));
    this.chromeView.webContents.loadFile(path.join(RENDERER_DIR, 'chrome.html'));

    // Links in our own UI (there should be none) open externally rather than
    // replacing the browser chrome. Web addresses only: `openExternal` hands
    // anything else to whatever the OS has registered for the scheme, and a
    // `file:` or custom-protocol URL there is a program being launched.
    this.chromeView.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    this.chromeView.webContents.once('did-finish-load', () => {
      this.reveal();
      this.onCommand('chrome-ready');
    });
  }

  /* ---------------------------------------------------------------- */

  /** Attach a tab's view to the window. Called when a tab is realised. */
  attachTab(tab) {
    if (!tab.view) return;
    // A tap on the page is leaving the strip. Touch sends no mouse-leave, so
    // a strip brought out by a tap at the edge otherwise stayed over the page
    // until the next tap landed back on the strip itself.
    if (!tab.view.sidebarReleaseBound) {
      tab.view.sidebarReleaseBound = true;
      tab.view.webContents.on('focus', () => {
        // Only when the pointer is really off the strip: choosing a tab in it
        // also moves focus to the page, with the pointer still on the strip.
        // A tap moves the system cursor to where it landed, so this holds for
        // touch too.
        if (!this.sidebarOpen || this.window.isDestroyed()) return;
        const at = screen.getCursorScreenPoint();
        const win = this.window.getContentBounds();
        // Tucked away in a window the view is the whole window while the tabs
        // are out, and the strip is only its left column under the band.
        const b = this.band() && this.stripView
          ? this.stripView.getBounds()
          : this.chromeView.getBounds();
        const x = at.x - win.x;
        const y = at.y - win.y;
        if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return;
        this.sidebarPointerOver = false;
        this.releaseSidebar();
      });
    }
    const children = this.window.contentView.children;
    // Insert below the chrome so the chrome always wins the z-order.
    if (!children.includes(tab.view)) {
      this.window.contentView.addChildView(tab.view, 0);
    }

    // Bounds are re-asserted on every present, not only on the first.
    //
    // This used to return early for a view that was already attached, which was
    // true of every tab switch - and became wrong the moment a docked inspector
    // existed. The dock belongs to one tab and is drawn above all of them, so
    // switching tabs changes both who gets the content rectangle and whether
    // the dock should be on screen at all. Returning early left tab A's
    // inspector painted over tab B, with B sized as though it had the window.
    if (this.devToolsView || this.inSplit(tab)) this.layout();
    else tab.setBounds(this.contentBounds());
    // A tab realised after the layout ran has never been shaped, so the change
    // guard in `layout` would skip it. Cheap, and once per attach.
    setRadius(tab.view, this.vertical() && !this.fullScreen() ? CONTENT_RADIUS : 0);
    tab.setVisible(tab.visible);
  }

  detachTab(tab) {
    // An inspector outlives nothing. Closing the tab it was opened on leaves a
    // view inspecting a renderer that is being torn down, holding a share of
    // the window for a page that is no longer there.
    if (this.devToolsTab === tab) this.closeDevTools();
    if (!tab.view) return;
    try {
      this.window.contentView.removeChildView(tab.view);
    } catch { /* already detached */ }
  }

  /* ---------------------------------------------------------------- */
  /* Restore placeholder                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Cover a restoring tab with a picture of how the user left it.
   *
   * Measured on the smoke fixtures, activation puts a tab on screen in ~4ms but
   * its content does not arrive for 40-107ms - and those are localhost pages;
   * over a real network it is far longer. For that whole window the view is
   * blank, and that blankness is the entire perceived cost of discarding a tab.
   * Covering it is what makes a discard something the user does not notice,
   * which in turn is what allows the reclaim policy to be aggressive at all.
   *
   * One ImageView, reused. A 480px-wide decoded bitmap is around 0.6MB, and
   * holding one per tab would spend more memory than the discards save.
   *
   * Returns whether a placeholder was actually shown, so the caller can tell
   * the difference between covered and uncovered restores when reporting.
   */
  showPlaceholder(tab) {
    if (!tab || !tab.thumbPath) return false;

    let image;
    try {
      image = nativeImage.createFromPath(tab.thumbPath);
    } catch {
      return false;
    }
    if (!image || image.isEmpty()) return false;

    try {
      if (!this.placeholderView) {
        this.placeholderView = new ImageView();
        // Above the tab views, below the chrome: the tab strip and toolbar stay
        // live and clickable while a page is restoring behind them.
        const chromeIndex = this.window.contentView.children.indexOf(this.chromeView);
        this.window.contentView.addChildView(this.placeholderView,
          chromeIndex === -1 ? undefined : chromeIndex);
      }
      this.placeholderView.setImage(image);
      this.placeholderView.setBounds(this.contentBounds());
      this.placeholderView.setVisible(true);
    } catch (err) {
      this.log(`placeholder failed: ${err.message}`);
      return false;
    }

    // A placeholder that outlives its page is a browser that looks frozen, so
    // it is never shown without something guaranteed to take it away again.
    clearTimeout(this.placeholderTimer);
    this.placeholderTimer = setTimeout(() => this.hidePlaceholder(), PLACEHOLDER_MAX_MS);
    if (typeof this.placeholderTimer.unref === 'function') this.placeholderTimer.unref();
    return true;
  }

  /**
   * Take the placeholder away. Idempotent, and the single exit for every path
   * that shows one - the timeout, first paint, a failed load, a dead renderer -
   * so no path can forget to uncover the page.
   */
  hidePlaceholder() {
    clearTimeout(this.placeholderTimer);
    this.placeholderTimer = null;
    if (!this.placeholderView) return;
    try {
      this.placeholderView.setVisible(false);
      // Release the decoded bitmap rather than holding it until the next
      // restore. The view itself is cheap; the image is not.
      this.placeholderView.setImage(nativeImage.createEmpty());
    } catch { /* view already gone */ }
  }

  /* ---------------------------------------------------------------- */
  /* The app menu                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Open the three-dot menu, drawn by us.
   *
   * This used to be `Menu.popup()` - the platform's own menu - for a reason
   * that was true: the chrome is a `WebContentsView` clipped to its 84px strip,
   * so a dropdown drawn in that renderer stops at the toolbar's bottom edge,
   * and a menu that cannot overflow its own window is not a menu.
   *
   * A second view is the way out of that. It is window-sized and transparent,
   * so the menu can be drawn anywhere in the window while everything it is not
   * covering shows through - and the empty part of it is what catches the click
   * that dismisses the menu, which is what a system popup does with a grab we
   * cannot take.
   *
   * What that buys, and the reason for changing something that worked: the
   * menu is now ours to style, so it matches the browser instead of matching
   * Win32; it can hold controls a menu item cannot, like the zoom stepper; and
   * it themes, animates and rounds with the rest of the chrome. What it costs
   * is the keyboard navigation and screen-reader behaviour the system menu had
   * for free - so those are implemented in menu.js rather than lost, which is
   * the part of this trade that has to be paid rather than assumed.
   *
   * Created on open and destroyed on close, like the task manager panel: a menu
   * that held a renderer while shut would be an embarrassing thing for this
   * browser to ship.
   *
   * @param {{x?: number, y?: number}} anchor - the button's bottom-left corner,
   *   in window coordinates. The renderer sends it because only it knows where
   *   the button ended up after the strip laid out.
   */
  openSheet(page, anchor = {}, { refresh = false } = {}) {
    if (this.window.isDestroyed()) return;
    const file = SHEET_PAGES[page];
    if (!file) return;
    this.flushLeavingSheet();

    // Toggle: pressing the same button again closes it, as a system menu does
    // when the click lands on its dismissing grab. Pressing the *other* one
    // swaps, which is what a toolbar full of panels should do. A `refresh` is
    // not a press - the panel has something new to say - so it redraws the
    // one that is open instead of closing it.
    if (this.sheetView) {
      const same = this.sheetPage === page;
      this.closeSheet({ replacing: !same || refresh });
      if (same && !refresh) return;
    }

    // The same toggle, for the ordering that actually happens.
    //
    // Pressing the button moves focus to the chrome, which blurs the sheet's
    // view and closes it - *before* the click that follows arrives here. So by
    // the time the command lands there is nothing to toggle, and the second
    // press would reopen it: the button would look like it did nothing. A press
    // this soon after a close is the closing half of a toggle, not a new open.
    //
    // Keyed to the page, because the guard is about one button being pressed
    // twice. Closing the menu by reaching for the downloads button must not
    // make the downloads button dead for a quarter second.
    //
    // Not for the context menu, which has no button and therefore no such race.
    // There the guard was doing the opposite of its job: a right-click on the
    // backdrop dismisses the menu, and the right-click that follows - the one
    // that should raise it at the new point - arrived inside the window and was
    // swallowed, so the menu appeared to have stopped working for a moment.
    //
    // Nor for a question (the ask and update prompts), which no button opens:
    // closing one by clicking away starts the next one queued behind it at
    // once, and the guard swallowed that one - its promise never settled,
    // and a "Close window?" lost this way left the window unable to close.
    if (page !== 'context' && page !== 'ask' && page !== 'update' && !refresh &&
        this.sheetClosedPage === page && Date.now() - this.sheetClosedAt < 250) return;

    const x = Number(anchor?.x);
    const y = Number(anchor?.y);
    const right = Number(anchor?.right);

    const sheetView = new WebContentsView({
      webPreferences: {
        preload: CHROME_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        additionalArguments: preloadArgs(this.prefs),
        // Without this the view composites its own opaque white first, and the
        // whole window flashes before the menu paints.
        transparent: true
      }
    });
    this.sheetView = sheetView;
    this.sheetPage = page;
    this.syncOverlay();

    // The view is window-sized; only the menu itself is painted. Anything the
    // page leaves untouched has to show what is behind it, or this covers the
    // browser with a grey sheet.
    try {
      sheetView.setBackgroundColor('#00000000');
    } catch (err) {
      this.log(`transparent menu unavailable: ${err.message}`);
    }

    // In the window from the start, but one pixel big, until it has drawn.
    //
    // Added only once loaded, it still flashed white on Windows: a view that
    // has never produced a frame is drawn as a white rectangle until its first
    // one arrives, and "loaded" is not "drawn". A view in the window draws
    // frames while it loads, and a pixel of it is nothing anyone can see.
    this.window.contentView.addChildView(sheetView);   // topmost, over the chrome
    sheetView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    this.sheetDrawn = false;

    const wc = sheetView.webContents;
    this.bindShortcuts(wc);
    wc.loadFile(path.join(RENDERER_DIR, file), {
      query: {
        x: String(Number.isFinite(x) ? Math.round(x) : 0),
        y: String(Number.isFinite(y) ? Math.round(y) : 0),
        // The button's right edge, which is what the menu aligns to. Passed
        // through rather than derived: only the renderer knows how wide its own
        // button ended up.
        right: String(Number.isFinite(right) ? Math.round(right) : 0)
      }
      // A menu dismissed before it finished loading cancels its own load. That
      // is an ordinary thing for a menu and not worth a line in the log.
      // A sheet dismissed - or replaced by the other one - before it finished
      // loading cancels its own load. That is an ordinary thing for a panel and
      // not worth a line in the log, so this reports only a load that failed
      // while its sheet was still the one on screen.
    }).catch((err) => {
      if (this.sheetView === sheetView) this.log(`${page} sheet failed to load: ${err.message}`);
    });

    // Put on screen only once it has something to show.
    //
    // The view used to be added to the window before the load was even started,
    // and a window-sized view with nothing painted in it is a window-sized
    // white rectangle - which is what pressing the three dots flashed. The
    // transparency above is real and was not enough: it governs what the view
    // composites where the *page* is transparent, and until the page exists
    // there is nothing to be transparent.
    //
    // Attaching the dismissal handlers here too, rather than at creation. A
    // blur that arrives while the menu is still loading is focus settling, not
    // the user clicking away, and treating it as a dismissal closed the menu
    // in the same breath as opening it.
    wc.once('did-finish-load', async () => {
      // Dismissed before it finished loading - Escape, or a second press. The
      // view is already being torn down; putting it on screen now would show a
      // menu the user has closed.
      if (this.sheetView !== sheetView || wc.isDestroyed()) return;

      // Two animation frames: the page has laid out and drawn at least once.
      // Bounded, so a renderer that never answers still shows its panel.
      await Promise.race([
        wc.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', true),
        new Promise((r) => setTimeout(r, 150))
      ]).catch(() => {});
      if (this.sheetView !== sheetView || wc.isDestroyed()) return;

      this.sheetDrawn = true;
      this.layoutSheet();

      // Focused so it can take the keyboard, which is how the arrow keys and
      // Escape reach it at all.
      wc.focus();

      // Clicking a page or the tab strip moves focus out of this view, and a
      // menu that stays up after the user has gone somewhere else is a menu
      // they have to dismiss twice. This is the backstop for the click-away the
      // transparent backdrop already handles; both funnel into `closeSheet`.
      //
      // Only ever itself. A panel replaced by another is removed at once, and
      // on Windows its blur can arrive after that - when the panel on screen
      // is already the new one, which this used to close in its place.
      wc.on('blur', () => { if (this.sheetView === sheetView) this.closeSheet({ blurred: true }); });
    });
  }

  /**
   * Take the menu away. Idempotent - every dismissal path ends here.
   *
   * @param {{blurred?: boolean}} [why] - `blurred` marks the one close that
   *   arms the reopen guard: focus leaving the view because the user pressed
   *   the three-dot button again. Every other dismissal - Escape, a menu item,
   *   a click on the backdrop - must *not* arm it, or a menu closed with
   *   Escape would make the button dead for the next quarter second.
   */
  /**
   * Tell the chrome whether a menu or the suggestions are over it.
   *
   * Windows hit-tests the chrome's drag regions itself, whatever view is on
   * top, so a menu opened over the side strip - which is title bar, and drags
   * the window - took no clicks and no hover: every press on it went to
   * moving the window. While something lies over the chrome it drags nothing.
   */
  syncOverlay() {
    const open = Boolean(this.sheetView) || this.suggestOpen === true;
    if (this.overlayOpen === open) return;
    this.overlayOpen = open;
    this.toChrome('overlay', { open });
    this.placeTitleBand();
  }

  /**
   * The title bar beside a pinned strip: the band above the page, which drags
   * the window as any title bar does - double-click maximises, and on Windows
   * a drag to the screen's edge snaps it.
   *
   * Nothing drew there. The strip's view is its column and the page starts
   * below the band, so the band was bare window, and only a web view can mark
   * part of a window as one to drag by: the window moved only from the empty
   * foot of the tab list, which nobody thinks to try. A clear view the band's
   * size, all drag region and nothing else.
   *
   * Hidden while a menu or the suggestions lie over it, for the same reason
   * the chrome stops dragging then (syncOverlay): drag regions are hit-tested
   * whatever is on top, and the menu over the band would take no clicks.
   */
  placeTitleBand() {
    if (this.window.isDestroyed()) return;
    const want = this.vertical() && !this.detached() && !this.fullScreen();
    if (!want) {
      if (this.titleBand) {
        const view = this.titleBand;
        this.titleBand = null;
        try { this.window.contentView.removeChildView(view); view.webContents.close(); } catch { /* window going */ }
      }
      return;
    }
    if (!this.titleBand) {
      const view = new WebContentsView({
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false }
      });
      try { view.setBackgroundColor('#00000000'); } catch { /* opaque then */ }
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', (event) => event.preventDefault());
      view.webContents.loadURL(`data:text/html,${encodeURIComponent(TITLE_BAND_PAGE)}`).catch(() => {});
      // Under everything: a menu or sheet that opens later lies over it.
      this.window.contentView.addChildView(view, 0);
      this.titleBand = view;
    }
    const { width } = this.window.getContentBounds();
    const left = this.sidebarWidth();
    this.titleBand.setBounds({ x: left, y: 0, width: Math.max(0, width - left), height: SIDEBAR_TOP_BAND });
    this.titleBand.setVisible(!this.overlayOpen);
  }

  /**
   * Ask something in the browser's own sheet, as `dialog.showMessageBox` would.
   *
   * The same spec and the same answer - `{ title, message, detail, buttons,
   * defaultId, cancelId, checkboxLabel }` in, `{ response, checkboxChecked }`
   * out - so a call site changes one word. A system message box was a Win32
   * dialog in the middle of a window that draws everything else itself:
   * light-themed over a dark browser, in another typeface, with the system's
   * buttons. One question at a time; a second one answers the first with its
   * cancel, which is what dismissing it would have done.
   */
  ask(spec) {
    // Another question on screen - a site's permission request, the update
    // prompt, another of these - is not dismissed for this one: closing the
    // site panel is a refusal, so a "Save password?" arriving under it would
    // have answered the camera's question for the user. This waits its turn.
    // The site panel only while it holds a permission request: opened just to
    // look at a site, it is a panel like any other, and a close-window
    // question waiting behind it would make the window's X seem dead.
    const asking = this.sheetPage !== 'site' || (typeof this.siteIsAsking === 'function' && this.siteIsAsking());
    if (this.sheetView && QUESTION_SHEETS.has(this.sheetPage) && asking) {
      return new Promise((resolve) => {
        (this.askQueue || (this.askQueue = [])).push(() => this.ask(spec).then(resolve));
      });
    }
    // A menu or a panel is only in the way: it goes, as a click elsewhere would.
    this.closeSheet();
    const buttons = Array.isArray(spec.buttons) && spec.buttons.length ? spec.buttons.map(String) : ['OK'];
    const clamp = (n, fallback) => (Number.isInteger(n) && n >= 0 && n < buttons.length ? n : fallback);
    const cancelId = clamp(spec.cancelId, buttons.length - 1);
    const clean = {
      title: String(spec.title || spec.message || ''),
      message: spec.title && spec.message !== spec.title ? String(spec.message || '') : '',
      detail: String(spec.detail || ''),
      buttons,
      defaultId: clamp(spec.defaultId, 0),
      cancelId,
      checkboxLabel: spec.checkboxLabel ? String(spec.checkboxLabel) : '',
      // The safe answer has the keyboard unless the caller says otherwise:
      // a question nobody asked for must not be answered by a stray Enter.
      focusId: clamp(spec.focusId, cancelId),
      danger: spec.danger === true
    };
    if (this.window.isDestroyed()) return Promise.resolve({ response: cancelId, checkboxChecked: false });
    return new Promise((resolve) => {
      this.asking = { spec: clean, resolve };
      this.openSheet('ask');
    });
  }

  /** The question on screen, for the sheet to draw. */
  askSpec() {
    return this.asking ? this.asking.spec : null;
  }

  /** The sheet's answer, or a dismissal's. Closes the sheet. */
  answerAsk({ response, checked } = {}) {
    const pending = this.asking;
    if (!pending) return;
    this.asking = null;
    const n = Number(response);
    const valid = Number.isInteger(n) && n >= 0 && n < pending.spec.buttons.length;
    pending.resolve({ response: valid ? n : pending.spec.cancelId, checkboxChecked: checked === true });
    if (this.sheetPage === 'ask') this.closeSheet();
  }

  closeSheet({ blurred = false, replacing = false } = {}) {
    if (!this.sheetView) return;
    const view = this.sheetView;
    const page = this.sheetPage;
    this.sheetView = null;
    this.sheetPage = null;
    if (!replacing) this.syncOverlay();
    if (!replacing) setImmediate(() => this.releaseSidebar());
    if (blurred) {
      this.sheetClosedPage = page;
      this.sheetClosedAt = Date.now();
    }
    // Dismissing the update prompt is "Later", and the updater has to know it
    // is no longer on screen or it would refuse to offer again for the life of
    // the session. Nothing is cancelled: the downloaded update is still there
    // and the prompt comes back on the next launch.
    if (page === 'update' && this.updater) this.updater.dismissPrompt();
    // A question closed without an answer - Escape, a click outside, another
    // panel taking its place - is the cancel button.
    if (page === 'ask' && this.asking) this.answerAsk({ response: this.asking.spec.cancelId });
    // A question waiting for this one to go has its turn.
    if (!replacing && this.askQueue && this.askQueue.length) {
      const next = this.askQueue.shift();
      setImmediate(next);
    }
    // A permission question closed without an answer is a refusal; main.js
    // decides that, since it holds the question.
    if (this.onSheetClosed) this.onSheetClosed(page);
    // Faded out rather than cut: the page is told, and the view goes when
    // the fade has run. Forgotten at once, above, so a new panel can open and
    // nothing mistakes this one for the panel on screen.
    // Not when another panel is taking its place: that one is on screen at
    // once, and a view removed under it a moment later moved focus and closed
    // the new panel as if the user had clicked away.
    this.flushLeavingSheet();
    const remove = () => {
      try {
        this.window.contentView.removeChildView(view);
        view.webContents.close();
      } catch { /* already gone */ }
    };
    if (replacing) {
      remove();
    } else {
      send(view, 'debrowser:ui', { kind: 'closing' });
      this.leavingSheet = { remove, timer: setTimeout(() => this.flushLeavingSheet(), 110) };
      // The fading view still covers the window, and a press in that moment
      // was swallowed by a panel already gone. It goes at once instead, and
      // the press is handed to whatever is underneath it.
      view.webContents.on('input-event', (_event, input) => {
        if (input.type !== 'mouseDown' || this.leavingSheet?.remove !== remove) return;
        this.flushLeavingSheet();
        this.passPointerThrough(input);
      });
    }
    // The keyboard goes back to the page. Closing the view that held focus
    // handed it to nobody, so the next keystrokes - after Cut in a context
    // menu, or after choosing Full screen - went nowhere. Not when focus left
    // for somewhere the user chose (a click elsewhere), and not when another
    // panel is replacing this one.
    if (!blurred && !replacing) this.focusPage();
  }

  /**
   * Give a press to the view under it. The point is in window coordinates -
   * the panel's view covers the window from its corner - and each view is sent
   * it in its own.
   */
  passPointerThrough(input) {
    if (this.window.isDestroyed()) return;
    const views = [...this.window.contentView.children].reverse();
    // Views that can take input only: the restore placeholder is a picture
    // with no page behind it, and the press was dropped on it.
    const target = views.find((v) => {
      const b = v.getBounds();
      return v.webContents && !v.webContents.isDestroyed() && v.getVisible?.() !== false &&
        input.x >= b.x && input.y >= b.y && input.x < b.x + b.width && input.y < b.y + b.height;
    });
    if (!target) return;
    const b = target.getBounds();
    const at = {
      x: input.x - b.x, y: input.y - b.y,
      button: input.button || 'left', clickCount: input.clickCount || 1, modifiers: input.modifiers || []
    };
    try {
      target.webContents.focus();
      target.webContents.sendInputEvent({ type: 'mouseDown', ...at });
      // And its release: the real one went to the view that has just gone, so
      // the page got a press with no click, and a button stayed held down.
      target.webContents.sendInputEvent({ type: 'mouseUp', ...at });
    } catch { /* the view went too */ }
  }

  /** Finish removing a panel that is still fading out. */
  flushLeavingSheet() {
    const leaving = this.leavingSheet;
    if (!leaving) return;
    this.leavingSheet = null;
    clearTimeout(leaving.timer);
    leaving.remove();
  }

  /** Give the keyboard to the page in front. */
  focusPage() {
    const tab = this.tabs && this.tabs.activeTab();
    const wc = tab && tab.isLive ? tab.wc : null;
    if (wc && !wc.isDestroyed()) wc.focus();
  }

  layoutSheet() {
    // Still drawing its first frame at one pixel; see openSheet.
    if (!this.sheetView || !this.sheetDrawn || this.window.isDestroyed()) return;
    const { width, height } = this.window.getContentBounds();
    if (width <= 0 || height <= 0) return;
    this.sheetView.setBounds({ x: 0, y: 0, width, height });
  }

  /* ---------------------------------------------------------------- */
  /* Address bar suggestions                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Show the list under the address bar.
   *
   * Not the sheet: the sheet takes the keyboard, and here the keyboard has to
   * stay in the address bar while the list is up. So this is a view of its
   * own, sized to the list, never focused, and kept (hidden) between uses so
   * the next keystroke's list costs a message rather than a page load. After a
   * minute unused it is closed, and with it its renderer.
   *
   * @param {object[]} items
   * @param {{x:number, y:number, width:number}} anchor - the address bar's
   *   bottom-left and width, in the chrome's own coordinates
   */
  showSuggestions(items, anchor) {
    if (this.window.isDestroyed()) return;
    if (!items || !items.length) { this.hideSuggestions(); return; }
    clearTimeout(this.suggestCloseTimer);
    if (!this.suggestView) {
      const view = new WebContentsView({
        webPreferences: {
          preload: CHROME_PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          additionalArguments: preloadArgs(this.prefs),
          transparent: true
        }
      });
      try { view.setBackgroundColor('#00000000'); } catch { /* opaque then */ }
      view.setVisible(false);
      // The list never keeps the keyboard. A new view can take focus as it is
      // attached - which is how the first list of a session, or the first
      // after the view was closed for being idle, pulled focus out of the
      // address bar and swallowed the Enter that followed.
      view.webContents.on('focus', () => this.focusChrome());
      this.suggestView = view;
      this.suggestReady = new Promise((resolve) => view.webContents.once('did-finish-load', resolve));
      view.webContents.loadFile(path.join(RENDERER_DIR, 'suggest.html')).catch(() => {});
      this.window.contentView.addChildView(view);
    }
    const origin = this.chromeView.getBounds();
    const { width: winW } = this.window.getContentBounds();
    const EDGE = 28;       // suggest.css's side padding, room for the list's shadow
    const x = Math.max(0, Math.round(origin.x + anchor.x) - EDGE);
    const width = Math.min(Math.max(Math.round(anchor.width) + EDGE * 2, 520), winW - x);
    this.suggestBox = { x, y: Math.round(origin.y + anchor.y) + 4, width };
    this.placeSuggestions();
    const wasOpen = this.suggestOpen;
    this.suggestOpen = true;
    if (!wasOpen) this.syncOverlay();
    this.suggestReady.then(() => {
      if (!this.suggestView || !this.suggestOpen) return;
      send(this.suggestView, 'debrowser:ui', { kind: 'suggest-items', items, selected: this.suggestSelected ?? -1 });
      if (!wasOpen) {
        // Topmost, over the page and over the chrome.
        this.window.contentView.addChildView(this.suggestView);
        this.suggestView.setVisible(true);
      }
    });
  }

  placeSuggestions() {
    if (!this.suggestView || !this.suggestBox) return;
    const { x, y, width } = this.suggestBox;
    const height = Math.max(1, this.suggestHeight || 8 * 34 + 24);
    this.suggestView.setBounds({ x, y, width, height });
  }

  /** The list measured itself: the view is exactly that tall. */
  sizeSuggestions(height) {
    if (!Number.isFinite(height) || height <= 0) return;
    this.suggestHeight = Math.min(Math.round(height), 600);
    this.placeSuggestions();
  }

  selectSuggestion(index) {
    this.suggestSelected = index;
    if (this.suggestView && this.suggestOpen) send(this.suggestView, 'debrowser:ui', { kind: 'suggest-select', index });
  }

  hideSuggestions() {
    if (!this.suggestView || !this.suggestOpen) return;
    this.suggestOpen = false;
    this.suggestSelected = -1;
    this.syncOverlay();
    this.suggestView.setVisible(false);
    send(this.suggestView, 'debrowser:ui', { kind: 'suggest-reset' });
    clearTimeout(this.suggestCloseTimer);
    this.suggestCloseTimer = setTimeout(() => this.closeSuggestions(), 60_000);
    this.suggestCloseTimer.unref?.();
  }

  closeSuggestions() {
    const view = this.suggestView;
    if (!view) return;
    this.suggestView = null;
    this.suggestOpen = false;
    this.syncOverlay();
    try {
      this.window.contentView.removeChildView(view);
      view.webContents.close();
    } catch { /* already gone */ }
  }

  /* ---------------------------------------------------------------- */
  /* Passkeys                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * The site's passkeys, in the browser's own list (passkeys.js).
   *
   * A view of its own sized to the card, like the address bar's suggestions,
   * not the window-sized sheet: as a dropdown under a sign-in field it must
   * leave the keyboard in that field and every click outside it to the page.
   * As a chooser under the address bar it takes the keyboard, so Escape and
   * the arrows work, and losing it is a dismissal. Gone when hidden: it is up
   * for seconds, a few times a day.
   *
   * @param {{mode: 'dropdown'|'chooser', site: string, accounts: object[],
   *   anchor: {x: number, y: number, width: number}}} model - the anchor in
   *   window coordinates: the field's bottom-left and width, or the middle of
   *   the top of the page
   */
  showPasskeys(model) {
    if (this.window.isDestroyed()) return;
    if (!this.passkeyView) {
      const view = new WebContentsView({
        webPreferences: {
          preload: CHROME_PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          additionalArguments: preloadArgs(this.prefs),
          transparent: true
        }
      });
      try { view.setBackgroundColor('#00000000'); } catch { /* opaque then */ }
      // Clicked away from, or Escape: the broker decides what that means.
      view.webContents.on('blur', () => {
        if (this.passkeyView === view && this.onPasskeysBlur) setImmediate(() => this.onPasskeysBlur());
      });
      this.passkeyView = view;
      this.passkeyHeight = 0;
      this.passkeyReady = new Promise((resolve) => view.webContents.once('did-finish-load', resolve));
      view.webContents.loadFile(path.join(RENDERER_DIR, 'passkeys.html')).catch(() => {});
      view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
      this.window.contentView.addChildView(view);   // topmost
    }
    const view = this.passkeyView;
    const EDGE = 16;   // passkeys.css's margin round the card, for its shadow
    const { width: winW, height: winH } = this.window.getContentBounds();
    const dropdown = model.mode === 'dropdown';
    const cardW = dropdown ? Math.min(Math.max(Math.round(model.anchor.width), 300), 420) : 380;
    const width = Math.min(cardW + EDGE * 2, winW);
    const left = dropdown ? model.anchor.x - EDGE : model.anchor.x - width / 2;
    this.passkeyBox = {
      x: Math.round(Math.max(0, Math.min(left, winW - width))),
      // The card's top 4px under the field, or 8px into the page.
      y: Math.round(Math.min(model.anchor.y + (dropdown ? 4 : 8) - EDGE, winH - 40)),
      width
    };
    this.placePasskeys();
    const chooser = !dropdown;
    this.passkeyReady.then(() => {
      if (this.passkeyView !== view || view.webContents.isDestroyed()) return;
      send(view, 'debrowser:ui', { kind: 'passkeys', ...model, prefs: this.prefs ? this.prefs.all() : null });
      if (chooser) view.webContents.focus();
    });
  }

  placePasskeys() {
    if (!this.passkeyView || !this.passkeyBox) return;
    const { x, y, width } = this.passkeyBox;
    // One pixel tall until the card has measured itself, so nothing
    // half-drawn shows.
    const height = Math.max(1, this.passkeyHeight || 1);
    this.passkeyView.setBounds({ x, y, width, height });
  }

  /** The card measured itself: the view is exactly that tall. */
  sizePasskeys(height) {
    if (!Number.isFinite(height) || height <= 0) return;
    this.passkeyHeight = Math.min(Math.round(height), 640);
    this.placePasskeys();
  }

  /**
   * The list asks for the Debrowser passcode instead (passkeys.js, confirm):
   * a Mac without Touch ID, or Linux. It takes the keyboard for it.
   */
  passcodePasskeys(model) {
    const view = this.passkeyView;
    if (!view) return;
    this.passkeyReady.then(() => {
      if (this.passkeyView !== view || view.webContents.isDestroyed()) return;
      send(view, 'debrowser:ui', { kind: 'passkeys-passcode', ...model });
      view.webContents.focus();
    });
  }

  /** Arrow down from the field: the keyboard into the list. */
  focusPasskeys() {
    const view = this.passkeyView;
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.focus();
      send(view, 'debrowser:ui', { kind: 'passkeys-focus' });
    }
  }

  passkeysFocused() {
    const view = this.passkeyView;
    return Boolean(view && !view.webContents.isDestroyed() && view.webContents.isFocused());
  }

  hidePasskeys() {
    const view = this.passkeyView;
    if (!view) return;
    this.passkeyView = null;
    this.passkeyBox = null;
    try {
      this.window.contentView.removeChildView(view);
      view.webContents.close();
    } catch { /* already gone */ }
  }

  /* ---------------------------------------------------------------- */
  /* Split view                                                        */
  /* ---------------------------------------------------------------- */

  /** Whether a tab is one of the pair on screen together. */
  inSplit(tab) {
    return Boolean(this.split && tab && (tab.id === this.split.left || tab.id === this.split.right));
  }

  /**
   * The two halves, while the tab in front is one of the pair; null otherwise,
   * and every tab has the whole content area as before.
   */
  splitBounds(area) {
    const s = this.split;
    const active = this.tabs.activeTab();
    if (!s || !this.inSplit(active) || !this.tabs.byId(s.left) || !this.tabs.byId(s.right)) return null;
    const leftW = Math.round((area.width - SPLIT_GAP) * s.ratio);
    const left = { x: area.x, y: area.y, width: leftW, height: area.height };
    const right = { x: area.x + leftW + SPLIT_GAP, y: area.y, width: area.width - leftW - SPLIT_GAP, height: area.height };
    return {
      // A private window's pages see whole steps only, half by half, so
      // dragging the divider a few pixels changes nothing a site can read.
      left: INCOGNITO ? letterbox(left) : left,
      right: INCOGNITO ? letterbox(right) : right,
      divider: { x: area.x + leftW, y: area.y, width: SPLIT_GAP, height: area.height }
    };
  }

  /** Set the pair (or clear it with null) and lay the window out again. */
  setSplit(split) {
    this.split = split ? { left: split.left, right: split.right, ratio: split.ratio ?? 0.5 } : null;
    this.layout();
  }

  /** The divider, which the pointer drags; `dragSplit` reads where it is. */
  placeDivider(halves) {
    if (!halves) {
      if (this.dividerView) this.dividerView.setVisible(false);
      return;
    }
    if (!this.dividerView) {
      const view = new WebContentsView({
        webPreferences: {
          preload: CHROME_PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          additionalArguments: preloadArgs(this.prefs),
          transparent: true
        }
      });
      try { view.setBackgroundColor('#00000000'); } catch { /* opaque then */ }
      view.webContents.loadFile(path.join(RENDERER_DIR, 'divider.html')).catch(() => {});
      this.dividerView = view;
    }
    const root = this.window.contentView;
    // Over the pages, under the chrome and anything floating above it.
    if (!root.children.includes(this.dividerView)) {
      const chromeAt = root.children.indexOf(this.chromeView);
      root.addChildView(this.dividerView, chromeAt === -1 ? undefined : chromeAt);
    }
    this.dividerView.setBounds(halves.divider);
    this.dividerView.setVisible(true);
  }

  /** The divider is being dragged: the split follows the pointer, within reason. */
  dragSplit() {
    if (!this.split || this.window.isDestroyed()) return;
    const area = this.contentBounds();
    const at = screen.getCursorScreenPoint();
    const win = this.window.getContentBounds();
    const x = at.x - win.x - area.x;
    this.split.ratio = Math.min(0.8, Math.max(0.2, x / Math.max(1, area.width)));
    this.layout();
  }

  /* ---------------------------------------------------------------- */
  /* Peek                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * A link opened in a card over the page, as Arc and Zen do: glance at it,
   * then Escape, a click outside or the close button puts it away - or "Open
   * as tab" keeps it. It is not a tab: no history, no place in the strip, no
   * renderer after it closes. In the opener's session, so it is signed in
   * wherever the page was.
   */
  openPeek(url, ses) {
    if (this.window.isDestroyed() || !/^https?:/i.test(String(url || ''))) return;
    this.closePeek();
    const backdrop = new WebContentsView({
      webPreferences: {
        preload: CHROME_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: preloadArgs(this.prefs),
        transparent: true
      }
    });
    try { backdrop.setBackgroundColor('#00000000'); } catch { /* opaque then */ }
    backdrop.webContents.loadFile(path.join(RENDERER_DIR, 'peek.html')).catch(() => {});
    const page = new WebContentsView({
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    page.setBackgroundColor(this.surface());
    setRadius(page, PEEK_RADIUS);
    const wc = page.webContents;
    // Anything it opens goes to a real tab; Escape anywhere puts it away.
    wc.setWindowOpenHandler(({ url: next }) => {
      if (/^https?:/i.test(next)) this.onCommand('new-tab', { url: next });
      return { action: 'deny' };
    });
    const escape = (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); this.closePeek(); }
    };
    wc.on('before-input-event', escape);
    backdrop.webContents.on('before-input-event', escape);
    const tell = () => {
      if (!this.peek || wc.isDestroyed()) return;
      send(backdrop, 'debrowser:ui', { kind: 'peek', url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading() });
    };
    for (const e of ['page-title-updated', 'did-navigate', 'did-stop-loading', 'did-start-loading']) wc.on(e, tell);
    backdrop.webContents.once('did-finish-load', tell);

    const root = this.window.contentView;
    const chromeAt = root.children.indexOf(this.chromeView);
    root.addChildView(backdrop, chromeAt === -1 ? undefined : chromeAt);
    root.addChildView(page, root.children.indexOf(backdrop) + 1);
    this.peek = { backdrop, page };
    this.placePeek();
    wc.loadURL(url).catch(() => {});
    wc.focus();
  }

  /** The card: inset from the content area, with room above it for its buttons. */
  placePeek() {
    if (!this.peek) return;
    const area = this.contentBounds();
    this.peek.backdrop.setBounds(area);
    const side = Math.max(24, Math.round(area.width * 0.08));
    this.peek.page.setBounds({
      x: area.x + side,
      y: area.y + PEEK_TOP,
      width: Math.max(200, area.width - side * 2),
      height: Math.max(160, area.height - PEEK_TOP - 28)
    });
  }

  /** Where the peek is now, for "Open as tab"; null when there is none. */
  peekUrl() {
    const wc = this.peek && this.peek.page.webContents;
    return wc && !wc.isDestroyed() ? wc.getURL() : null;
  }

  closePeek() {
    const peek = this.peek;
    if (!peek) return;
    this.peek = null;
    for (const view of [peek.page, peek.backdrop]) {
      try {
        this.window.contentView.removeChildView(view);
        view.webContents.close();
      } catch { /* already gone */ }
    }
    const active = this.tabs.activeTab();
    if (active && active.isLive) active.wc.focus();
  }

  /* ---------------------------------------------------------------- */
  /* Quick window (a Lab)                                              */
  /* ---------------------------------------------------------------- */

  /**
   * A link from another app, in a small window of its own, as Little Arc does:
   * read it and close it, or "Open in Debrowser" to keep it as a tab. Like a
   * Peek it is not a tab - nothing of it is kept once it closes - and it uses
   * the session the link would have opened in, so the blocker and the rest of
   * the session's protections apply to it as to any tab.
   */
  openQuick(url, ses, spaceId = null) {
    if (!/^https?:/i.test(String(url || ''))) return;
    this.closeQuick();
    const win = new BaseWindow({
      ...QUICK_SIZE,
      minWidth: 420,
      minHeight: 320,
      show: false,
      title: 'Debrowser',
      backgroundColor: this.surface()
    });
    const bar = new WebContentsView({
      webPreferences: {
        preload: CHROME_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: preloadArgs(this.prefs)
      }
    });
    bar.webContents.loadFile(path.join(RENDERER_DIR, 'quick.html')).catch(() => {});
    const page = new WebContentsView({
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    page.setBackgroundColor(this.surface());
    const wc = page.webContents;
    wc.setWindowOpenHandler(({ url: next }) => {
      if (/^https?:/i.test(next)) this.onCommand('new-tab', { url: next });
      return { action: 'deny' };
    });
    const tell = () => {
      if (!this.quick || wc.isDestroyed() || bar.webContents.isDestroyed()) return;
      send(bar, 'debrowser:ui', { kind: 'quick', url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading() });
      win.setTitle(wc.getTitle() || 'Debrowser');
    };
    for (const e of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-stop-loading', 'did-start-loading']) wc.on(e, tell);
    bar.webContents.once('did-finish-load', tell);

    win.contentView.addChildView(bar);
    win.contentView.addChildView(page);
    const place = () => {
      if (win.isDestroyed()) return;
      const { width, height } = win.getContentBounds();
      bar.setBounds({ x: 0, y: 0, width, height: QUICK_BAR });
      page.setBounds({ x: 0, y: QUICK_BAR, width, height: Math.max(0, height - QUICK_BAR) });
    };
    win.on('resize', place);
    win.on('closed', () => {
      if (this.quick && this.quick.win === win) this.quick = null;
      for (const view of [page, bar]) {
        try { view.webContents.close(); } catch { /* already gone */ }
      }
    });
    this.quick = { win, bar, page, spaceId };
    // It belongs to this window: it goes when the browser does. Added once,
    // not on every link opened.
    if (!this.quickWatched) {
      this.quickWatched = true;
      this.window.once('closed', () => this.closeQuick());
    }
    place();
    wc.loadURL(url).catch(() => {});
    win.show();
    wc.focus();
  }

  /** Where the quick window is now, for "Open in Debrowser"; null when there is none. */
  quickUrl() {
    const wc = this.quick && this.quick.page.webContents;
    return wc && !wc.isDestroyed() ? wc.getURL() : null;
  }

  closeQuick() {
    const quick = this.quick;
    if (!quick) return;
    this.quick = null;
    if (!quick.win.isDestroyed()) quick.win.close();
  }

  /* ---------------------------------------------------------------- */
  /* Toasts                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * A line at the foot of the window - "Closed 4 tabs", with Undo - that goes
   * by itself after a few seconds.
   *
   * Its own small view, over the page, because the chrome view is only as tall
   * as the toolbar. Made on first use and closed a minute after the last toast,
   * so a browser nobody undoes anything in holds no renderer for it.
   *
   * @param {{id: string, text: string, action?: string, ms?: number}} toast
   */
  showToast(toast) {
    if (this.window.isDestroyed()) return;
    this.lastToastId = toast.id;
    clearTimeout(this.toastCloseTimer);
    if (!this.toastView) {
      const view = new WebContentsView({
        webPreferences: {
          preload: CHROME_PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          additionalArguments: preloadArgs(this.prefs),
          transparent: true
        }
      });
      try { view.setBackgroundColor('#00000000'); } catch { /* opaque then */ }
      view.setVisible(false);
      this.toastView = view;
      this.toastReady = new Promise((resolve) => view.webContents.once('did-finish-load', resolve));
      view.webContents.loadFile(path.join(RENDERER_DIR, 'toast.html')).catch(() => {});
    }
    this.toastReady.then(() => {
      if (!this.toastView || this.window.isDestroyed()) return;
      this.placeToast();
      // Topmost, over the page, the panel and the chrome.
      this.window.contentView.addChildView(this.toastView);
      this.toastView.setVisible(true);
      send(this.toastView, 'debrowser:ui', { kind: 'toast', ...toast });
    });
  }

  /** Centred at the foot of the page area, with room for its shadow. */
  placeToast() {
    if (!this.toastView) return;
    const area = this.contentBounds();
    const width = Math.min(TOAST_WIDTH, area.width);
    this.toastView.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.max(area.y, area.y + area.height - TOAST_HEIGHT),
      width,
      height: Math.min(TOAST_HEIGHT, area.height)
    });
  }

  /** The toast went (timed out, undone or dismissed): hide it, and close the view later. */
  hideToast() {
    if (!this.toastView) return;
    this.toastView.setVisible(false);
    clearTimeout(this.toastCloseTimer);
    this.toastCloseTimer = setTimeout(() => {
      const view = this.toastView;
      this.toastView = null;
      try {
        this.window.contentView.removeChildView(view);
        view.webContents.close();
      } catch { /* already gone */ }
    }, 60_000);
    this.toastCloseTimer.unref?.();
  }

  /* ---------------------------------------------------------------- */
  /* A crashed tab                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Cover the content area with "This tab stopped working" while the active
   * tab's renderer is dead, or take it away.
   *
   * A view of the window's rather than a page in the tab: a crashed renderer
   * cannot be drawn into, and loading anything in its place would add a
   * history entry and change what the address bar says. Reload from here, the
   * toolbar or the keyboard brings the page back in the same entry.
   *
   * Created when needed and destroyed after, like the menu: crashes are rare,
   * and a renderer held for one would be a cost paid every day for nothing.
   */
  showCrashed(on) {
    if (this.window.isDestroyed()) return;
    if (!on) {
      const view = this.crashView;
      if (!view) return;
      this.crashView = null;
      try {
        this.window.contentView.removeChildView(view);
        view.webContents.close();
      } catch { /* already gone */ }
      return;
    }
    if (!this.crashView) {
      const view = new WebContentsView({
        webPreferences: {
          preload: CHROME_PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          additionalArguments: preloadArgs(this.prefs)
        }
      });
      view.setBackgroundColor(this.surface());
      view.webContents.loadFile(path.join(RENDERER_DIR, 'crashed.html')).catch(() => {});
      // Ctrl+R and F5 reload from here, as they would from the page it covers.
      this.bindShortcuts(view.webContents);
      setRadius(view, this.vertical() && !this.fullScreen() ? CONTENT_RADIUS : 0);
      // Above the tabs, below the chrome, as the restore placeholder is.
      const chromeIndex = this.window.contentView.children.indexOf(this.chromeView);
      this.window.contentView.addChildView(view, chromeIndex === -1 ? undefined : chromeIndex);
      this.crashView = view;
    }
    this.crashView.setBounds(this.contentBounds());
  }

  /* ---------------------------------------------------------------- */
  /* Developer tools                                                   */
  /* ---------------------------------------------------------------- */

  /** Where the user wants the inspector. */
  dockMode() {
    const mode = this.prefs ? this.prefs.get('devToolsDock') : 'right';
    return mode === 'bottom' || mode === 'window' ? mode : 'right';
  }

  /**
   * Open the inspector on a tab, or close it if it is already on that one.
   *
   * One inspector at a time. Chromium allows one per tab and this could too,
   * but every open inspector is a live renderer of its own - considerably
   * heavier than the page it is inspecting - and a browser arguing that tabs
   * should be cheap has no business quietly holding six of them.
   */
  toggleDevTools(tab) {
    if (!tab || !tab.isLive) return false;

    if (this.devToolsTab === tab) {
      this.closeDevTools();
      return false;
    }

    // Whatever was open belonged to another tab, or to another dock mode.
    this.closeDevTools();

    const mode = this.dockMode();
    if (mode === 'window') {
      try {
        tab.wc.openDevTools({ mode: 'detach', activate: true });
      } catch (err) {
        this.log(`devtools failed for tab ${tab.id}: ${err.message}`);
        return false;
      }
      // Tracked even with no view of ours, so there is one place that knows
      // which tab is being inspected however it is being shown.
      this.devToolsTab = tab;
      this.devToolsMode = mode;
      tab.wc.once('devtools-closed', () => this.closeDevTools());
      return true;
    }

    let view;
    try {
      view = new WebContentsView();
      // Some of the browser's keys work in the inspector too: F12 closes it
      // again, as in Chrome, and Ctrl+T still opens a tab. Only those that
      // DevTools has no use for - it has its own Ctrl+P, Ctrl+F, Ctrl+S,
      // Ctrl+L, Ctrl+/ and Ctrl+[ and ], and the browser's took them away.
      this.bindShortcuts(view.webContents, null, { only: DEVTOOLS_KEYS });
      this.window.contentView.addChildView(view);
      tab.wc.setDevToolsWebContents(view.webContents);
      // Still 'detach', even though nothing detaches: it is what tells Chromium
      // not to manage the placement itself, which is the whole point here.
      tab.wc.openDevTools({ mode: 'detach' });
    } catch (err) {
      this.log(`devtools failed for tab ${tab.id}: ${err.message}`);
      if (view) {
        try { this.window.contentView.removeChildView(view); view.webContents.close(); } catch { /* gone */ }
      }
      return false;
    }

    this.devToolsView = view;
    this.devToolsTab = tab;
    this.devToolsMode = mode;

    // The inspector has its own close button, and nothing else would tell us it
    // had been used. Tracking open-ness as a flag on the tab would go stale in
    // the direction that matters - a tab held out of the reclaim ladder forever
    // by tools that are no longer there - so the event is what clears it.
    tab.devToolsHost = view.webContents;
    tab.wc.once('devtools-closed', () => this.closeDevTools());

    this.layout();
    return true;
  }

  /** Tear down whichever inspector is open, docked or windowed. */
  closeDevTools() {
    const tab = this.devToolsTab;
    const view = this.devToolsView;
    // Cleared first: `closeDevTools` on the page fires `devtools-closed`, whose
    // handler calls straight back into here.
    this.devToolsTab = null;
    this.devToolsView = null;
    this.devToolsMode = null;

    if (tab) {
      tab.devToolsHost = null;
      if (tab.isLive) {
        try { tab.wc.closeDevTools(); } catch { /* gone */ }
      }
    }

    this.placeDevToolsDivider(null);
    if (view) {
      try {
        this.window.contentView.removeChildView(view);
        view.webContents.close();
      } catch { /* already gone */ }
      // Only a docked inspector was taking room, so only that needs a relayout.
      this.layout();
    }
  }

  /**
   * Re-dock after the preference changed.
   *
   * Closing and reopening rather than moving the view: the mode decides whether
   * the inspector lives in a view of ours or in a window of Chromium's, and
   * those are not the same object to reposition.
   */
  redockDevTools() {
    if (!this.devToolsMode || this.devToolsMode === this.dockMode()) return;
    const tab = this.devToolsTab;
    this.closeDevTools();
    if (!tab || !tab.isLive) return;

    // Reopened on a timer rather than in this turn.
    //
    // Closing an inspector is asynchronous, and an open that races the teardown
    // is swallowed - measured: reopening immediately left no inspector at all,
    // while the same sequence with a gap worked. The delay is invisible against
    // a setting the user just changed, and the guard means a second change, or
    // a tab closing in the meantime, wins over this one.
    clearTimeout(this.devToolsRedock);
    this.devToolsRedock = setTimeout(() => {
      if (this.window.isDestroyed() || this.devToolsTab || !tab.isLive) return;
      this.toggleDevTools(tab);
    }, DEVTOOLS_REDOCK_MS);
  }

  /**
   * The rectangle the inspector occupies, or null when it is not taking space.
   *
   * It takes space only while the tab it belongs to is the one on screen -
   * the inspector for a background tab is neither useful nor visible, and
   * reserving room for it would shrink whatever page the user is actually
   * looking at.
   */
  dockBounds(content) {
    if (!this.devToolsView || !this.devToolsTab || !this.devToolsTab.visible) return null;

    // As dragged, but never so much that the page or the inspector is a sliver.
    const share = (room) => Math.min(room - DEVTOOLS_PAGE_MIN,
      Math.max(DEVTOOLS_MIN, Math.round(room * this.devToolsShare)));
    if (this.dockMode() === 'bottom') {
      const height = share(content.height);
      if (height < DEVTOOLS_MIN) return null;  // no room worth splitting
      return { x: content.x, y: content.y + content.height - height, width: content.width, height };
    }

    const width = share(content.width);
    if (width < DEVTOOLS_MIN) return null;
    return { x: content.x + content.width - width, y: content.y, width, height: content.height };
  }

  /**
   * The edge between the page and a docked inspector, which the pointer drags
   * (divider.js, `?for=devtools`). Astride the boundary and just above the
   * inspector, so its own toolbar keeps every click beside it. Made the first
   * time it is needed and kept, hidden, while there is no dock; gone with the
   * inspector itself.
   */
  placeDevToolsDivider(dock) {
    const root = this.window.contentView;
    if (!dock) {
      if (this.devToolsDivider && !this.devToolsView) {
        const view = this.devToolsDivider;
        this.devToolsDivider = null;
        try { root.removeChildView(view); view.webContents.close(); } catch { /* window going */ }
      } else if (this.devToolsDivider) {
        this.devToolsDivider.setVisible(false);
      }
      return;
    }
    const row = this.dockMode() === 'bottom';
    if (this.devToolsDivider && this.devToolsDivider.axis !== (row ? 'row' : 'col')) {
      try { root.removeChildView(this.devToolsDivider); this.devToolsDivider.webContents.close(); } catch { /* gone */ }
      this.devToolsDivider = null;
    }
    if (!this.devToolsDivider) {
      const view = new WebContentsView({
        webPreferences: {
          preload: CHROME_PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          additionalArguments: preloadArgs(this.prefs),
          transparent: true
        }
      });
      try { view.setBackgroundColor('#00000000'); } catch { /* opaque then */ }
      view.axis = row ? 'row' : 'col';
      view.webContents.loadFile(path.join(RENDERER_DIR, 'divider.html'),
        { query: row ? { for: 'devtools', axis: 'row' } : { for: 'devtools' } }).catch(() => {});
      this.devToolsDivider = view;
    }
    const at = root.children.indexOf(this.devToolsView);
    if (root.children.indexOf(this.devToolsDivider) !== at + 1) {
      if (root.children.includes(this.devToolsDivider)) root.removeChildView(this.devToolsDivider);
      root.addChildView(this.devToolsDivider, root.children.indexOf(this.devToolsView) + 1);
    }
    const half = DEVTOOLS_GRIP / 2;
    this.devToolsDivider.setBounds(row
      ? { x: dock.x, y: dock.y - half, width: dock.width, height: DEVTOOLS_GRIP }
      : { x: dock.x - half, y: dock.y, width: DEVTOOLS_GRIP, height: dock.height });
    this.devToolsDivider.setVisible(true);
  }

  /** The edge is being dragged: the inspector's share follows the pointer. */
  dragDevTools() {
    if (!this.devToolsView || this.window.isDestroyed()) return;
    const area = this.contentArea();
    const at = screen.getCursorScreenPoint();
    const win = this.window.getContentBounds();
    const row = this.dockMode() === 'bottom';
    const room = row ? area.height : area.width;
    const taken = row ? area.y + area.height - (at.y - win.y) : area.x + area.width - (at.x - win.x);
    this.devToolsShare = Math.min(0.9, Math.max(0.1, taken / Math.max(1, room)));
    this.layout();
  }

  /* ---------------------------------------------------------------- */

  togglePanel(open = !this.panelOpen) {
    if (open === this.panelOpen) return this.panelOpen;
    this.panelOpen = open;

    if (open) {
      this.panelView = new WebContentsView({
        webPreferences: {
          preload: CHROME_PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          additionalArguments: preloadArgs(this.prefs)
        }
      });
      // Below an open menu, not over it: Ctrl+M with the menu open put the
      // menu underneath the panel.
      const root = this.window.contentView;
      const sheet = this.sheetView ? root.children.indexOf(this.sheetView) : -1;
      root.addChildView(this.panelView, sheet === -1 ? undefined : sheet);
      this.bindShortcuts(this.panelView.webContents);
      this.panelView.webContents.loadFile(path.join(RENDERER_DIR, 'panel.html'));
    } else if (this.panelView) {
      // Destroy rather than hide. A task manager that costs a live renderer
      // while closed would be an embarrassing thing for this browser to ship.
      try {
        this.window.contentView.removeChildView(this.panelView);
        this.panelView.webContents.close();
      } catch { /* already gone */ }
      this.panelView = null;
    }

    this.layout();
    return this.panelOpen;
  }

  /* ---------------------------------------------------------------- */

  /**
   * Personalisation that belongs to the window rather than to a stylesheet.
   *
   * Both of these are asked of the OS compositor, which is already drawing this
   * window and every other one on the screen. Doing the same thing ourselves -
   * a transparent window with a blurred backdrop painted in CSS - would mean an
   * alpha surface and a blur pass on every frame, for a browser whose whole
   * claim is about not spending resources it does not have to.
   */
  applyWindowPrefs() {
    if (!this.prefs || this.window.isDestroyed()) return;

    // Where the inspector goes is a window preference like any other, and it is
    // the one the user is most likely to change while looking at the thing it
    // moves. `redockDevTools` is a no-op unless the mode actually changed.
    this.redockDevTools();

    // The engine's own idea of the theme follows the browser's: developer
    // tools stayed light beside a dark browser, and so did native dialogs.
    // Websites see it too, as prefers-color-scheme - which is what Chrome
    // tells them. Private windows set their own and are not touched by this.
    const theme = this.prefs.get('theme');
    const source = theme === 'light' || theme === 'dark' ? theme : 'system';
    if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;

    // The two views that are not sent the state broadcast take the new palette
    // here, so a theme changed while one exists does not leave it in the old one.
    const prefs = this.prefs.all();
    send(this.suggestView, 'debrowser:state', { prefs });
    send(this.crashView, 'debrowser:state', { prefs });
    send(this.toastView, 'debrowser:state', { prefs });
    send(this.dividerView, 'debrowser:state', { prefs });
    send(this.devToolsDivider, 'debrowser:state', { prefs });

    // Pinned at 1, and set rather than skipped.
    //
    // This used to be `setOpacity(windowOpacity)`, which fades the *entire
    // window* - every pixel of every page, text included. That is not what
    // translucency means anywhere else: Mica and Acrylic fade and blur the
    // backdrop while content stays fully opaque. At 0.6 the result was a
    // browser you could not read, with whatever was behind it showing through
    // razor sharp because nothing was blurring it either.
    //
    // Translucency now lives on the tab strip alone, painted in the chrome's
    // own CSS. Assigning 1 here rather than leaving the call out matters for
    // anyone upgrading with a low value already saved: the setting would
    // otherwise stay applied to the whole window for the life of that install.
    try {
      this.window.setOpacity(1);
    } catch (err) {
      // Linux without a compositing window manager has no opacity to set.
      this.log(`window opacity unavailable: ${err.message}`);
    }

    // Windows 11 only, and only where this build of Electron has the API. A
    // silent no-op elsewhere is correct: the setting simply does not apply.
    //
    // A translucent strip needs something behind it to show. Where the user has
    // asked for translucency and not picked a material, acrylic is chosen for
    // them - the alternative is a setting that visibly does nothing, because
    // without a material there is only the window's own background colour
    // behind the chrome and the strip just tints towards it.
    let material = this.prefs.get('backgroundMaterial');
    const translucent = this.translucentNow();
    if (material === 'none' && translucent) material = 'acrylic';
    // Only 'none' when translucency is off here rather than in the settings:
    // a strip that slides over the page cannot show the desktop, so a window
    // of glass round an opaque strip is all that setting could give there.
    if (!translucent && this.prefs.get('windowOpacity') < 1) material = 'none';
    this.material = material;

    // A translucent strip shows whatever is behind it, and behind it is the
    // window's own background unless that is cleared too. Both the window and
    // the chrome's view have to give way, or the alpha in the stylesheet just
    // blends towards an opaque colour and the setting looks broken.
    //
    // Only while translucency is asked for. An opaque surface is cheaper to
    // composite, and a transparent window on a desktop with no compositor is a
    // window with artefacts rather than a window with a view.
    // The opaque case follows the theme for the same reason `stripColour` does:
    // this is what shows in the gap around the content card and behind an
    // unpainted view, and a dark window under a paper-white UI is a black frame
    // around the page.
    const sheer = translucent ? '#00000000' : this.surface();
    // Down the side, the window itself shows round the page - the band across
    // the top and the gutters - wherever the strip's view does not reach. Left
    // clear, that was bare material beside a tinted strip: a grey band with
    // the window buttons in a dark box of their own. Tinted like the strip, it
    // is one surface with it.
    const opacity = this.prefs.get('windowOpacity');
    const windowBg = !translucent || !this.vertical() ? sheer
      : this.seeThrough() ? withAlpha(this.stripColour(), opacity, 'argb') : this.stripColour();
    try {
      this.window.setBackgroundColor(windowBg);
      // Detached, the chrome's view is clear: collapsed it is an invisible
      // edge over the page rather than a painted stripe, and out it is a panel
      // that slides in over the page, which needs the page behind it.
      // Down the side the view is clear and the page draws every surface
      // itself: the strip that slides out over the page moves its own
      // background with it, and an opaque view behind would stay put.
      this.chromeView.setBackgroundColor(this.vertical() ? '#00000000' : sheer);
    } catch (err) {
      this.log(`transparent chrome unavailable: ${err.message}`);
    }
    if (typeof this.window.setBackgroundMaterial === 'function') {
      try {
        this.window.setBackgroundMaterial(material);
      } catch (err) {
        this.log(`background material unavailable: ${err.message}`);
      }
    }

    // Moving the strip changes every view's rectangle, not just the chrome's,
    // so the whole layout is re-asserted. Only when it actually changed: this
    // runs on every preference write, and re-laying out on a colour change
    // would resize every live tab for nothing.
    //
    // The bookmarks bar is the same kind of change for the same reason: showing
    // it takes 34px from every tab's rectangle, and hiding it gives them back.
    if (this.laidOutVertical !== this.vertical() ||
        this.laidOutBookmarksBar !== this.bookmarksBarVisible() ||
        this.laidOutPinned !== this.sidebarPinned() ||
        this.laidOutDetached !== this.detached()) {
      const wasPinned = this.laidOutPinned;
      this.laidOutDetached = this.detached();
      this.laidOutVertical = this.vertical();
      this.laidOutBookmarksBar = this.bookmarksBarVisible();
      this.laidOutPinned = this.sidebarPinned();

      // Unpinning leaves the strip out until the pointer goes elsewhere, which
      // is what it would do if the pointer were over it - and it is, since the
      // button that unpinned it is in it.
      //
      // Only on that transition. The test was `if (this.laidOutPinned)`, which
      // is true exactly when the strip has just been *pinned* - where the flag
      // is irrelevant - and false when it has just been unpinned, which is the
      // one case this line is for: so unpinning collapsed the column to ten
      // pixels under the pointer that had just pressed the button, and neither
      // `mouseenter` nor the `mousemove` fallback fires again until the pointer
      // leaves the window and comes back. Writing the flag unconditionally is
      // the other way to be wrong: it would hold the strip out on every change
      // that reaches here, including simply switching into this layout.
      if (wasPinned === true && this.laidOutPinned === false) this.sidebarOpen = true;
      this.layout();
    }

    // Keep the system's window buttons legible against whatever the strip is.
    const strip = this.stripColour();
    if (process.platform !== 'darwin' && typeof this.window.setTitleBarOverlay === 'function') {
      try {
        // Tinted to match when translucent, rather than an opaque box sitting
        // on a see-through band.
        const translucent = this.translucentNow() && this.seeThrough();
        const color = translucent ? withAlpha(strip, this.prefs.get('windowOpacity'), 'rgba') : strip;
        this.window.setTitleBarOverlay({ color, symbolColor: this.symbolColour(), height: 40 });
      } catch { /* no overlay on this platform */ }
    }
  }

  /**
   * What colour the tab strip is, resolving 'mirror' and 'default'.
   *
   * The default follows the theme, which it did not: this fed the system's
   * caption-button overlay a near-black on a paper-white strip whenever the
   * light theme was in force, so the window's own minimise and close buttons
   * sat in a dark band the browser had not drawn. `--strip` is `var(--bg)` in
   * the stylesheet, and these two have to name the same colour.
   */
  stripColour() {
    const choice = this.prefs ? this.prefs.get('tabBarColor') : 'default';
    if (choice === 'mirror') return this.prefs.get('accent');
    if (choice === 'default') return this.surface();
    return choice;
  }

  /**
   * Whether the light palette is in force, by the same rule the stylesheet
   * uses: an explicit choice wins, and 'system' follows the machine.
   */
  lightTheme() {
    const choice = this.prefs ? this.prefs.get('theme') : 'system';
    if (choice === 'light') return true;
    if (choice === 'dark') return false;
    return !nativeTheme.shouldUseDarkColors;
  }

  /** The theme's surface colour - what the window shows where nothing is drawn. */
  surface() {
    return paletteFor(this.prefs ? this.prefs.get('design') : 'legacy', this.lightTheme()).bg;
  }

  /** The window buttons' own colour, which has to read against the strip. */
  symbolColour() {
    return paletteFor(this.prefs ? this.prefs.get('design') : 'legacy', this.lightTheme()).dim;
  }

  /* ---------------------------------------------------------------- */

  /** True when the tab strip runs down the side rather than across the top. */
  vertical() {
    return this.prefs ? this.prefs.get('tabBarPosition') === 'left' : false;
  }

  /**
   * The whole area below and beside the chrome, before the inspector takes its
   * share of it. What a tab would fill if nothing were docked.
   */
  /**
   * Is the bookmarks bar taking a strip of the window?
   *
   * Only in horizontal mode. With the strip down the side the chrome already
   * owns a full-height column, so bookmarks go in it and cost the content area
   * nothing - which is the whole reason a sidebar is worth having.
   */
  bookmarksBarVisible() {
    if (this.vertical()) return false;
    if (this.prefs && this.prefs.get('showBookmarksBar') === false) return false;
    // An empty bar is 34px of nothing taken from the page. The preference says
    // whether the bar is wanted; this says whether there is anything to put in
    // it, and until the first bookmark is saved the answer is no.
    return Boolean(this.bookmarks && this.bookmarks.all().length > 0);
  }

  /** How much vertical room the chrome needs, bars included. */
  chromeHeight() {
    return CHROME_HEIGHT +
      (this.bookmarksBarVisible() ? BOOKMARKS_BAR_HEIGHT : 0) +
      (this.findOpen ? FIND_BAR_HEIGHT : 0);
  }

  /**
   * Where a panel hanging off the toolbar should start.
   *
   * The downloads flyout needs this when it is opened from the menu or from
   * Ctrl+J, which carry no anchor because only the chrome knows where its own
   * button ended up. It used to ask `chromeHeight()`, which is the height of
   * the *top* chrome and means nothing in the side layout - so that accessor
   * grew a layout special case to keep one unrelated consumer from moving. This
   * is the number that consumer actually wanted, in both layouts.
   */
  toolbarAnchor() {
    return this.contentArea().y;
  }

  /**
   * Show or hide the find bar, and give the page its room back when it closes.
   *
   * The bar is drawn by the chrome, but its height is the window's business,
   * exactly as the bookmarks bar's is: the content area starts below the
   * chrome, so a bar the window has not accounted for is painted over the page.
   */
  setFindOpen(open) {
    const want = Boolean(open);
    if (this.findOpen === want) {
      // Already up. A second Ctrl+F puts the caret back in it and selects what
      // is there, which is what every browser does; closing the bar someone is
      // trying to type into would not be.
      if (want) this.toChrome('find-focus');
      return;
    }
    this.findOpen = want;
    // The bar is drawn inside the chrome, and down the side the chrome is a
    // column that is ten pixels wide until the pointer reaches it - so a find
    // bar opened from the keyboard was laid out off the side of the window,
    // where it could be neither seen nor typed into. Opening the bar slides the
    // strip out and closing it gives it back to the pointer; `setSidebarOpen`
    // declines to close it while the bar is up.
    //
    // Unconditional rather than `if (vertical())`: across the top the flag is
    // read by nothing - `sidebarWidth()` returns 0 there - so testing the
    // layout here would be the caller knowing something the mechanism already
    // knows.
    clearTimeout(this.sidebarCloseTimer);
    // Closing leaves the strip out if the pointer is on it - snapping it shut
    // under the pointer was the bar closing the thing being pointed at.
    this.sidebarOpen = want || this.sidebarPinned() || this.sidebarPointerOver === true || this.sidebarHeld();
    this.layout();
    // Told now, not on the next state broadcast: tucked away, the chrome did
    // not know it was out, so the bar stayed hidden, the focus below found
    // nothing to focus, and the first keys typed went nowhere.
    this.publishSidebar();
    this.toChrome(want ? 'find-focus' : 'find-closed');
  }

  /**
   * Out for the keyboard - Ctrl+L, F6 - wherever the pointer is. The address
   * bar lives in the strip, so with the strip tucked away focusing it focused
   * nothing. Typing in it holds the strip out; leaving the field lets it go.
   */
  bringSidebarOut() {
    if (!this.vertical() || this.sidebarPinned() || this.sidebarOpen) return;
    clearTimeout(this.sidebarCloseTimer);
    clearTimeout(this.sidebarOpenTimer);
    if (this.sidebarSliding) {
      clearTimeout(this.sidebarSliding);
      this.sidebarSliding = null;
      this.toChrome('sidebar-slide', { out: false });
    }
    this.sidebarOpen = true;
    this.layout();
    this.publishSidebar();
  }

  /**
   * The tab list, tucked away in a window: the chrome's own page in a second,
   * small view (`?role=strip`) holding only the list and the find bar, over
   * the page's left edge under the band. It covers the panel's column and
   * nothing else, so the page keeps every click, wheel, drag and drop beside
   * it. Made on the first band layout and kept, hidden, while the band lasts,
   * so bringing the tabs out is a slide and not a page load; gone with the
   * band, since every other shape draws its tabs in the chrome view.
   */
  layStrip(width, height) {
    if (!this.band()) {
      if (this.stripView) {
        const view = this.stripView;
        this.stripView = null;
        try { this.window.contentView.removeChildView(view); } catch { /* window going */ }
        if (!view.webContents.isDestroyed()) view.webContents.close();
      }
      return;
    }
    if (!this.stripView) this.createStrip();
    const shown = this.sidebarOpen || Boolean(this.sidebarSliding);
    this.stripView.setBounds({
      x: 0, y: SIDEBAR_TOP_BAND, width: STRIP_VIEW_WIDTH, height: Math.max(0, height - SIDEBAR_TOP_BAND)
    });
    // Just above the chrome, so a menu or sheet opened later still lies over it.
    const root = this.window.contentView;
    const at = root.children.indexOf(this.stripView);
    const chromeAt = root.children.indexOf(this.chromeView);
    if (at !== chromeAt + 1) {
      root.removeChildView(this.stripView);
      root.addChildView(this.stripView, root.children.indexOf(this.chromeView) + 1);
    }
    this.stripView.setVisible(shown);
  }

  createStrip() {
    const view = new WebContentsView({
      webPreferences: {
        preload: CHROME_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        additionalArguments: preloadArgs(this.prefs)
      }
    });
    try { view.setBackgroundColor('#00000000'); } catch { /* opaque then */ }
    view.setVisible(false);
    this.bindShortcuts(view.webContents);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.once('did-finish-load', () => this.onCommand('chrome-ready'));
    view.webContents.loadFile(path.join(RENDERER_DIR, 'chrome.html'), { query: { role: 'strip' } }).catch(() => {});
    this.window.contentView.addChildView(view);
    this.stripView = view;
  }

  /** Where a view of the chrome's sits in the window, for coordinates it sends. */
  chromeOrigin(sender) {
    const wc = this.stripView && this.stripView.webContents;
    if (sender && wc && !wc.isDestroyed() && wc.id === sender.id) return { x: 0, y: SIDEBAR_TOP_BAND };
    return { x: 0, y: 0 };
  }

  /** A one-off message to the chrome, for the things that are not state. */
  toChrome(kind, payload = null) {
    send(this.chromeView, 'debrowser:ui', { kind, ...(payload || {}) });
    // The tab list's own view, tucked away, gets the same: it runs the same
    // page and ignores what is not about the tabs, the find bar or its shape.
    if (this.stripView) send(this.stripView, 'debrowser:ui', { kind, ...(payload || {}) });
  }

  /** The find bar's view: the tab list's, tucked away; the chrome's otherwise. */
  focusFind() {
    const wc = (this.band() && this.stripView ? this.stripView : this.chromeView).webContents;
    if (wc && !wc.isDestroyed()) wc.focus();
  }

  /** Put the keyboard back in the chrome - for Ctrl+L, and for the find bar. */
  focusChrome() {
    const wc = this.chromeView && this.chromeView.webContents;
    if (wc && !wc.isDestroyed()) wc.focus();
  }

  /** Focus came to or left the chrome; only full screen across the top cares. */
  setChromeFocused(focused) {
    if (this.chromeFocused === focused) return;
    this.chromeFocused = focused;
    if (this.fullScreen() && !this.vertical()) this.layout();
  }

  /** Is the window full screen? False once it is destroyed, rather than a throw. */
  fullScreen() {
    return !this.window.isDestroyed() && this.window.isFullScreen();
  }

  /**
   * Full screen, down the side: the strip becomes a panel over the page.
   *
   * Not across the top, where full screen hides the chrome outright - there the
   * page can simply have the room. See `chromeHidden`.
   */
  chromeFloats() {
    // Unpinned, only while it is out; collapsed it is the edge at x=0, full
    // screen or not. It was laid out as a floating ten-pixel panel ten pixels
    // in, so a pointer pushed to the screen edge landed on the page instead.
    // In a window the band stays across the top and the tabs come out under
    // it (see `layout`), so only full screen floats.
    return this.vertical() && (this.detached() ? this.sidebarOpen && !this.band() : this.fullScreen());
  }

  /**
   * Down the side, not pinned: the page has the whole window and the strip -
   * toolbar, address bar and tabs together - floats over it while the pointer
   * wants it. Zen's compact mode, single toolbar. Full screen already is this
   * shape, so it does not count twice.
   */
  detached() {
    return this.vertical() && !this.sidebarPinned();
  }

  /**
   * Tucked away in a window: a slim bar across the top holds the toolbar while
   * the strip is in, so the window buttons sit over that bar rather than over
   * the page's own top-right corner - where sites keep their account menus.
   */
  band() {
    return this.detached() && !this.fullScreen();
  }

  /**
   * Full screen, across the top: no chrome at all.
   *
   * Except while something in it is being used. The find bar lives in the
   * chrome, so hiding the chrome while a search is open would be a search box
   * the user cannot see typing into a page they cannot leave; the same goes for
   * the address bar, which is why the chrome's own focus is part of this. Both
   * bring the bar back for as long as they hold it, and full screen takes it
   * away again the moment they let go.
   */
  chromeHidden() {
    return this.fullScreen() && !this.vertical() && !this.findOpen && !this.chromeFocused;
  }

  /** What the chrome needs to know about its own shape. */
  sidebarState() {
    if (!this.vertical() || this.window.isDestroyed()) return null;
    return {
      pinned: this.sidebarPinned(),
      open: this.sidebarPinned() || this.sidebarOpen,
      floating: this.chromeFloats(),
      detached: this.detached(),
      band: this.band()
    };
  }

  /**
   * Tell the chrome its shape changed, without waiting for the governor.
   *
   * The state broadcast carries this too, but it arrives on the governor's own
   * tick - up to half a second after the window entered full screen, which is
   * half a second of a full-height strip drawn over a full-screen page.
   */
  publishSidebar() {
    this.toChrome('sidebar', { sidebar: this.sidebarState() });
  }

  /**
   * How tall the floating panel wants to be, as the chrome measures itself.
   *
   * The chrome is the only thing that can answer: the height is its tab rows,
   * its toolbar, whichever bars are up and how many tabs there are. Clamped
   * here rather than there, because the window is the only thing that knows how
   * much room there is to give.
   */
  setChromeHeight(height) {
    const want = Math.round(Number(height) || 0);
    if (!Number.isFinite(want) || want <= 0 || want === this.chromeWantsHeight) return;
    this.chromeWantsHeight = want;
    if (this.chromeFloats()) this.layout();
  }

  /** The browser's own "reduce motion", or the system's. */
  reducedMotion() {
    if (this.prefs && this.prefs.get('reduceMotion') === true) return true;
    try {
      return Boolean(systemPreferences.getAnimationSettings?.().prefersReducedMotion);
    } catch {
      return false;
    }
  }

  /** Is the sidebar held open, rather than sliding away when the pointer goes? */
  sidebarPinned() {
    return this.prefs ? this.prefs.get('sidebarPinned') === true : false;
  }

  /**
   * The left edge, watched from here as well as by the chrome's own hover.
   *
   * On Windows the outer pixels of a frameless window are its resize border:
   * the system hit-tests them itself, and the page underneath never hears the
   * pointer. A pointer pushed against the screen's edge - the natural way to
   * reach it - stopped there, so the strip opened on some tries and not
   * others. While the strip is tucked away and the window has the keyboard,
   * the cursor's position is read a few times a second instead, which no
   * border can hide.
   */
  watchEdge() {
    const want = this.detached() && !this.sidebarOpen && !this.window.isDestroyed() &&
      this.window.isVisible() && !this.window.isMinimized();
    if (!want) {
      clearTimeout(this.edgeTimer);
      this.edgeTimer = null;
      this.edgeHeld = false;
      return;
    }
    if (this.edgeTimer) return;
    // Paced by how far the pointer is from the edge: every 25ms - two frames,
    // as quick as the pointer's own hover would be - once it is within
    // EDGE_NEAR of it, and every 150ms otherwise. A window left focused all
    // day with the tabs tucked away read the cursor forty times a second for
    // a pointer that was nowhere near.
    const tick = () => {
      this.edgeTimer = null;
      if (this.window.isDestroyed() || !this.detached() || this.sidebarOpen) { this.watchEdge(); return; }
      let near = false;
      if (this.window.isFocused()) {
        const at = screen.getCursorScreenPoint();
        const b = this.window.getContentBounds();
        const top = b.y + (this.band() ? SIDEBAR_TOP_BAND : 0);
        const rows = at.y >= top && at.y < b.y + b.height;
        const inside = rows && at.x >= b.x - 8 && at.x < b.x + SIDEBAR_EDGE;
        near = rows && at.x >= b.x - 8 && at.x < b.x + EDGE_NEAR;
        if (inside && !this.edgeHeld) {
          this.edgeHeld = true;
          this.setSidebarOpen(true);
        } else if (!inside && this.edgeHeld) {
          this.edgeHeld = false;
          // Left before the pause ran out: a brush past the edge, not a visit.
          if (!this.sidebarOpen) {
            clearTimeout(this.sidebarOpenTimer);
            this.sidebarPointerOver = false;
          }
        }
      }
      if (this.window.isDestroyed() || this.sidebarOpen || this.edgeTimer) return;
      // Battery mode reads it less often far from the edge (400ms): the
      // pointer still has the 25ms pace once it is near.
      this.edgeTimer = setTimeout(tick, near || this.edgeHeld ? 25 : this.saver ? 400 : 150);
      this.edgeTimer.unref?.();
    };
    this.edgeTimer = setTimeout(tick, 25);
    this.edgeTimer.unref?.();
  }

  /**
   * Opened by the pointer, the strip closes when the pointer leaves it - which
   * the strip learns from its own `mouseleave`. A pointer that reached the
   * edge and went straight off again (a flick, or leaving while the strip was
   * still sliding out) never entered the view the strip grew into, so nothing
   * left, and the strip stayed out until the pointer came back. Watched from here until the pointer is
   * clearly elsewhere or the strip has closed; never while it is tucked away.
   */
  watchAway() {
    clearTimeout(this.awayTimer);
    const tick = () => {
      this.awayTimer = null;
      if (this.window.isDestroyed() || !this.sidebarOpen || this.sidebarPinned() || !this.detached()) return;
      // Off for a test driving the strip with events of its own, where the
      // real cursor is parked outside the window on purpose.
      if (this.watchAwayOff) return;
      const at = screen.getCursorScreenPoint();
      const b = this.window.getContentBounds();
      const width = this.band() ? STRIP_VIEW_WIDTH : this.chromeView.getBounds().width;
      const top = b.y + (this.band() ? SIDEBAR_TOP_BAND : 0);
      const over = at.y >= top && at.y < b.y + b.height && at.x >= b.x - 8 && at.x < b.x + width + 8;
      if (!over) {
        this.edgeHeld = false;
        this.setSidebarOpen(false);
        return;
      }
      this.awayTimer = setTimeout(tick, this.saver ? 100 : 50);
      this.awayTimer.unref?.();
    };
    this.awayTimer = setTimeout(tick, 50);
    this.awayTimer.unref?.();
  }

  /** The strip has finished sliding away (chrome.js): its view can go now. */
  sidebarSlid() {
    if (!this.sidebarSliding || !this.sidebarShut) return;
    clearTimeout(this.sidebarSliding);
    this.sidebarShut();
  }

  /** How much width the chrome occupies in sidebar mode, right now. */
  sidebarWidth() {
    if (!this.vertical()) return 0;
    return this.sidebarPinned() || this.sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_EDGE;
  }

  /**
   * The pointer arrived at the edge, or left the sidebar.
   *
   * Opening waits a moment and closing a little longer, which is not symmetry
   * for its own sake: arriving is a decision and leaving is usually just the
   * pointer passing through on its way to the page. The short wait to open is
   * the same idea from the other side - a pointer brushing the window's edge
   * on its way somewhere else is not asking for the tabs.
   */
  setSidebarOpen(open, { now = false } = {}) {
    this.sidebarPointerOver = open;
    if (!this.vertical() || this.sidebarPinned()) return;
    // The find bar is drawn inside this column, so while it is up the pointer
    // does not get to close the thing the bar is in.
    if (this.findOpen) return;
    clearTimeout(this.sidebarCloseTimer);
    clearTimeout(this.sidebarOpenTimer);
    if (open && !now && !this.sidebarOpen && !this.sidebarSliding) {
      this.sidebarOpenTimer = setTimeout(() => {
        if (this.sidebarPointerOver && !this.window.isDestroyed()) this.setSidebarOpen(true, { now: true });
      }, SIDEBAR_OPEN_MS);
      return;
    }
    // The chrome is told its new shape at once rather than on the next state
    // broadcast: detached, opening turns it into a floating panel, and half a
    // second of a panel drawn as a column is visible.
    if (open) {
      // Back before a detached panel finished sliding away: it slides back in
      // from where it is, rather than vanishing and reappearing.
      if (this.sidebarSliding) {
        clearTimeout(this.sidebarSliding);
        this.sidebarSliding = null;
        this.toChrome('sidebar-slide', { out: false });
      }
      if (this.sidebarOpen) return;
      this.sidebarOpen = true;
      this.layout();
      this.publishSidebar();
      this.watchAway();
      return;
    }
    // Something the strip started is still going on: text half typed into its
    // address bar, the suggestions under it, or a menu opened from it. The
    // pointer leaves for all three - the menu and the list are other views -
    // and closing then took the address bar away mid-word and left the menu
    // or the list hanging with nothing to belong to. It closes when that ends
    // (`releaseSidebar`), if the pointer has not come back.
    if (this.sidebarHeld()) return;
    this.sidebarCloseTimer = setTimeout(() => {
      if (!this.sidebarOpen || this.sidebarPinned() || this.sidebarHeld()) return;
      const shut = () => {
        this.sidebarSliding = null;
        if (!this.sidebarOpen || this.sidebarPinned()) return;
        this.sidebarOpen = false;
        this.layout();
        this.publishSidebar();
      };
      // Detached, the panel slides away before its view shrinks back to the
      // edge - unless motion is reduced, where it simply goes.
      if (!this.reducedMotion()) {
        this.toChrome('sidebar-slide', { out: true });
        this.sidebarShut = shut;
        this.sidebarSliding = setTimeout(shut, DETACH_SLIDE_MS + DETACH_SLIDE_GRACE_MS);
      } else {
        shut();
      }
    }, SIDEBAR_CLOSE_MS);
  }

  /**
   * Whether there is a window material to see through to. Without one - Linux
   * has none - a see-through window background is blended with black, and a
   * tint meant to match the strip came out a shade darker than it.
   */
  seeThrough() {
    return process.platform !== 'linux' && typeof this.window.setBackgroundMaterial === 'function';
  }

  /**
   * Whether translucency is in force in the layout the window is in now.
   *
   * Pinned, or across the top, the strip sits on the window and can show it.
   * Tucked away in a window, so does the band across the top with the address
   * bar in it, and the margins round the page: only the panel of tabs slides
   * over the page, and that paints its own opaque card (chrome.css). Leaving
   * the whole layout opaque made the setting and the window material do
   * nothing at all there. Not full screen, where there is no band, only the
   * panel over the page.
   */
  translucentNow() {
    if (!(this.prefs.get('windowOpacity') < 1)) return false;
    return !this.vertical() || !this.detached() || this.band();
  }

  /**
   * Set the window material again. Windows ignores one set before the window
   * is on screen, and drops it across a maximise - the glass came back only
   * when the setting was changed, and was gone again on the next start.
   */
  reapplyMaterial() {
    if (this.window.isDestroyed() || typeof this.window.setBackgroundMaterial !== 'function') return;
    if (!this.material || this.material === 'none') return;
    try {
      this.window.setBackgroundMaterial('none');
      this.window.setBackgroundMaterial(this.material);
    } catch { /* the setting simply does not apply here */ }
  }

  /** Whether something the strip started should keep it out. */
  sidebarHeld() {
    return this.sidebarTyping === true || Boolean(this.sheetView) || this.suggestOpen === true;
  }

  /** What held the strip out has ended: let it go if the pointer is elsewhere. */
  releaseSidebar() {
    if (this.window.isDestroyed()) return;
    if (this.sidebarOpen && !this.sidebarPointerOver && !this.sidebarHeld()) this.setSidebarOpen(false);
  }

  /**
   * The page sits in a card rather than filling the window, in sidebar mode.
   *
   * Only there: across the top the toolbar is a band the page hangs directly
   * below, which is what every browser draws and what the eye expects. Down the
   * side there is nothing separating the two, and edge to edge they read as one
   * surface - most obviously on the browser's own pages, which carry the same
   * dark background as the strip.
   */
  cardInset() {
    return this.vertical() && !this.fullScreen() ? CONTENT_GAP : 0;
  }

  contentArea() {
    const { width, height } = this.window.getContentBounds();
    const panelWidth = this.panelOpen ? PANEL_WIDTH : 0;

    // Full screen gives the page the window, in both layouts. Across the top
    // there is no chrome to make room for; down the side the strip is a panel
    // drawn over the page rather than a column beside it, which is the whole
    // point of that shape - the page is the thing you went full screen for.
    //
    // Except while the chrome is back for the find or address bar, where it is
    // a band again and the page moves down for it exactly as it always does.
    if (this.fullScreen() && (this.vertical() || this.chromeHidden())) {
      return { x: 0, y: 0, width: Math.max(0, width - panelWidth), height };
    }
    // Tucked away, as Zen's compact mode: the page is a card with the same
    // small margin on every side, not a sheet run to the window's edges - and
    // the margin on the left is where the pointer finds the strip.
    if (this.detached()) {
      const gap = CONTENT_GAP;
      const top = this.band() ? SIDEBAR_TOP_BAND : gap;
      return {
        x: gap, y: top,
        width: Math.max(0, width - gap * 2 - panelWidth),
        height: Math.max(0, height - top - gap)
      };
    }

    if (this.vertical()) {
      // Pinned - unpinned is detached, handled above: the strip is a column
      // beside the page, and the band above the page is the title bar.
      const gap = this.cardInset();
      const left = SIDEBAR_WIDTH + gap;
      const top = SIDEBAR_TOP_BAND + gap;
      return {
        x: left,
        y: top,
        width: Math.max(0, width - left - gap - panelWidth),
        height: Math.max(0, height - top - gap)
      };
    }

    return {
      x: 0,
      y: this.chromeHeight(),
      width: Math.max(0, width - panelWidth),
      height: Math.max(0, height - this.chromeHeight())
    };
  }

  /**
   * What a tab actually gets: the content area less any docked inspector - in
   * a private window, letterboxed to whole steps, so the page's size (which
   * is also the screen it reports) says little about the window's.
   */
  contentBounds() {
    const area = this.contentArea();
    const dock = this.dockBounds(area);
    const bounds = !dock ? area : this.dockMode() === 'bottom'
      ? { ...area, height: Math.max(0, dock.y - area.y) }
      : { ...area, width: Math.max(0, dock.x - area.x) };
    return INCOGNITO ? letterbox(bounds) : bounds;
  }

  /**
   * Bring the window back after a minimise or a hide.
   *
   * Two things, because two different failures produce the same blank window.
   * The layout may have been flattened by a zero-sized resize while minimised,
   * and a view's compositor surface may not have been re-attached on the way
   * back. Re-asserting visibility costs nothing and fixes the second; `layout`
   * fixes the first.
   */
  revive() {
    this.layout();
    for (const tab of this.tabs.all()) {
      if (tab.view) tab.setVisible(tab.visible);
    }
  }

  layout() {
    // A minimised window has no client area to lay out against. Computing from
    // it would write zero-sized bounds over the good ones, and nothing restores
    // them afterwards - which is exactly how the window comes back empty.
    if (this.window.isDestroyed() || this.window.isMinimized()) return;

    const { width, height } = this.window.getContentBounds();
    // Belt and braces: a zero or negative client area is not a layout, it is a
    // transient state to sit out.
    if (width <= 0 || height <= 0) return;
    this.watchEdge();

    // An inspector whose page has gone - crashed, or discarded out from under
    // it - is a dead view holding a share of the window. Dropped here rather
    // than hooked to every path that could end a renderer, because this runs on
    // every resize and tab change anyway. `closeDevTools` calls back into
    // `layout`, but only once: the second pass finds nothing to clean up.
    if (this.devToolsTab && !this.devToolsTab.isLive) this.closeDevTools();

    // One rectangle either way, so sidebar mode costs no extra view and no
    // extra renderer. Full height on the left, which puts the chrome's own top
    // corner beside the window buttons rather than under them.
    // Three shapes, and full screen is what chooses between the last two.
    //
    //   hidden    across the top, full screen: the page has the whole window
    //   floating  down the side, full screen: a panel over the page, inset from
    //             the corner and as tall as the chrome says it needs
    //   docked    everything else: a full-height column, or a band on top
    const hidden = this.chromeHidden();
    this.chromeView.setVisible(!hidden);
    if (!hidden) {
      if (this.chromeFloats()) {
        const room = Math.max(FLOAT_MIN_HEIGHT, height - FLOAT_GAP * 2);
        this.chromeView.setBounds({
          x: FLOAT_GAP,
          y: FLOAT_GAP,
          width: this.sidebarWidth(),
          // Detached, it is the tab strip brought back, so it takes the height
          // there is; full screen, it is as tall as its rows.
          height: this.detached() ? room
            : Math.min(room, Math.max(FLOAT_MIN_HEIGHT, this.chromeWantsHeight || room))
        });
      } else {
        // Tucked away in a window, the band keeps its 40px when the tabs come
        // out, and the tabs are a view of their own under it (`layStrip`).
        // Growing this view over the whole window to draw them instead left
        // it lying over the page, clear but in the way of every click, wheel
        // and drop - input could only be handed on piecemeal.
        this.chromeView.setBounds(this.band()
          ? { x: 0, y: 0, width, height: SIDEBAR_TOP_BAND }
          : this.vertical()
          ? { x: 0, y: 0, width: this.sidebarWidth(), height }
          : { x: 0, y: 0, width, height: this.chromeHeight() });
      }
    }
    // Rounded only while it floats. A panel over a page needs corners; a column
    // against the window's own edge does not, and rounding one would leave four
    // notches of window background at the screen's corners.
    this.layStrip(width, height);
    this.placeTitleBand();
    const chromeRadius = this.chromeFloats() ? FLOAT_RADIUS : 0;
    if (this.laidOutChromeRadius !== chromeRadius) {
      this.laidOutChromeRadius = chromeRadius;
      setRadius(this.chromeView, chromeRadius);
    }

    const bounds = this.contentBounds();
    // No card, and no corners, while full screen: the page is the window.
    const radius = this.vertical() && !this.fullScreen() ? CONTENT_RADIUS : 0;
    // Applied on a change rather than every layout, which runs on every resize
    // and every tab switch.
    const reshape = this.laidOutCard !== radius;
    this.laidOutCard = radius;
    const halves = this.splitBounds(bounds);
    for (const tab of this.tabs.all()) {
      if (!tab.view) continue;
      tab.setBounds(halves && tab.id === this.split.left ? halves.left
        : halves && tab.id === this.split.right ? halves.right : bounds);
      if (reshape) setRadius(tab.view, radius);
    }
    this.placeDivider(halves);
    this.placePeek();

    if (this.placeholderView) {
      this.placeholderView.setBounds(bounds);
      setRadius(this.placeholderView, radius);
    }

    if (this.devToolsView) {
      const dock = this.dockBounds(this.contentArea());
      // Hidden rather than destroyed while its tab is in the background: the
      // inspector holds the state the user has built up in it - breakpoints, a
      // console history, a filtered network log - and throwing that away on a
      // tab switch would make it useless for the thing people actually do with
      // it, which is switch to another tab and come back.
      this.devToolsView.setVisible(Boolean(dock));
      if (dock) this.devToolsView.setBounds(dock);
      this.placeDevToolsDivider(dock);
      // Tucked away, the strip floats over the page, and a dock across the
      // bottom covered its lower part - and the edge that opens it. The strip
      // goes just above the inspector; anything above that stays above.
      const root = this.window.contentView;
      const at = root.children.indexOf(this.devToolsView);
      if (dock && this.detached() && at > root.children.indexOf(this.chromeView)) {
        root.removeChildView(this.chromeView);
        root.addChildView(this.chromeView, root.children.indexOf(this.devToolsView) + 1);
      }
    }

    if (this.panelView) {
      // Sits beside the content, so it starts below whatever the content
      // starts below - the top band in sidebar mode, the chrome otherwise.
      // In full screen there is no chrome, and no window buttons, above it:
      // it starts at the top, level with the page, not 84px down.
      const top = this.fullScreen() && (this.vertical() || this.chromeHidden()) ? 0
        : (this.vertical() ? SIDEBAR_TOP_BAND : this.chromeHeight());
      this.panelView.setBounds({
        x: width - PANEL_WIDTH,
        y: top,
        width: PANEL_WIDTH,
        height: Math.max(0, height - top)
      });
    }

    if (this.crashView) this.crashView.setBounds(this.contentBounds());
    if (this.toastView) this.placeToast();
  }

  /* ---------------------------------------------------------------- */

  /**
   * Is this webContents one of the browser's own chrome views?
   *
   * Asked by name rather than inferred from "no tab matches it". TabManager
   * removes a tab from its list before the renderer is torn down, and in that
   * window a website would pass a negative test and be treated as the chrome.
   */
  isChromeSender(sender) {
    if (!sender) return false;
    for (const view of [this.chromeView, this.stripView, this.panelView, this.sheetView, this.suggestView, this.crashView,
      this.toastView, this.dividerView, this.devToolsDivider, this.passkeyView, this.peek && this.peek.backdrop, this.quick && this.quick.bar]) {
      const wc = view && view.webContents;
      if (wc && !wc.isDestroyed() && wc.id === sender.id) return true;
    }
    return false;
  }

  /**
   * Push governor + tab state to every view that renders it.
   *
   * Preferences ride along on the same message rather than on a channel of
   * their own: every consumer that wants one wants the other in the same paint,
   * and two channels would mean the tab strip could briefly render new state
   * under the old theme.
   */
  publish(state) {
    // Queued updates can land after the window has closed (quitting, or an
    // update installing): there is nothing left to paint.
    if (this.window.isDestroyed()) return;
    const full = this.prefs
      ? { ...state, prefs: this.prefs.all(), searchEngines: this.prefs.engines() }
      : { ...state };
    if (this.updater) full.updates = this.updater.snapshot();
    // A number, not the list. See Bookmarks#revision: the bar re-asks for the
    // list only when this changes, rather than having it pushed into three
    // views on every governor tick.
    if (this.bookmarks) full.bookmarksRevision = this.bookmarks.revision;
    // A count and a fraction, not the list. See DownloadManager#summary.
    if (this.downloads) full.downloads = this.downloads.summary();
    full.bookmarksBar = this.bookmarksBarVisible();
    // Saving the first bookmark, or removing the last, changes how much room
    // the page gets - and neither goes through `applyWindowPrefs`. Checked here
    // because this runs on every state change and on the governor's tick, so
    // the bar appears with the bookmark rather than at the next resize.
    if (this.laidOutBookmarksBar !== full.bookmarksBar) {
      this.laidOutBookmarksBar = full.bookmarksBar;
      this.layout();
    }
    full.sidebar = this.sidebarState();
    this.showCrashed(Boolean(this.tabs.activeTab()?.crashed));
    // Null in the ordinary browser, which is how every view tells the two apart.
    full.incognito = this.incognito ? this.incognito() : null;
    send(this.chromeView, 'debrowser:state', full);
    if (this.stripView) send(this.stripView, 'debrowser:state', full);
    send(this.panelView, 'debrowser:state', full);
    // And the sheet, while one is up. The menu takes its preferences off the
    // `menu-model` reply and would not need this; the downloads flyout has no
    // equivalent reply, so without it the panel ignored the chosen theme.
    send(this.sheetView, 'debrowser:state', full);

    // And the browser's own pages, which are tabs now rather than views. Both
    // build their UI from this message, so without it Settings renders as a
    // column of empty headings and the new tab page shows no figures - which is
    // exactly what shipped when the overlay was replaced and this was not
    // updated to follow.
    //
    // Through `sendToPage`, which declines a stopped renderer: an internal page
    // left in the background is frozen like any other, and IPC to a frozen
    // renderer crashes it. It catches up on the next tick after it is shown.
    for (const tab of this.tabs.all()) {
      if (tab.internal) tab.sendToPage('debrowser:state', full);
    }
  }

  /**
   * Ask the window to close, the way the title bar's close button does.
   *
   * Deliberately `close()` and not `destroy()`: closing emits `close` and then
   * `window-all-closed`, which is where quitting and the session write are
   * hung. `destroy()` skips both, so a browser that quit itself would lose the
   * session a browser the user quit would have kept.
   */
  close() {
    if (!this.window.isDestroyed()) this.window.close();
  }

  destroy() {
    clearTimeout(this.edgeTimer);
    this.edgeTimer = null;
    this.closeSheet();
    this.togglePanel(false);
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}

function send(view, channel, payload) {
  if (!view) return;
  const wc = view.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send(channel, payload);
  } catch { /* view torn down mid-publish */ }
}

module.exports = {
  BrowserShell, CHROME_HEIGHT, BOOKMARKS_BAR_HEIGHT, PANEL_WIDTH,
  SIDEBAR_WIDTH, SIDEBAR_EDGE, SIDEBAR_TOP_BAND, CONTENT_GAP, STRIP_VIEW_WIDTH
};
