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
const { BaseWindow, WebContentsView, ImageView, nativeImage, shell } = require('electron');

const CHROME_HEIGHT = 84;
const PANEL_WIDTH = 360;

/**
 * Hard ceiling on how long a restore placeholder may stay up. Generous enough
 * to cover a slow page, short enough that a page which never paints does not
 * leave the user looking at a frozen screenshot.
 */
const PLACEHOLDER_MAX_MS = 1500;

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const CHROME_PRELOAD = path.join(__dirname, '..', 'preload', 'chrome-preload.js');

class BrowserShell {
  /**
   * @param {object} deps - { tabManager, log, onCommand }
   */
  constructor({ tabManager, prefs = null, updater = null, log = () => {}, onCommand = () => {} }) {
    this.tabs = tabManager;
    this.prefs = prefs;
    this.updater = updater;
    this.log = log;
    this.onCommand = onCommand;

    this.window = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 620,
      minHeight: 420,
      title: 'Debrowser',
      backgroundColor: '#16181d',
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
            titleBarOverlay: { color: '#16181d', symbolColor: '#9aa1b1', height: 40 }
          })
    });

    this.panelView = null;
    this.panelOpen = false;

    /**
     * One reused ImageView showing the outgoing tab's thumbnail while a
     * restored tab loads. See showPlaceholder.
     * @type {Electron.ImageView|null}
     */
    this.placeholderView = null;
    this.placeholderTimer = null;

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
    this.window.on('resize', () => this.layout());
    this.window.on('restore', () => this.revive());
    this.window.on('show', () => this.revive());
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
        backgroundThrottling: false
      }
    });

    this.window.contentView.addChildView(this.chromeView);
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
    if (children.includes(tab.view)) return;

    // Insert below the chrome so the chrome always wins the z-order.
    this.window.contentView.addChildView(tab.view, 0);
    tab.setBounds(this.contentBounds());
    tab.setVisible(tab.visible);
  }

  detachTab(tab) {
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
          backgroundThrottling: false
        }
      });
      this.window.contentView.addChildView(this.panelView);
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
    const sheer = translucent ? '#00000000' : '#16181d';
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

    // Keep the system's window buttons legible against whatever the strip is.
    const strip = this.stripColour();
    if (process.platform !== 'darwin' && typeof this.window.setTitleBarOverlay === 'function') {
      try {
        this.window.setTitleBarOverlay({ color: strip, symbolColor: '#9aa1b1', height: 40 });
      } catch { /* no overlay on this platform */ }
    }
  }

  /** What colour the tab strip is, resolving 'mirror' and 'default'. */
  stripColour() {
    const choice = this.prefs ? this.prefs.get('tabBarColor') : 'default';
    if (choice === 'mirror') return this.prefs.get('accent');
    if (choice === 'default') return '#16181d';
    return choice;
  }

  /* ---------------------------------------------------------------- */

  contentBounds() {
    const { width, height } = this.window.getContentBounds();
    const panelWidth = this.panelOpen ? PANEL_WIDTH : 0;
    return {
      x: 0,
      y: CHROME_HEIGHT,
      width: Math.max(0, width - panelWidth),
      height: Math.max(0, height - CHROME_HEIGHT)
    };
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

    this.chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT });

    const bounds = this.contentBounds();
    for (const tab of this.tabs.all()) {
      if (tab.view) tab.setBounds(bounds);
    }

    if (this.placeholderView) this.placeholderView.setBounds(bounds);

    if (this.panelView) {
      this.panelView.setBounds({
        x: width - PANEL_WIDTH,
        y: CHROME_HEIGHT,
        width: PANEL_WIDTH,
        height: Math.max(0, height - CHROME_HEIGHT)
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
    for (const view of [this.chromeView, this.panelView]) {
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
    send(this.chromeView, 'debrowser:state', full);
    send(this.panelView, 'debrowser:state', full);

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

module.exports = { BrowserShell, CHROME_HEIGHT, PANEL_WIDTH };
