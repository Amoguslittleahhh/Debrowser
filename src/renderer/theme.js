'use strict';

/**
 * Apply personalisation preferences to whichever view loads this.
 *
 * A plain script rather than a module, because every view here is a classic
 * script under a CSP with no module loader, and because this needs to run
 * before the first state arrives rather than after a fetch.
 *
 * Everything it touches is a `data-` attribute or a custom property, so a change
 * is a style recalculation on the elements that use it - never a rebuild. It
 * writes only on a real change, which matters because preferences ride along
 * with governor state on every tick: without the comparison, a browser sitting
 * idle would touch the DOM twice a second forever.
 */

/** Relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The cross every close and forget button draws.
 *
 * A text `×` sits wherever the face puts it - high in one font, low in the
 * next - so the same button was centred in one view and a pixel off in the
 * one beside it. A path is centred by geometry.
 */
/* eslint-disable-next-line no-unused-vars -- read by chrome.js, history.js, newtab.js, flyout.js */
function crossIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('x-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4.5 4.5l7 7M11.5 4.5l-7 7');
  svg.append(path);
  return svg;
}

/**
 * A stable colour for a site, from its hostname.
 *
 * Used where a page has no favicon to show: the tab strip while one loads or
 * never arrives, and the history list, which stores no icons at all. A letter
 * on a coloured field is recognisable at a glance in a way that a grey
 * placeholder is not, and it is why a strip of twenty tabs no longer reads as
 * one long grey bar.
 *
 * Deliberately here rather than in either caller. Two hashes would mean the
 * same site was one colour in the tab strip and another in history, which is
 * worse than no colour at all - the whole value is that it is the same one
 * everywhere.
 *
 * djb2, because it is four lines and its avalanche is good enough to keep
 * neighbouring hostnames apart, which is the only property that matters here.
 *
 * @param {string} text - a hostname, or anything stable about the site
 * @returns {number} a hue, 0-359
 */
function siteHue(text) {
  let hash = 5381;
  const source = String(text || '');
  for (let i = 0; i < source.length; i++) hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/**
 * Where a view should point an `<img>` to show a site's icon.
 *
 * Never at the site itself. An image in a page is fetched by that page, with
 * its cookies - so a history list would announce to two hundred sites that the
 * user is reading their history. `debrowser://icon` is fetched by the browser
 * process instead, without cookies and only for addresses it already knows
 * about; see icons.js.
 *
 * A `data:` icon is already the image and is passed through. Anything else -
 * including the `file:` icons a local page might declare - returns null, and
 * the caller shows the site's letter.
 *
 * @param {string} url - the icon's own address, as the browser reported it
 * @returns {string|null}
 */
function iconSrc(url) {
  if (typeof url !== 'string' || !url) return null;
  if (url.startsWith('data:image/')) return url;
  if (!/^https?:\/\//i.test(url)) return null;
  return `debrowser://icon?url=${encodeURIComponent(url)}`;
}

/**
 * Where a site's icon is if the page never said: the addresses Chromium itself
 * would have tried.
 *
 * Five views had a byte-identical copy of the first of these, which is five
 * places to change the day the rule is not `origin + /favicon.ico` any more -
 * and it lives here beside `iconSrc` because the two are one decision: where an
 * icon is, and how this browser is allowed to fetch it.
 *
 * `/apple-touch-icon.png` is the second guess because a real number of sites
 * ship one and nothing else. Both are fixed paths on the page's own origin,
 * which is what keeps them inside what the icon route will fetch - see
 * `allowed()` in icons.js.
 */
function defaultIcons(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
    return [`${parsed.origin}/favicon.ico`, `${parsed.origin}/apple-touch-icon.png`];
  } catch {
    return [];
  }
}

/**
 * Show a site's real logo, trying every address it might be at.
 *
 * The tab strip used to set `img.src = iconSrc(tab.favicon)` and stop there: one
 * address, and the site's letter forever if it did not load. apple.com is the
 * case that showed it up - the page declares no icon link at all, and a single
 * failed guess left a browser showing "A" on a site with one of the most
 * recognisable logos there is.
 *
 * So the candidates are tried in order and the letter is only what is left when
 * every one of them has failed. `onerror` and `onload` as properties rather
 * than listeners, because this is re-armed every time a tab navigates and
 * `addEventListener` would stack a new handler on each one.
 *
 * @param {HTMLImageElement} img
 * @param {string} url - the page the icon belongs to
 * @param {string|null} reported - an icon address the browser reported
 * @param {{onLoad?:Function, onFail?:Function}} [hooks]
 * @returns {boolean} whether anything at all will be tried
 */
function showIcon(img, url, reported, { onLoad, onFail } = {}) {
  const sources = [];
  for (const candidate of [reported, ...defaultIcons(url)]) {
    const src = iconSrc(candidate);
    if (src && !sources.includes(src)) sources.push(src);
  }

  let next = 0;
  const advance = () => {
    if (next >= sources.length) {
      img.removeAttribute('src');
      img.hidden = true;
      if (onFail) onFail();
      return;
    }
    img.hidden = false;
    img.src = sources[next++];
  };

  img.onerror = advance;
  img.onload = () => { if (onLoad) onLoad(); };
  advance();
  return sources.length > 0;
}

/**
 * What to call the site an address belongs to.
 *
 * Three copies of the plain hostname form existed, and two more that each added
 * one case to it - the browser's own pages folded into a single "site" so that
 * Settings and the new tab page do not get a colour each, and `file:` named
 * rather than left blank. Both of those are right everywhere, so this is one
 * function with both, rather than five functions with a subset each.
 *
 * Returns the address itself when it cannot be parsed: the callers use this as
 * a label and as the seed for `siteHue`, and an empty string is a worse answer
 * than a strange one.
 */
function siteOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'debrowser:') return 'debrowser';
    if (parsed.protocol === 'file:') return 'local file';
    return parsed.hostname.replace(/^www\./, '') || parsed.protocol;
  } catch {
    return String(url || '');
  }
}

/**
 * The site mark: a letter on a coloured tile, with the site's own logo over it
 * once one loads.
 *
 * Four views built this element by hand, character for character, and the
 * stylesheet half is already shared (`.chip` in theme.css). The DOM half is the
 * part that carries the rule that actually matters: the icon is fetched through
 * the browser, never by the page, and the letter underneath stops painting when
 * a real logo arrives - because almost every favicon is transparent, and a chip
 * left painting behind one shows through it.
 *
 * The two class names are parameters rather than derived from each other: the
 * tab strip's mark is `tab-chip`/`tab-favicon`, which no naming rule would
 * produce, and a helper that guesses a class is one that fails silently when a
 * view is renamed.
 *
 * @param {string} url - the page the mark stands for
 * @param {object} [opts]
 * @param {string|null} [opts.icon] - an icon address the browser reported
 * @param {string} [opts.chipClass] - the view's class for the tile
 * @param {string} [opts.iconClass] - the view's class for the logo
 */
/* eslint-disable-next-line no-unused-vars -- read by chrome.js, history.js, downloads.js, flyout.js, newtab.js */
function siteChip(url, { icon = null, chipClass = 'chip', iconClass = 'site-icon' } = {}) {
  const host = siteOf(url);

  const chip = document.createElement('span');
  chip.className = chipClass;
  chip.setAttribute('aria-hidden', 'true');
  chip.textContent = (host.replace(/^[^a-z0-9]+/i, '')[0] || '?');
  chip.style.setProperty('--hue', String(siteHue(host)));

  const img = document.createElement('img');
  img.className = iconClass;
  img.alt = '';
  // Decoded off the main thread, and only for the rows on screen: three
  // hundred history rows at once would be a burst of requests for a list the
  // user has scrolled two screens of.
  img.decoding = 'async';
  img.loading = 'lazy';
  chip.append(img);
  // Every address the icon might be at, in order, and the letter underneath
  // until one of them loads. See `showIcon`.
  showIcon(img, url, icon, {
    onLoad: () => chip.classList.add('has-icon'),
    onFail: () => img.remove()
  });

  return chip;
}

function applyThemePrefs(prefs) {
  if (!prefs) return;
  const body = document.body;

  const flags = {
    theme: prefs.theme,
    tabs: prefs.tabWidth,
    // Which way the chrome is laid out. The main process has already given the
    // view the matching rectangle; this is the stylesheet's half of the same
    // decision, and the two are read from one preference so they cannot
    // disagree about which shape the window is.
    layout: prefs.tabBarPosition === 'left' ? 'left' : 'top',
    meter: prefs.showMemoryMeter ? 'on' : 'off',
    dots: prefs.showTierDots ? 'on' : 'off'
  };
  for (const [key, value] of Object.entries(flags)) {
    if (body.dataset[key] !== value) body.dataset[key] = value;
  }

  if (body.style.getPropertyValue('--accent') !== prefs.accent) {
    body.style.setProperty('--accent', prefs.accent);
  }

  // The tab strip is its own colour, deliberately not the accent: it is the
  // largest painted area in the chrome, and what works as a 3px focus ring is
  // rarely what you want across the top of a window. 'mirror' is for anyone who
  // would rather not choose twice.
  const strip = prefs.tabBarColor === 'mirror' ? prefs.accent
    : prefs.tabBarColor === 'default' ? '' : prefs.tabBarColor;
  if (body.style.getPropertyValue('--strip') !== strip) {
    if (strip) body.style.setProperty('--strip', strip);
    else body.style.removeProperty('--strip');
  }
  // Every preset strip is dark, and so is most accents' mirror. Under the light
  // palette that put dim grey titles on near-black; the strip's own lightness
  // decides which ink its tabs use. See `data-strip-tone` in chrome.css.
  const tone = strip ? (luminance(strip) < 0.35 ? 'dark' : 'light') : '';
  if ((body.dataset.stripTone || '') !== tone) {
    if (tone) body.dataset.stripTone = tone;
    else delete body.dataset.stripTone;
  }

  // Translucency applies to the strip, not the window. See chrome.css; the
  // short version is that fading the whole window fades the page text with it.
  // `data-translucent` is separate from the number because the body only drops
  // its own background while there is actually something to see through to.
  const alpha = typeof prefs.windowOpacity === 'number' ? prefs.windowOpacity : 1;
  if (body.style.getPropertyValue('--strip-alpha') !== String(alpha)) {
    body.style.setProperty('--strip-alpha', String(alpha));
  }
  // Only on a change, like every other write in this file. Assigning a dataset
  // property is a setAttribute on <body>, and this runs on every state
  // broadcast - so an idle browser was touching an attribute twice a second for
  // a value that had not moved since launch.
  const translucent = alpha < 1 ? 'on' : 'off';
  if (body.dataset.translucent !== translucent) body.dataset.translucent = translucent;

  // Motion is opt-out in the OS and opt-out here; `still` is also set while a
  // page is off screen, because a throttled animation finishes in front of the
  // user instead of before them.
  body.classList.toggle('calm', prefs.reduceMotion === true);
}

/**
 * Put a sheet under the button that opened it.
 *
 * Shared by the app menu and the downloads flyout, which are the same shape:
 * a panel in a window-sized transparent view, right-aligned to a toolbar
 * button, kept inside the window when it will not fit where it was asked to
 * go. Two copies of this arithmetic drifting apart is how one panel ends up
 * hanging off the bottom of the screen while the other does not.
 *
 * @param {HTMLElement} sheet
 * @param {{x:number, y:number, right:number}} anchor - window coordinates of
 *   the button; `right` is its right edge, which is the one a panel aligns to.
 * @param {number} edge - how close to the window's sides it may come
 */
/* eslint-disable-next-line no-unused-vars -- read by menu.js, flyout.js, context.js */
function anchorSheet(sheet, anchor, edge = 8, align = 'right') {
  const width = sheet.offsetWidth;
  const height = sheet.offsetHeight;
  const right = anchor.right || anchor.x;

  // A panel hangs from a button's right edge; a context menu opens down and to
  // the right of the pointer, the way every menu opened by a right-click does.
  // Both still get clamped to the window, which is the part that matters.
  let left = align === 'left' ? anchor.x : right - width;
  left = Math.min(Math.max(edge, left), Math.max(edge, window.innerWidth - width - edge));

  let top = align === 'left' ? anchor.y : anchor.y + 6;
  if (top + height > window.innerHeight - edge) {
    // Above the button if it fits there, otherwise pinned to the bottom edge -
    // a panel hanging off the screen is worse than one that is not quite where
    // it was asked to be.
    // A button's height clears the button; a pointer has none to clear.
    const above = anchor.y - height - (align === 'left' ? 0 : 40);
    top = above > edge ? above : Math.max(edge, window.innerHeight - height - edge);
  }

  sheet.style.left = `${Math.round(left)}px`;
  sheet.style.top = `${Math.round(top)}px`;
}

/*
 * The theme, before anything has been asked for.
 *
 * Every view here themes itself from the preferences, and every view used to
 * receive its first set *after* it had painted - on a reply, or on the
 * governor's next broadcast. So a sheet came up in whatever the machine's
 * `prefers-color-scheme` said and turned into the browser's palette a frame
 * later: on a machine set to Light with Dark chosen, a white menu flashing over
 * a dark browser.
 *
 * The browser knows the answer when it creates the view and hands it over
 * through the preload, so this applies the whole set - not the two values a
 * query string could carry, which left the layout, strip colour and motion
 * settings still arriving late.
 */
if (window.debrowser && window.debrowser.prefs) applyThemePrefs(window.debrowser.prefs);

/**
 * Report typed-but-unsent text to the browser.
 *
 * The browser's own pages are governed like any other tab now, which means one
 * of them can be discarded while you are not looking at it. What that must
 * never lose is something you typed and have not used yet - a half-written
 * search, a query on the new tab page.
 *
 * Every other page in the browser is watched by `probe-preload.js`, which is
 * what sets a tab's `hasDirtyInput`. These pages do not get that preload - they
 * get the command bridge instead - so nothing was watching them at all, and the
 * governor had no way to know they were holding anything.
 *
 * Only fields marked `data-transient` count. A settings control is not
 * transient: it saves the moment it changes, so there is nothing to protect and
 * marking it would pin Settings open forever the first time you set a homepage.
 */
/* eslint-disable-next-line no-unused-vars -- read by newtab.js, history.js, downloads.js */
function watchTransientInput(api) {
  let reported = false;
  const report = () => {
    const dirty = [...document.querySelectorAll('[data-transient]')]
      .some((el) => String(el.value || '').trim().length > 0);
    if (dirty === reported) return;
    reported = dirty;
    api.send('page-dirty', { dirty });
  };
  document.addEventListener('input', report);
  document.addEventListener('change', report);
  // For a caller that removes a field outright, which fires neither event.
  return report;
}
