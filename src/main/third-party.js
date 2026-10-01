'use strict';

/**
 * Third-party cookies, blocked.
 *
 * A cookie set by one site while you are on another - an ad network's, set
 * from inside every page that carries its ads - is how you are followed from
 * site to site. Safari, Firefox and Brave refuse them; Chrome still does not.
 * Electron gives no switch for it, so it is done on the wire: a request from a
 * page to a *different site* goes out without its cookies, and anything it
 * tries to set on the way back is dropped.
 *
 * "Site" is the registrable domain - `mail.google.com` and `accounts.google.com`
 * are one site, `google.com` and `youtube.com` are two - by the public suffix
 * list (tldts). The page is the top of the frame tree, so an iframe of the page
 * is judged against the page, not against itself.
 *
 * Some sign-in widgets and embedded comment boxes need them. The padlock turns
 * them back on for the site in front (site-prefs.js `thirdPartyCookies`).
 */

const { getDomain } = require('tldts-experimental');
const { WebHooks } = require('./web-hooks');

function siteOf(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (!/^(https?|wss?):$/.test(protocol)) return null;
    // Private suffixes count: alice.github.io and bob.github.io are two sites.
    return getDomain(hostname, { allowPrivateDomains: true }) || hostname;
  } catch {
    return null;
  }
}

/** The page a request is for: the top of its frame, or the tab's own address. */
function pageOf(details) {
  try {
    const top = details.frame?.top?.url;
    if (top) return top;
  } catch { /* frame gone */ }
  try {
    const wc = details.webContents;
    if (wc && !wc.isDestroyed()) return wc.getURL();
  } catch { /* going */ }
  return null;
}

/** Whether a request goes to a different site from the page it is for. */
function isThirdParty(requestUrl, pageUrl) {
  const page = siteOf(pageUrl);
  const target = siteOf(requestUrl);
  return Boolean(page && target && page !== target);
}

const dropHeader = (headers, name) => {
  let dropped = false;
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === name) dropped = true;
    else out[key] = value;
  }
  return dropped ? out : null;
};

class ThirdPartyCookies {
  /**
   * @param {() => boolean} enabled - the setting, read live
   * @param {(pageUrl: string) => boolean} allowedOn - the user turned them on for this page's site
   */
  constructor(enabled, allowedOn) {
    this.enabled = enabled;
    this.allowedOn = allowedOn;
  }

  /** Whether this request's cookies are refused. */
  refuses(details) {
    if (details.resourceType === 'mainFrame' || this.enabled() === false) return false;
    const page = pageOf(details);
    return Boolean(page && isThirdParty(details.url, page) && !this.allowedOn(page));
  }

  attach(session) {
    const hooks = WebHooks.for(session);
    hooks.onBeforeSendHeaders((details) => {
      if (!this.refuses(details)) return undefined;
      const headers = dropHeader(details.requestHeaders, 'cookie');
      return headers ? { requestHeaders: headers } : undefined;
    });
    hooks.onHeadersReceived((details) => {
      if (!this.refuses(details)) return undefined;
      const headers = dropHeader(details.responseHeaders, 'set-cookie');
      return headers ? { responseHeaders: headers } : undefined;
    });
  }
}

module.exports = { ThirdPartyCookies, isThirdParty, siteOf };
