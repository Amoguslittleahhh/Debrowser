'use strict';

/**
 * Reader view: the article on a page, without the page around it.
 *
 * Mozilla's Readability - the code behind Firefox's Reader View - runs inside
 * the page, in an isolated world of its own where the page's scripts cannot
 * see or touch it, on a copy of the document. What comes back is the
 * article's title, byline and HTML, which debrowser://reader shows in the
 * browser's own type (reader.html, which also strips anything that could run).
 *
 * After each load the same code asks the cheaper question - is there an
 * article here at all? - so the address bar can offer the button only where
 * it will work.
 */

const fs = require('fs');

const WORLD = 1001;
let sources = null;
const source = () => (sources ||= {
  full: fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8'),
  check: fs.readFileSync(require.resolve('@mozilla/readability/Readability-readerable.js'), 'utf8')
});

/** Whether the page looks like an article worth reading this way. */
async function readerable(wc) {
  if (!wc || wc.isDestroyed() || !/^https?:/i.test(wc.getURL())) return false;
  const code = `${source().check};isProbablyReaderable(document);`;
  try {
    return Boolean(await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]));
  } catch {
    return false;
  }
}

/** The article, or null when the page has none. */
async function extract(wc) {
  if (!wc || wc.isDestroyed() || !/^https?:/i.test(wc.getURL())) return null;
  const code = `${source().full};(() => {
    const a = new Readability(document.cloneNode(true), { charThreshold: 400 }).parse();
    return a && { title: a.title, byline: a.byline, siteName: a.siteName, content: a.content,
                  length: a.length, lang: document.documentElement.lang || '' };
  })();`;
  try {
    const article = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
    return article && article.content && article.length >= 400 ? article : null;
  } catch {
    return null;
  }
}

/** Articles handed to reader pages, by token: the few most recent, so a reload still finds its own. */
class ReaderStore {
  constructor() { this.items = new Map(); }

  put(article, url) {
    const token = require('crypto').randomBytes(9).toString('base64url');
    this.items.set(token, { ...article, url });
    if (this.items.size > 20) this.items.delete(this.items.keys().next().value);
    return token;
  }

  get(token) { return this.items.get(String(token || '')) || null; }
}

module.exports = { readerable, extract, ReaderStore };
