'use strict';

/**
 * Page zoom, as a policy rather than as whatever Chromium last stored.
 *
 * Chromium keeps one zoom level per host, and every way of setting a zoom
 * writes to it - `setZoomFactor`, and the `zoomFactor` web preference too.
 * Measured: a renderer built with a 1.25 default left 1.25 recorded for the
 * site it loaded, and a second renderer with no default opened that site at
 * 1.25 as well. So a default zoom applied that way pinned every site it
 * touched, and changing the default afterwards reached none of them - nor
 * did "reset", which is itself a `setZoomFactor`.
 *
 * So the browser decides instead. It remembers the sites the user zoomed
 * themselves, and on every navigation sets the page to that zoom or, for any
 * other site, to the current default. What Chromium stores is then only ever
 * a copy of this, and a stale one is corrected at the next navigation.
 *
 * Held for the session, which is as long as Chromium would have held it.
 */
class SiteZoom {
  /** @param {() => number} defaultZoom - read live, so a change applies at once */
  constructor(defaultZoom) {
    this.defaultZoom = defaultZoom;
    /** hostname -> the factor the user chose for it */
    this.chosen = new Map();
  }

  /** The host Chromium keys its zoom by, or null for anything that is not a website. */
  static hostOf(url) {
    try {
      const parsed = new URL(url);
      return /^https?:$/.test(parsed.protocol) ? parsed.hostname : null;
    } catch {
      return null;
    }
  }

  get fallback() {
    return Number(this.defaultZoom()) || 1;
  }

  /** Bring a page to the zoom this policy says, if it is not there already. */
  apply(wc) {
    const host = SiteZoom.hostOf(wc.getURL());
    if (!host) return;          // our own pages keep the zoom they set themselves
    const want = this.chosen.get(host) ?? this.fallback;
    if (Math.abs(wc.getZoomFactor() - want) > 0.001) wc.setZoomFactor(want);
  }

  /** The user zoomed this page. Remembered for its site, unless it is the default. */
  choose(wc, factor) {
    wc.setZoomFactor(factor);
    const host = SiteZoom.hostOf(wc.getURL());
    if (!host) return;
    if (Math.abs(factor - this.fallback) < 0.001) this.chosen.delete(host);
    else this.chosen.set(host, factor);
  }

  /** Forget the site's own zoom; it follows the default again. */
  reset(wc) {
    const host = SiteZoom.hostOf(wc.getURL());
    if (!host) { wc.setZoomFactor(1); return; }
    this.chosen.delete(host);
    this.apply(wc);
  }
}

module.exports = { SiteZoom };
