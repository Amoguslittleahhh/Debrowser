'use strict';

/**
 * Translating a page, or the words selected on it.
 *
 * Chromium's translate bar is part of Chrome, not of the engine Electron
 * builds, so there is nothing built in to switch on. This sends the page to
 * Google Translate's own website proxy (`*.translate.goog`), which fetches the
 * page and serves it back translated, links and all - the route Google's
 * translate site uses for "translate this page".
 *
 * What that costs, said plainly in the menu's wording and in Settings: Google
 * sees the address being translated and fetches the page itself. It does not
 * see this browser's cookies, so a page you are signed in to is translated as
 * a signed-out visitor sees it. Nothing is sent until the user picks the item.
 * Never offered in a private window.
 */

const { isLocalHost } = require('./incognito/policy');

const PROXY_SUFFIX = '.translate.goog';

/** Names that cannot be on the public internet, as HTTPS-first counts them (https-first.js). */
const RESERVED = ['.test', '.example', '.invalid', '.localhost', '.local', '.lan', '.home.arpa', '.internal', '.corp'];

/** The proxy's name for a site is one DNS label, and a label holds 63 characters. */
const MAX_LABEL = 63;

/** The languages Settings offers, by their BCP 47 code. Google's codes. */
const LANGUAGES = ['af', 'am', 'ar', 'az', 'bg', 'bn', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en', 'es', 'et', 'eu', 'fa',
  'fi', 'fr', 'gl', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'ka', 'kk', 'km', 'kn', 'ko', 'lo', 'lt',
  'lv', 'mk', 'ml', 'mn', 'mr', 'ms', 'my', 'ne', 'nl', 'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'si', 'sk', 'sl', 'sq', 'sr',
  'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'uz', 'vi', 'zh-CN', 'zh-TW', 'zu'];

/**
 * The language to translate into: the one chosen in Settings, else the
 * system's (`app.getLocale()`), reduced to a code Google knows.
 */
function targetLanguage(pref, locale) {
  if (pref && pref !== 'auto' && LANGUAGES.includes(pref)) return pref;
  const tag = String(locale || 'en').replace('_', '-');
  if (/^zh-(TW|HK|MO|Hant)/i.test(tag)) return 'zh-TW';
  if (/^zh/i.test(tag)) return 'zh-CN';
  const primary = tag.split('-')[0].toLowerCase();
  if (primary === 'nb' || primary === 'nn') return 'no';
  if (primary === 'iw') return 'he';
  if (primary === 'fil') return 'tl';
  return LANGUAGES.includes(primary) ? primary : 'en';
}

/** "French", "German": the language's name in the language the menu is in. */
function languageName(code, displayIn = 'en') {
  try {
    return new Intl.DisplayNames([displayIn], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

/**
 * A host the proxy cannot reach: this machine, the local network, a bare
 * address, a name reserved off the internet. A final dot is the same name.
 */
function isPrivateHost(hostname) {
  const host = hostname.replace(/\.$/, '');
  return host === 'localhost' || !host.includes('.') || isLocalHost(host) || hostname.startsWith('[') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || RESERVED.some((suffix) => host.endsWith(suffix));
}

/** A query's own pairs, as the page wrote them, without Google's. */
function ownQuery(search) {
  return search.slice(1).split('&').filter((pair) => pair && !pair.startsWith('_x_tr_')).join('&');
}

/** True when `url` is already a page served through the proxy. */
function isTranslated(url) {
  try {
    return new URL(url).hostname.endsWith(PROXY_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * The proxy's address for a page: `www.example.com` becomes
 * `www-example-com.translate.goog` (a hyphen in the name is doubled first, so
 * the two can be told apart), with the language pair in the query.
 */
function pageUrl(url, target) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port || isPrivateHost(u.hostname)) return null;
  if (isTranslated(url)) return null;
  const label = u.hostname.replace(/\.$/, '').replace(/-/g, '--').replace(/\./g, '-');
  if (label.length > MAX_LABEL) return null;
  // Added to the query as the page wrote it: put through URLSearchParams, a
  // %20 came back as + and `?flag` as `?flag=`. A plain-HTTP site is fetched
  // over HTTP, which Google is told with `_x_tr_sch`.
  const own = ownQuery(u.search);
  const tl = encodeURIComponent(target);
  const ours = `_x_tr_sl=auto&_x_tr_tl=${tl}&_x_tr_hl=${tl}${u.protocol === 'http:' ? '&_x_tr_sch=http' : ''}`;
  return new URL(`https://${label}${PROXY_SUFFIX}${u.pathname}?${own ? `${own}&` : ''}${ours}${u.hash}`).toString();
}

/** The page a proxied address stands for, for "Show original". */
function originalUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!u.hostname.endsWith(PROXY_SUFFIX)) return null;
  const label = u.hostname.slice(0, -PROXY_SUFFIX.length);
  // Undo pageUrl: a doubled hyphen was a hyphen, a single one was a dot.
  const host = label.replace(/--/g, '\u0000').replace(/-/g, '.').replace(/\u0000/g, '-');
  const scheme = u.searchParams.get('_x_tr_sch') === 'http' ? 'http' : 'https';
  const own = ownQuery(u.search);
  try {
    return new URL(`${scheme}://${host}${u.pathname}${own ? `?${own}` : ''}${u.hash}`).toString();
  } catch {
    return null;
  }
}

/** Google Translate's page for some selected words. */
function textUrl(text, target) {
  // Not through the middle of a character: half an emoji is a stray mark.
  const words = String(text || '').trim().slice(0, 5000).replace(/[\uD800-\uDBFF]$/, '');
  if (!words) return null;
  const out = new URL('https://translate.google.com/');
  out.searchParams.set('sl', 'auto');
  out.searchParams.set('tl', target);
  out.searchParams.set('text', words);
  out.searchParams.set('op', 'translate');
  return out.toString();
}

module.exports = { LANGUAGES, targetLanguage, languageName, pageUrl, originalUrl, textUrl, isTranslated };
