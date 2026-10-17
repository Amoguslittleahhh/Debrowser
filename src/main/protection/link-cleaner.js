'use strict';

/**
 * Tracking taken out of links.
 *
 * Two things, done to every page you open and to every link you copy:
 *
 *   parameters  `?utm_source=newsletter&fbclid=…` tell the site - and whoever
 *               it shares its analytics with - where you came from and which
 *               message you clicked. They do nothing for the page. Removed.
 *
 *   redirects   a link on Facebook, Google's results, Reddit or Steam often
 *               goes to the platform first ("l.facebook.com/l.php?u=…"), which
 *               records the click and then sends you on. The address it is
 *               going to is right there in the link, so the browser goes
 *               straight to it. What Brave calls debouncing.
 *
 * Only parameters that exist to track are listed - never `id`, `q`, `ref` or
 * anything a page might read - and a few that are only tracking on one site
 * (`si` on YouTube and Spotify) are removed only there.
 */

const { WebHooks } = require('../web-hooks');

/** Removed wherever they appear. */
const EVERYWHERE = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid',
  'igshid', 'mc_eid', 'mc_cid', '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsctatracking',
  'mkt_tok', 'oly_anon_id', 'oly_enc_id', 'vero_id', 'vero_conv', 'rb_clickid', 's_cid', 'li_fat_id',
  'epik', 'ss_email_id', 'wickedid', 'srsltid', '_openstat', 'ml_subscriber', 'ml_subscriber_hash'
]);
const PREFIXES = ['utm_'];

/** Removed only on these sites, where they mean "who shared this". */
const PER_SITE = [
  { hosts: /(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com)$/, params: ['si', 'pp', 'feature'] },
  { hosts: /(^|\.)open\.spotify\.com$/, params: ['si', 'context'] },
  { hosts: /(^|\.)(twitter\.com|x\.com)$/, params: ['s', 't', 'ref_src', 'ref_url'] },
  { hosts: /(^|\.)instagram\.com$/, params: ['igsh', 'img_index'] },
  { hosts: /(^|\.)amazon\.[a-z.]+$/, params: ['ref', 'ref_', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_r', 'pf_rd_p', 'psc', 'content-id'] }
];

/**
 * Redirect pages whose destination is a parameter of their own address.
 * Host pattern, path pattern, and the parameter holding the destination.
 */
const REDIRECTORS = [
  [/^(l|lm)\.facebook\.com$/, /^\/l\.php$/, 'u'],
  [/^l\.instagram\.com$/, /^\/$/, 'u'],
  [/^(www\.)?google\.[a-z.]+$/, /^\/url$/, ['q', 'url']],
  [/^(www\.)?youtube\.com$/, /^\/redirect$/, 'q'],
  [/^out\.reddit\.com$/, /^\//, 'url'],
  [/^steamcommunity\.com$/, /^\/linkfilter\/?$/, ['u', 'url']],
  [/^t\.umblr\.com$/, /^\/redirect$/, 'z'],
  [/^href\.li$/, /^\/$/, null],                       // href.li/?https://… - the whole query
  [/^slack-redir\.net$/, /^\/link$/, 'url'],
  [/^disq\.us$/, /^\/url$/, 'url'],
  [/^(www\.)?linkedin\.com$/, /^\/redir\/redirect/, 'url'],
  [/^click\.linksynergy\.com$/, /^\//, 'murl'],
  [/^(www\.)?bing\.com$/, /^\/ck\/a$/, null]         // encoded, can't be read: left alone below
];

/** The destination a redirect link carries, or null. Only http(s), and never a loop to itself. */
function unwrap(parsed) {
  for (const [host, route, param] of REDIRECTORS) {
    if (!host.test(parsed.hostname) || !route.test(parsed.pathname)) continue;
    let target = null;
    if (param === null) {
      let raw = '';
      try { raw = decodeURIComponent(parsed.search.slice(1)); } catch { /* malformed: left alone */ }
      target = /^https?:\/\//i.test(raw) ? raw : null;
    } else {
      for (const name of [].concat(param)) {
        const value = parsed.searchParams.get(name);
        if (value) { target = value; break; }
      }
    }
    if (!target) return null;
    try {
      const next = new URL(target);
      if (!/^https?:$/.test(next.protocol) || next.hostname === parsed.hostname) return null;
      return next;
    } catch {
      return null;
    }
  }
  return null;
}

/** Remove the tracking parameters. Returns whether any were there. */
function strip(parsed) {
  const site = PER_SITE.filter((rule) => rule.hosts.test(parsed.hostname)).flatMap((rule) => rule.params);
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (EVERYWHERE.has(lower) || PREFIXES.some((p) => lower.startsWith(p)) || site.includes(key)) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }
  return changed;
}

/**
 * A link with its tracking taken out: through any redirectors (two at most -
 * one wrapping another is common), then without the tracking parameters.
 * The same string back when there was nothing to take out.
 */
function clean(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return url; }
  if (!/^https?:$/.test(parsed.protocol)) return url;
  let changed = false;
  for (let hops = 0; hops < 2; hops++) {
    const next = unwrap(parsed);
    if (!next) break;
    parsed = next;
    changed = true;
  }
  if (strip(parsed)) changed = true;
  // Untouched when there was nothing to take out: re-serialising an address
  // can change how it is written, and that would be a redirect for nothing.
  if (!changed) return url;
  // An address that had only tracking in its query ends in a bare `?` otherwise.
  return parsed.toString().replace(/\?(#|$)/, '$1');
}

class LinkCleaner {
  /** The ordinary browser's one instance: "Copy link" asks it too. */
  static current = null;

  /** @param {() => boolean} enabled - the setting, read live */
  constructor(enabled) {
    this.enabled = enabled;
    /** Links cleaned since start, for the receipt. */
    this.cleaned = 0;
  }

  /** For "Copy link": the cleaned link, when cleaning is on. */
  forCopy(url) {
    return this.enabled() === false ? url : clean(url);
  }

  attach(session) {
    WebHooks.for(session).onBeforeRequest((details) => {
      if (details.resourceType !== 'mainFrame' || this.enabled() === false || details.method !== 'GET') return undefined;
      const cleaned = clean(details.url);
      if (cleaned === details.url) return undefined;
      this.cleaned += 1;
      return { redirectURL: cleaned };
    });
  }
}

module.exports = { LinkCleaner, clean };
