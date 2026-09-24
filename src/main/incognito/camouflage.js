'use strict';

/**
 * Traffic camouflage: a decoy page load alongside every real one.
 *
 * Tor hides where traffic goes, but not its shape - the sizes and timing of a
 * page load. Published attacks guess which site someone is visiting from that
 * shape alone ("website fingerprinting"). Loading a second, unrelated page at
 * the same moment blurs it: the observer sees two overlapping loads and has to
 * untangle them. In the study this copies (Panchenko et al., 2011,
 * "Camouflage"), that cut classifier accuracy substantially. It lowers the
 * odds; it does not remove them. Tor's own circuit padding stays on under it.
 *
 * Costs, said plainly: roughly double the bandwidth, and a site on the list
 * sees visits you did not make. Off by default.
 *
 * The decoy runs in a partition of its own on a circuit the page is not using,
 * with JavaScript off (it has nothing to do but be fetched), in a view nobody
 * sees. Its storage is cleared before each load, so decoys cannot be linked to
 * one another by cookies. The list is bundled and a different entry is picked
 * each time - never fetched from anywhere, which would itself be a signal.
 */

const { WebContentsView, session } = require('electron');
const mode = require('./mode');

/** A decoy still loading after this is dropped: the real page has long finished. */
const DECOY_TIMEOUT_MS = 20_000;

/**
 * Popular sites, all HTTPS, of the kinds people load all day: news, reference,
 * shopping, video, weather, travel. What matters is that they are ordinary.
 */
const DECOYS = [
  'https://www.wikipedia.org/', 'https://en.wikipedia.org/wiki/Special:Random', 'https://www.bbc.com/news',
  'https://www.reuters.com/', 'https://apnews.com/', 'https://www.theguardian.com/international',
  'https://www.nytimes.com/', 'https://www.aljazeera.com/', 'https://www.npr.org/', 'https://www.dw.com/en/',
  'https://www.lemonde.fr/', 'https://www.spiegel.de/', 'https://elpais.com/', 'https://www.nhk.or.jp/',
  'https://www.amazon.com/', 'https://www.ebay.com/', 'https://www.etsy.com/', 'https://www.ikea.com/',
  'https://www.target.com/', 'https://www.bestbuy.com/', 'https://www.walmart.com/',
  'https://www.youtube.com/', 'https://vimeo.com/', 'https://www.twitch.tv/', 'https://soundcloud.com/',
  'https://www.imdb.com/', 'https://www.rottentomatoes.com/', 'https://www.goodreads.com/',
  'https://weather.com/', 'https://www.accuweather.com/', 'https://www.timeanddate.com/',
  'https://www.booking.com/', 'https://www.tripadvisor.com/', 'https://www.airbnb.com/', 'https://www.expedia.com/',
  'https://stackoverflow.com/questions', 'https://github.com/explore', 'https://developer.mozilla.org/',
  'https://news.ycombinator.com/', 'https://www.reddit.com/r/popular/', 'https://medium.com/',
  'https://www.allrecipes.com/', 'https://www.bbcgoodfood.com/', 'https://www.seriouseats.com/',
  'https://www.espn.com/', 'https://www.nba.com/', 'https://www.fifa.com/', 'https://www.formula1.com/',
  'https://www.nationalgeographic.com/', 'https://www.nasa.gov/', 'https://www.britannica.com/',
  'https://www.khanacademy.org/', 'https://www.coursera.org/', 'https://www.duolingo.com/',
  'https://www.linkedin.com/', 'https://www.indeed.com/', 'https://www.zillow.com/',
  'https://www.cnet.com/', 'https://www.theverge.com/', 'https://arstechnica.com/', 'https://www.wired.com/'
];

class Camouflage {
  /**
   * @param {object} opts
   * @param {object} opts.ctx       - the incognito context (for the proxy ports)
   * @param {object} opts.circuits  - picks the decoy's circuit
   * @param {boolean} opts.enabled
   * @param {string[]} [opts.list]  - the decoys; the bundled list by default
   */
  constructor({ ctx, circuits, enabled, list = DECOYS, log = () => {} }) {
    this.ctx = ctx;
    this.circuits = circuits;
    this.enabled = Boolean(enabled);
    this.list = list;
    this.log = log;
    this.last = null;
    this.view = null;
    this.timer = null;
    this.fired = 0;
    this.ses = null;
  }

  /** A real page started loading in `tab`. */
  onNavigation(tab, url) {
    if (!this.enabled || !/^https?:/.test(String(url))) return;
    this.fire(tab).catch((err) => this.log('camouflage', `decoy failed: ${err.message}`));
  }

  /** A different decoy from the last one. */
  pick() {
    if (this.list.length === 1) return this.list[0];
    let url;
    do { url = this.list[Math.floor(Math.random() * this.list.length)]; } while (url === this.last);
    this.last = url;
    return url;
  }

  async fire(tab) {
    this.stop();
    if (!this.ses) this.ses = session.fromPartition('incognito-decoy');
    // Never the page's own circuit: two loads leaving from one exit would be
    // no cover for each other at that exit.
    const pageSlot = mode.slotOf(tab.session);
    let slot = this.circuits.nextSlot();
    if (slot === pageSlot) slot = this.circuits.nextSlot();
    mode.configureSession(this.ses, this.ctx, slot);
    try { this.ses.closeAllConnections(); } catch { /* older Electron */ }
    await this.ses.clearStorageData().catch(() => {});

    const url = this.pick();
    this.view = new WebContentsView({
      webPreferences: { session: this.ses, javascript: false, sandbox: true, webgl: false, spellcheck: false }
    });
    const view = this.view;
    this.fired += 1;
    this.timer = setTimeout(() => this.stop(), DECOY_TIMEOUT_MS);
    this.timer.unref?.();
    view.webContents.loadURL(url).catch(() => {}).finally(() => {
      // Held briefly after the load, as a page is: subresources still arriving.
      setTimeout(() => { if (this.view === view) this.stop(); }, 1500).unref?.();
    });
    return { url, slot };
  }

  stop() {
    clearTimeout(this.timer);
    if (this.view) {
      try { this.view.webContents.close(); } catch { /* already gone */ }
      this.view = null;
    }
  }
}

module.exports = { Camouflage, DECOYS };
