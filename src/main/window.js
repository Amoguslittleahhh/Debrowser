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
const { BaseWindow, WebContentsView, ImageView, nativeImage, nativeTheme,
        shell } = require('electron');

const CHROME_HEIGHT = 84;
const PANEL_WIDTH = 360;

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
const SIDEBAR_CLOSE_MS = 220;

/**
 * How much of the content area a docked inspector takes, and the least it may
 * have. Chromium's own default split is close to this; the minimum exists so
 * that docking into a narrow window leaves the inspector usable rather than a
 * sliver, and `dockBounds` gives up on the dock entirely rather than squeeze
 * the page out of existence.
 */
const DEVTOOLS_SHARE = 0.42;
const DEVTOOLS_MIN = 320;

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
const SHEET_PAGES = {
  menu: 'menu.html',
  downloads: 'flyout.html',
  // Not anchored to anything - it centres itself. It is in the sheet because
  // everything the sheet gives it is what a prompt needs: a view over the whole
  // window, a backdrop that catches a click, the keyboard, and nothing held
  // while it is closed.
  update: 'update.html',
  // Right-click on a page. Same view, same dismissal, same styling as the app
  // menu - a context menu that looked like a different program's would be the
  // most obvious seam in the browser, and it is the menu people open most.
  context: 'context.html'
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
function preloadArgs(prefs) {
  return prefs ? [`--prefs=${JSON.stringify(prefs.all())}`] : [];
}

function setRadius(view, radius) {
  if (!view || typeof view.setBorderRadius !== 'function') return;
  try {
    view.setBorderRadius(radius);
  } catch { /* not supported here; square corners */ }
}

class BrowserShell {
  /**
   * @param {object} deps - { tabManager, log, onCommand }
   */
  constructor({ tabManager, prefs = null, updater = null, log = () => {}, onCommand = () => {},
                bindShortcuts = () => {} }) {
    this.tabs = tabManager;
    this.prefs = prefs;
    this.updater = updater;
    /** @type {import('./bookmarks').Bookmarks|null} */
    this.bookmarks = null;
    /** @type {import('./downloads').DownloadManager|null} */
    this.downloads = null;
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

    this.window = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 620,
      minHeight: 420,
      title: 'Debrowser',
      backgroundColor: '#161614',
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
            titleBarOverlay: { color: '#161614', symbolColor: '#9b978e', height: 40 }
          })
    });

    this.panelView = null;
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
    this.window.on('resize', () => { this.closeSheet(); this.layout(); });
    this.window.on('restore', () => this.revive());
    this.window.on('show', () => this.revive());
    // Full screen changes which rectangle everything gets, in both layouts, so
    // it is a relayout like a resize - and a publish, because the chrome draws
    // itself differently as a floating panel and only the window knows.
    this.window.on('enter-full-screen', () => { this.layout(); this.publishSidebar(); });
    this.window.on('leave-full-screen', () => { this.layout(); this.publishSidebar(); });
    this.window.on('maximize', () => this.layout());
    this.window.on('unmaximize', () => this.layout());
    this.window.once('ready-to-show', () => this.window.show());
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
    // replacing the browser chrome.
    this.chromeView.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    this.chromeView.webContents.once('did-finish-load', () => {
      this.window.show();
      this.onCommand('chrome-ready');
    });
  }

  /* ---------------------------------------------------------------- */

  /** Attach a tab's view to the window. Called when a tab is realised. */
  attachTab(tab) {
    if (!tab.view) return;
    const children = this.window.contentView.children;
    // Insert below the chrome so the chrome always wins the z-order.
    if (!children.includes(tab.view)) this.window.contentView.addChildView(tab.view, 0);

    // Bounds are re-asserted on every present, not only on the first.
    //
    // This used to return early for a view that was already attached, which was
    // true of every tab switch - and became wrong the moment a docked inspector
    // existed. The dock belongs to one tab and is drawn above all of them, so
    // switching tabs changes both who gets the content rectangle and whether
    // the dock should be on screen at all. Returning early left tab A's
    // inspector painted over tab B, with B sized as though it had the window.
    if (this.devToolsView) this.layout();
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
        this.window.contentView.addChildView(
          this.placeholderView, chromeIndex === -1 ? undefined : chromeIndex);
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
  openSheet(page, anchor = {}) {
    if (this.window.isDestroyed()) return;
    const file = SHEET_PAGES[page];
    if (!file) return;

    // Toggle: pressing the same button again closes it, as a system menu does
    // when the click lands on its dismissing grab. Pressing the *other* one
    // swaps, which is what a toolbar full of panels should do.
    if (this.sheetView) {
      const same = this.sheetPage === page;
      this.closeSheet();
      if (same) return;
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
    if (page !== 'context' &&
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

    // The view is window-sized; only the menu itself is painted. Anything the
    // page leaves untouched has to show what is behind it, or this covers the
    // browser with a grey sheet.
    try {
      sheetView.setBackgroundColor('#00000000');
    } catch (err) {
      this.log(`transparent menu unavailable: ${err.message}`);
    }

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
    wc.once('did-finish-load', () => {
      // Dismissed before it finished loading - Escape, or a second press. The
      // view is already being torn down; putting it on screen now would show a
      // menu the user has closed.
      if (this.sheetView !== sheetView || wc.isDestroyed()) return;

      this.window.contentView.addChildView(sheetView);   // topmost, over the chrome
      this.layoutSheet();

      // Focused so it can take the keyboard, which is how the arrow keys and
      // Escape reach it at all.
      wc.focus();

      // Clicking a page or the tab strip moves focus out of this view, and a
      // menu that stays up after the user has gone somewhere else is a menu
      // they have to dismiss twice. This is the backstop for the click-away the
      // transparent backdrop already handles; both funnel into `closeSheet`.
      wc.on('blur', () => this.closeSheet({ blurred: true }));
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
  closeSheet({ blurred = false } = {}) {
    if (!this.sheetView) return;
    const view = this.sheetView;
    const page = this.sheetPage;
    this.sheetView = null;
    this.sheetPage = null;
    if (blurred) {
      this.sheetClosedPage = page;
      this.sheetClosedAt = Date.now();
    }
    // Dismissing the update prompt is "Later", and the updater has to know it
    // is no longer on screen or it would refuse to offer again for the life of
    // the session. Nothing is cancelled: the downloaded update is still there
    // and the prompt comes back on the next launch.
    if (page === 'update' && this.updater) this.updater.dismissPrompt();
    try {
      this.window.contentView.removeChildView(view);
      view.webContents.close();
    } catch { /* already gone */ }
  }

  layoutSheet() {
    if (!this.sheetView || this.window.isDestroyed()) return;
    const { width, height } = this.window.getContentBounds();
    if (width <= 0 || height <= 0) return;
    this.sheetView.setBounds({ x: 0, y: 0, width, height });
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

    if (this.dockMode() === 'bottom') {
      const height = Math.max(DEVTOOLS_MIN, Math.round(content.height * DEVTOOLS_SHARE));
      if (height >= content.height) return null;  // no room worth splitting
      return { x: content.x, y: content.y + content.height - height, width: content.width, height };
    }

    const width = Math.max(DEVTOOLS_MIN, Math.round(content.width * DEVTOOLS_SHARE));
    if (width >= content.width) return null;
    return { x: content.x + content.width - width, y: content.y, width, height: content.height };
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
      this.window.contentView.addChildView(this.panelView);
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
    const translucent = this.prefs.get('windowOpacity') < 1;
    if (material === 'none' && translucent) material = 'acrylic';

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
    const sheer = translucent ? '#00000000' : (this.lightTheme() ? '#f3f1ec' : '#161614');
    try {
      this.window.setBackgroundColor(sheer);
      this.chromeView.setBackgroundColor(sheer);
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
        this.laidOutPinned !== this.sidebarPinned()) {
      const wasPinned = this.laidOutPinned;
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
        this.window.setTitleBarOverlay({ color: strip, symbolColor: this.symbolColour(), height: 40 });
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
    if (choice === 'default') return this.lightTheme() ? '#f3f1ec' : '#161614';
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

  /** The window buttons' own colour, which has to read against the strip. */
  symbolColour() {
    return this.lightTheme() ? '#6b6559' : '#9b978e';
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
    this.sidebarOpen = want;
    this.layout();
    this.toChrome(want ? 'find-focus' : 'find-closed');
  }

  /** A one-off message to the chrome, for the things that are not state. */
  toChrome(kind, payload = null) {
    send(this.chromeView, 'debrowser:ui', { kind, ...(payload || {}) });
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
    return this.vertical() && this.fullScreen();
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
    if (!this.vertical()) return null;
    return {
      pinned: this.sidebarPinned(),
      open: this.sidebarPinned() || this.sidebarOpen,
      floating: this.chromeFloats()
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

  /** Is the sidebar held open, rather than sliding away when the pointer goes? */
  sidebarPinned() {
    return this.prefs ? this.prefs.get('sidebarPinned') === true : false;
  }

  /** How much width the chrome occupies in sidebar mode, right now. */
  sidebarWidth() {
    if (!this.vertical()) return 0;
    return this.sidebarPinned() || this.sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_EDGE;
  }

  /**
   * The pointer arrived at the edge, or left the sidebar.
   *
   * Opening is immediate and closing waits, which is not symmetry for its own
   * sake: arriving is a decision and leaving is usually just the pointer
   * passing through on its way to the page.
   */
  setSidebarOpen(open) {
    if (!this.vertical() || this.sidebarPinned()) return;
    // The find bar is drawn inside this column, so while it is up the pointer
    // does not get to close the thing the bar is in.
    if (this.findOpen) return;
    clearTimeout(this.sidebarCloseTimer);
    if (open) {
      if (this.sidebarOpen) return;
      this.sidebarOpen = true;
      this.layout();
      return;
    }
    this.sidebarCloseTimer = setTimeout(() => {
      if (!this.sidebarOpen || this.sidebarPinned()) return;
      this.sidebarOpen = false;
      this.layout();
    }, SIDEBAR_CLOSE_MS);
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

    if (this.vertical()) {
      // Measured from the *pinned* width, not the current one. An unpinned
      // sidebar slides out over the page rather than pushing it: a page that
      // reflowed every time the pointer touched the window edge would be the
      // most distracting thing in the browser.
      const gap = this.cardInset();
      const left = (this.sidebarPinned() ? SIDEBAR_WIDTH : SIDEBAR_EDGE) + gap;
      return {
        x: left,
        y: SIDEBAR_TOP_BAND + gap,
        width: Math.max(0, width - left - gap - panelWidth),
        height: Math.max(0, height - SIDEBAR_TOP_BAND - gap * 2)
      };
    }

    return {
      x: 0,
      y: this.chromeHeight(),
      width: Math.max(0, width - panelWidth),
      height: Math.max(0, height - this.chromeHeight())
    };
  }

  /** What a tab actually gets: the content area less any docked inspector. */
  contentBounds() {
    const area = this.contentArea();
    const dock = this.dockBounds(area);
    if (!dock) return area;
    return this.dockMode() === 'bottom'
      ? { ...area, height: Math.max(0, dock.y - area.y) }
      : { ...area, width: Math.max(0, dock.x - area.x) };
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
          height: Math.min(room, Math.max(FLOAT_MIN_HEIGHT, this.chromeWantsHeight || room))
        });
      } else {
        this.chromeView.setBounds(this.vertical()
          ? { x: 0, y: 0, width: this.sidebarWidth(), height }
          : { x: 0, y: 0, width, height: this.chromeHeight() });
      }
    }
    // Rounded only while it floats. A panel over a page needs corners; a column
    // against the window's own edge does not, and rounding one would leave four
    // notches of window background at the screen's corners.
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
    for (const tab of this.tabs.all()) {
      if (!tab.view) continue;
      tab.setBounds(bounds);
      if (reshape) setRadius(tab.view, radius);
    }

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
    }

    if (this.panelView) {
      // Sits beside the content, so it starts below whatever the content
      // starts below - the top band in sidebar mode, the chrome otherwise.
      const top = this.vertical() ? SIDEBAR_TOP_BAND : this.chromeHeight();
      this.panelView.setBounds({
        x: width - PANEL_WIDTH,
        y: top,
        width: PANEL_WIDTH,
        height: Math.max(0, height - top)
      });
    }
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
    for (const view of [this.chromeView, this.panelView, this.sheetView]) {
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
    send(this.chromeView, 'debrowser:state', full);
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
    for (const tab of this.tabs.all()) {
      if (tab.internal && tab.isLive) send(tab.view, 'debrowser:state', full);
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
  SIDEBAR_WIDTH, SIDEBAR_EDGE, CONTENT_GAP
};
