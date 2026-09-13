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
const { BaseWindow, WebContentsView, shell } = require('electron');

const CHROME_HEIGHT = 84;
const PANEL_WIDTH = 360;

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const CHROME_PRELOAD = path.join(__dirname, '..', 'preload', 'chrome-preload.js');

class BrowserShell {
  /**
   * @param {object} deps - { tabManager, log, onCommand }
   */
  constructor({ tabManager, log = () => {}, onCommand = () => {} }) {
    this.tabs = tabManager;
    this.log = log;
    this.onCommand = onCommand;

    this.window = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 620,
      minHeight: 420,
      title: 'Debrowser',
      backgroundColor: '#16181d',
      show: false
    });

    this.panelView = null;
    this.panelOpen = false;

    this.createChrome();
    this.window.on('resize', () => this.layout());
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

  layout() {
    const { width, height } = this.window.getContentBounds();

    this.chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT });

    const bounds = this.contentBounds();
    for (const tab of this.tabs.all()) {
      if (tab.view) tab.setBounds(bounds);
    }

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

  /** Push governor + tab state to the chrome and the panel. */
  publish(state) {
    send(this.chromeView, 'debrowser:state', state);
    send(this.panelView, 'debrowser:state', state);
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
