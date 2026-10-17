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

const PROXY_SUFFIX = '.translate.goog';

/** The languages Settings offers, by their BCP 47 code. Google's codes. */
const LANGUAGES = ['ar', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hu', 'id', 'it',
  'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'sw', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'zh-CN', 'zh-TW'];

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

/** A host the proxy cannot reach: this machine, the local network, a bare address. */
function isPrivateHost(host) {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || !host.includes('.') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
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
  const host = u.hostname.replace(/-/g, '--').replace(/\./g, '-');
  const out = new URL(`https://${host}${PROXY_SUFFIX}${u.pathname}`);
  out.search = u.search;
  out.searchParams.set('_x_tr_sl', 'auto');
  out.searchParams.set('_x_tr_tl', target);
  out.searchParams.set('_x_tr_hl', target);
  out.hash = u.hash;
  return out.toString();
}

/** The page a proxied address stands for, for "Show original". */
function originalUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!u.hostname.endsWith(PROXY_SUFFIX)) return null;
  const label = u.hostname.slice(0, -PROXY_SUFFIX.length);
  // Undo pageUrl: a doubled hyphen was a hyphen, a single one was a dot.
  const host = label.replace(/--/g, '\u0000').replace(/-/g, '.').replace(/\u0000/g, '-');
  const out = new URL(`https://${host}${u.pathname}`);
  for (const [key, value] of u.searchParams) if (!key.startsWith('_x_tr_')) out.searchParams.append(key, value);
  out.hash = u.hash;
  return out.toString();
}

/** Google Translate's page for some selected words. */
function textUrl(text, target) {
  const words = String(text || '').trim().slice(0, 5000);
  if (!words) return null;
  const out = new URL('https://translate.google.com/');
  out.searchParams.set('sl', 'auto');
  out.searchParams.set('tl', target);
  out.searchParams.set('text', words);
  out.searchParams.set('op', 'translate');
  return out.toString();
}

module.exports = { LANGUAGES, targetLanguage, languageName, pageUrl, originalUrl, textUrl, isTranslated };
