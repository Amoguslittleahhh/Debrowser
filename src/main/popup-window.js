/**
 * A sign-in or console pop-up as Chrome draws one: a window of its own with no
 * tabs or toolbar, just a read-only strip naming the site, so it is clear who
 * is asking for the password. The page stays the opener's pop-up, so
 * window.opener and postMessage reach the page that is waiting on it.
 */
const { BaseWindow, WebContentsView } = require('electron');

const STRIP = 34;

const STRIP_HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;font:13px system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none}
body{display:flex;align-items:center;padding:0 10px;background:#f1f3f4;color:#202124;border-bottom:1px solid #dadce0;box-sizing:border-box}
@media (prefers-color-scheme:dark){body{background:#35363a;color:#e8eaed;border-color:#202124}#bar{background:#202124}}
#bar{flex:1;display:flex;align-items:center;gap:8px;height:24px;padding:0 10px;border-radius:12px;background:#fff;min-width:0}
#lock{flex:none;width:12px;height:12px}
#url{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#host{font-weight:500}#rest{opacity:.6}
</style><div id="bar"><svg id="lock" viewBox="0 0 16 16" fill="currentColor"><path d="M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 1 0-4 0v2z"/></svg><span id="url"><span id="host"></span><span id="rest"></span></span></div>`;

/** Strip's text for `url`: the host bold, the rest faint, as Chrome shows it. */
function show(strip, url) {
  let host = url, rest = '', secure = false;
  try { const u = new URL(url); host = u.host; rest = u.pathname + u.search; secure = u.protocol === 'https:'; } catch { /* as given */ }
  const js = `host.textContent=${JSON.stringify(host)};rest.textContent=${JSON.stringify(rest)};lock.style.visibility=${JSON.stringify(secure ? 'visible' : 'hidden')};`;
  strip.webContents.executeJavaScript(js).catch(() => {});
}

/**
 * Build the window around the page Electron made for the pop-up; returns its
 * webContents, as setWindowOpenHandler's createWindow wants.
 */
function createPopupWindow(options, { onOpen } = {}) {
  const parent = BaseWindow.getFocusedWindow();
  const width = Math.min(Math.max(Number(options.width) || 500, 360), 1000);
  const height = Math.min(Math.max(Number(options.height) || 640, 300), 900);
  const win = new BaseWindow({
    width, height: height + STRIP, minWidth: 320, minHeight: 240,
    autoHideMenuBar: true, show: false, title: 'Sign in',
    ...(parent && !parent.isDestroyed() ? { x: centre(parent, width, 'x'), y: centre(parent, height + STRIP, 'y') } : {})
  });
  win.setMenuBarVisibility(false);
  const strip = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, javascript: true } });
  const page = new WebContentsView({ webContents: options.webContents, webPreferences: options.webPreferences });
  win.contentView.addChildView(page);
  win.contentView.addChildView(strip);
  const place = () => {
    if (win.isDestroyed()) return;
    const { width: w, height: h } = win.getContentBounds();
    strip.setBounds({ x: 0, y: 0, width: w, height: STRIP });
    page.setBounds({ x: 0, y: STRIP, width: w, height: Math.max(0, h - STRIP) });
  };
  win.on('resize', place);
  place();
  strip.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(STRIP_HTML)}`).catch(() => {});
  strip.webContents.on('did-finish-load', () => show(strip, options.webContents.getURL() || ''));

  const wc = options.webContents;
  const update = () => { if (!win.isDestroyed() && !wc.isDestroyed()) show(strip, wc.getURL()); };
  wc.on('did-navigate', update);
  wc.on('did-navigate-in-page', update);
  wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !win.isDestroyed()) show(strip, d.url); });
  wc.on('page-title-updated', (_e, t) => { if (!win.isDestroyed()) win.setTitle(t || 'Sign in'); });
  // window.close() from the page - the end of every sign-in - closes the window.
  wc.on('destroyed', () => { if (!win.isDestroyed()) win.destroy(); });
  win.on('closed', () => {
    if (!wc.isDestroyed()) wc.close();
    if (!strip.webContents.isDestroyed()) strip.webContents.close();
  });
  wc.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); page.webContents.focus(); } });
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 1500);
  if (onOpen) onOpen(win, wc);
  return wc;
}

function centre(parent, size, axis) {
  const b = parent.getBounds();
  return Math.round(axis === 'x' ? b.x + (b.width - size) / 2 : b.y + Math.max(0, (b.height - size) / 3));
}

module.exports = { createPopupWindow };
