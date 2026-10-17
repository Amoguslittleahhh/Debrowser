'use strict';

/**
 * Several listeners on one session's network hooks.
 *
 * Electron keeps one listener per `webRequest` event per session: registering
 * a second silently replaces the first. The blocker, the link cleaner, the
 * HTTPS upgrade and the header watch in speculation.js all want the same two
 * events, so each registers here instead, and this is the only code that
 * calls `session.webRequest.onBeforeRequest` or `onHeadersReceived` for the
 * ordinary browser's session. (Private windows have their own, stricter
 * policy in incognito/policy.js and do not use this.)
 *
 * Handlers run in the order they were added. A handler returns nothing to pass,
 * or a result - synchronously, or as a promise when it must wait:
 *
 *   before:  { cancel: true } or { redirectURL } - the first one wins, and
 *            the handlers after it are not asked;
 *   headers: { responseHeaders } - handed on to the next handler, which sees
 *            the edited headers; { cancel: true } ends it.
 *
 * Only web traffic comes through: our own pages and files never reach a
 * handler.
 */

const pages = require('./pages');

const FILTER = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };
// Our own pages' files as well, for one check before any handler: a website
// asking for them is refused (pages.fromWebPage). Handlers never see them.
const BEFORE_FILTER = { urls: [...FILTER.urls, `${pages.SCHEME}://*/*`] };

const hubs = new WeakMap();

class WebHooks {
  /** The hub for a session, created and installed on first use. */
  static for(session) {
    let hub = hubs.get(session);
    if (!hub) {
      hub = new WebHooks(session);
      hubs.set(session, hub);
    }
    return hub;
  }

  constructor(session) {
    this.session = session;
    this.before = [];
    this.headers = [];
    this.sending = [];
    this.installed = { before: false, headers: false, sending: false };
  }

  /**
   * The headers a request is about to send. A handler returns
   * { requestHeaders } to change them for the handlers after it and for the
   * request; { cancel: true } stops it.
   */
  onBeforeSendHeaders(handler) {
    this.sending.push(handler);
    if (this.installed.sending) return;
    this.installed.sending = true;
    this.session.webRequest.onBeforeSendHeaders(FILTER, (details, callback) => {
      let edited = null;
      const each = (r) => {
        if (r && r.requestHeaders) {
          edited = r.requestHeaders;
          details = { ...details, requestHeaders: edited };
        }
        return Boolean(r && r.cancel);
      };
      run(this.sending, details, (result) => {
        if (result && result.cancel) callback({ cancel: true });
        else callback(edited ? { requestHeaders: edited } : {});
      }, each, () => details);
    });
  }

  onBeforeRequest(handler) {
    this.before.push(handler);
    if (this.installed.before) return;
    this.installed.before = true;
    this.session.webRequest.onBeforeRequest(BEFORE_FILTER, (details, callback) => {
      if (pages.isInternal(details.url)) {
        callback(pages.fromWebPage(details) ? { cancel: true } : {});
        return;
      }
      run(this.before, details, (result) => callback(result || {}),
        (r) => Boolean(r && (r.cancel || r.redirectURL)));
    });
  }

  /**
   * Watch an event that changes nothing - onSendHeaders, onResponseStarted,
   * onBeforeRedirect, onCompleted, onErrorOccurred. Every handler hears every
   * request; none can answer. Electron keeps one listener per event here too,
   * so the downloads watch and extensions' webRequest share these.
   */
  observe(event, handler) {
    const list = (this.observers ||= {})[event] ||= [];
    list.push(handler);
    if (list.length > 1) return;
    this.session.webRequest[event](FILTER, (details) => {
      for (const h of list) {
        try { h(details); } catch { /* one watcher must not stop the rest */ }
      }
    });
  }

  onHeadersReceived(handler) {
    this.headers.push(handler);
    if (this.installed.headers) return;
    this.installed.headers = true;
    this.session.webRequest.onHeadersReceived(FILTER, (details, callback) => {
      let edited = null;
      const each = (r) => {
        if (r && r.responseHeaders) {
          edited = r.responseHeaders;
          details = { ...details, responseHeaders: edited };
        }
        return Boolean(r && r.cancel);
      };
      run(this.headers, details, (result) => {
        if (result && result.cancel) callback({ cancel: true });
        else callback(edited ? { responseHeaders: edited } : {});
      }, each, () => details);
    });
  }
}

/**
 * Ask each handler in turn until `stops` says a result is final. Synchronous
 * all the way when no handler returns a promise, which is the common case and
 * the one a request waits on.
 */
function run(list, details, done, stops, current = () => details) {
  let i = 0;
  const next = (result) => {
    if (stops(result)) { done(result); return; }
    while (i < list.length) {
      let out;
      try {
        out = list[i++](current());
      } catch {
        out = undefined;        // one broken handler must not stall every request
      }
      if (out && typeof out.then === 'function') {
        out.then(next, () => next(undefined));
        return;
      }
      if (stops(out)) { done(out); return; }
    }
    done(null);
  };
  next(undefined);
}

module.exports = { WebHooks };
