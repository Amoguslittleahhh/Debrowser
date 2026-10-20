/**
 * A sign-in or console pop-up as Chrome draws one: a window of its own with no
 * tabs or toolbar, just a read-only strip naming the site, so it is clear who
 * is asking for the password. The page stays the opener's pop-up, so
 * window.opener and postMessage reach the page that is waiting on it.
 */
const { BaseWindow, WebContentsView, nativeTheme } = require('electron');
const { getDomain } = require('tldts-experimental');
const palette = require('./palette');

const STRIP = 34;

/**
 * Pop-ups that must be real windows: sign-in providers, and browser consoles
 * such as Google Cloud's SSH, whose pages talk back to their opener.
 */
const PRIORITY_HOSTS = /(^|\.)(accounts\.google\.com|ssh\.cloud\.google\.com|shell\.cloud\.google\.com|login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|appleid\.apple\.com|accounts\.firefox\.com|id\.atlassian\.com|auth0\.com|okta\.com|oktapreview\.com|onelogin\.com|duosecurity\.com|accounts\.spotify\.com|id\.twitch\.tv|firebaseapp\.com)$/i;
// Facebook, GitHub, X, Discord, Steam and the rest sign in under a path on
// their main host; Firebase's handler is /__/auth/handler, Supabase's /auth/v1.
const PRIORITY_PATH = /\/(oauth2?|auth|authorize|openid|sso|saml|signin|sign-in|login|ap\/signin|ap\/oa)(\/|$|\?)/i;
/**
 * Whether `url`, opened as a pop-up by a page at `opener`, is a sign-in.
 * A known provider always is. A sign-in path counts only on another site
 * than the page's own, as every third-party sign-in is: a site's own /login
 * pop-up is a Peek (which keeps its opener too), so no page gets a bare
 * window just by naming a path.
 */
function isPriorityPopup(url, opener) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https:$/i.test(u.protocol)) return false;
  if (PRIORITY_HOSTS.test(u.hostname)) return true;
  if (!PRIORITY_PATH.test(u.pathname)) return false;
  let from = null;
  try { from = getDomain(new URL(opener).hostname) || new URL(opener).hostname; } catch { /* none */ }
  return !from || from !== (getDomain(u.hostname) || u.hostname);
}

/** Live strips, redrawn when the design or light and dark change. */
const live = new Set();
function restyleAll() { for (const redraw of live) redraw(); }
nativeTheme.on('updated', () => setTimeout(restyleAll, 50));

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The strip for `url`, in the design and light or dark the browser is in now.
 * It is drawn whole by the browser each time and runs no script, so nothing -
 * the page, an extension, a click or a key - can write in it: it says only
 * the address the window has committed to.
 */
function stripHtml(url) {
  const { light, design, p } = palette.current();
  const field = p.raised && p.raised !== p.bg ? p.raised : (light ? '#ffffff' : '#000000');
  const radius = design === 'grid' ? '0' : design === 'ledger' ? '6px' : '12px';
  let host = url || '', rest = '', secure = false;
  try {
    const u = new URL(url);
    if (/^https?:$/.test(u.protocol)) { host = u.host; rest = u.pathname + u.search; secure = u.protocol === 'https:'; }
  } catch { /* shown as given */ }
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
:root{color-scheme:${light ? 'light' : 'dark'}}
html,body{margin:0;height:100%;overflow:hidden;font:13px Aptos,Calibri,Carlito,"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,Ubuntu,sans-serif;user-select:none;pointer-events:none;cursor:default}
body{display:flex;align-items:center;padding:0 8px;background:${p.bg};color:${p.text};border-bottom:1px solid ${p.border};box-sizing:border-box}
#bar{flex:1;display:flex;align-items:center;gap:8px;height:24px;padding:0 10px;border-radius:${radius};background:${field};border:1px solid ${p.border};min-width:0}
#lock{flex:none;width:12px;height:12px;color:${p.dim}}
#warn{flex:none;color:${p.dim}}
#url{display:flex;min-width:0;white-space:nowrap}
#host{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
#rest{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:${p.dim}}
</style><div id="bar">${secure
    ? '<svg id="lock" viewBox="0 0 16 16" fill="currentColor"><path d="M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 1 0-4 0v2z"/></svg>'
    : '<span id="warn">Not secure</span>'}<span id="url"><span id="host"><bdi>${esc(host)}</bdi></span><span id="rest">${esc(rest)}</span></span></div>`;
}

/** Draw the strip again for `url`. */
function show(strip, url) {
  if (strip.webContents.isDestroyed()) return;
  strip.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(stripHtml(url))}`).catch(() => {});
}

/**
 * Build the window around the page Electron made for the pop-up; returns its
 * webContents, as setWindowOpenHandler's createWindow wants.
 */
function createPopupWindow(options, { onOpen, pending = false, onReject, opener = null } = {}) {
  const parent = BaseWindow.getFocusedWindow();
  const width = Math.min(Math.max(Number(options.width) || 500, 360), 1000);
  const height = Math.min(Math.max(Number(options.height) || 640, 300), 900);
  const win = new BaseWindow({
    width, height: height + STRIP, minWidth: 320, minHeight: 240,
    autoHideMenuBar: true, show: false, title: 'Sign in', backgroundColor: palette.current().p.bg,
    ...(parent && !parent.isDestroyed() ? { x: centre(parent, width, 'x'), y: centre(parent, height + STRIP, 'y') } : {})
  });
  win.setMenuBarVisibility(false);
  const strip = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, javascript: false, devTools: false, spellcheck: false } });
  // Nothing in the strip goes anywhere: not a dropped link, not a key.
  strip.webContents.on('will-navigate', (e) => e.preventDefault());
  strip.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  strip.webContents.on('before-input-event', (e) => e.preventDefault());
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
  const wc = options.webContents;
  // The address the window has committed to, never one it is only asking
  // for: a page can start a navigation to accounts.google.com and stop it,
  // and the strip would then vouch for a page that never left.
  let shown = null;
  const update = () => {
    if (win.isDestroyed() || wc.isDestroyed()) return;
    const url = wc.getURL() || options.url || '';
    if (url !== shown) { shown = url; show(strip, url); }
  };
  show(strip, '');
  const redraw = () => { if (shown !== null) show(strip, shown); };
  live.add(redraw);
  wc.on('did-navigate', update);
  wc.on('did-navigate-in-page', update);
  wc.on('did-finish-load', update);
  // The page may not cover the strip by going full screen.
  const unfull = () => { if (!win.isDestroyed() && win.isFullScreen()) win.setFullScreen(false); };
  wc.on('enter-html-full-screen', () => {
    wc.executeJavaScript('document.exitFullscreen().catch(() => {})').catch(() => {});
    setTimeout(unfull, 50);
  });
  wc.on('leave-html-full-screen', () => setTimeout(unfull, 50));
  wc.on('page-title-updated', (_e, t) => { if (!win.isDestroyed()) win.setTitle(t || 'Sign in'); });
  // window.close() from the page - the end of every sign-in - closes the window.
  wc.on('destroyed', () => { if (!win.isDestroyed()) win.destroy(); });
  win.on('closed', () => {
    live.delete(redraw);
    // Back to the window the sign-in started from, where its answer lands.
    if (parent && !parent.isDestroyed()) parent.focus();
    if (!wc.isDestroyed()) wc.close();
    if (!strip.webContents.isDestroyed()) strip.webContents.close();
  });
  const reveal = () => { if (!win.isDestroyed() && !pending && !win.isVisible()) { win.show(); wc.focus(); } };
  wc.once('ready-to-show', reveal);
  setTimeout(reveal, 1500);
  if (pending) {
    // A blank pop-up shows only once it is sent to a sign-in; sent anywhere
    // else, or nowhere, it was not one.
    wc.on('did-start-navigation', (d) => {
      if (!pending || !d.isMainFrame || d.url === 'about:blank') return;
      if (isPriorityPopup(d.url, opener)) { pending = false; reveal(); return; }
      pending = false;
      win.destroy();
      if (onReject) onReject(d.url);
    });
    setTimeout(() => { if (pending && !win.isDestroyed()) win.destroy(); }, 5000);
  }
  // Ctrl+W (Cmd+W) closes it, as any window.
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && String(input.key).toLowerCase() === 'w') {
      e.preventDefault();
      win.close();
    }
  });
  if (onOpen) onOpen(win, wc);
  return wc;
}

function centre(parent, size, axis) {
  const b = parent.getBounds();
  return Math.round(axis === 'x' ? b.x + (b.width - size) / 2 : b.y + Math.max(0, (b.height - size) / 3));
}

module.exports = { createPopupWindow, isPriorityPopup, restyleAll, stripHtml };
