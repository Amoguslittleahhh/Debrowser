'use strict';

/**
 * Serves the test fixture pages over HTTP, so each tab can be given its own
 * *site* rather than sharing one.
 *
 * This exists to keep measurements honest. Every fixture is a local file, and
 * `file://` URLs are all one site as far as Chromium's process model is
 * concerned - so with one-renderer-per-site enabled, thirty file:// tabs
 * collapse into two processes and the browser looks dramatically thriftier than
 * it would be for somebody browsing thirty different domains.
 *
 * Paired with `--host-resolver-rules=MAP *.test 127.0.0.1`, serving over HTTP
 * lets each tab get a distinct registrable domain (t1.test, t2.test, …), which
 * is what real browsing looks like to the process model - and, incidentally,
 * the only configuration in which per-tab CPU is exactly attributable, since
 * each tab then owns its renderer.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PAGES = path.join(__dirname, '..', '..', 'test', 'pages');

/** The Chromium switch that makes `*.test` hostnames resolve locally. */
const HOST_RESOLVER_RULES = 'MAP *.test 127.0.0.1';

/**
 * What to serve a fixture as.
 *
 * Everything here used to go out as HTML, which was fine while every fixture
 * was a page. A favicon served as text/html is not an image, and the tab strip
 * would have shown nothing - so the one check that the icon path works would
 * have failed for a reason that has nothing to do with the browser.
 */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
};

const contentType = (name) => TYPES[path.extname(name).toLowerCase()] || 'text/plain; charset=utf-8';

/**
 * `/challenge?id=<id>` answers like a site that blocks Tor exits: a 403 with
 * a challenge page for the first two requests of each id, then the page.
 * `&always=1` never lets it through. Used by the incognito leak test to show
 * a blocked tab moves to another circuit, and gives up after a few.
 */
const CHALLENGE_REFUSALS = 2;
function challenge(req, res, seen) {
  const query = new URL(req.url, 'http://fixture').searchParams;
  const id = query.get('id') || '';
  const n = (seen.get(id) || 0) + 1;
  seen.set(id, n);
  res.setHeader('Cache-Control', 'no-store');
  if (query.has('always') || n <= CHALLENGE_REFUSALS) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Just a moment...</title><p>Checking your browser. Complete the challenge to continue.</p>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>passed</title><p>Loaded on attempt ${n}.</p>`);
}

function start() {
  const challenges = new Map();
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if ((req.url || '').startsWith('/challenge')) { challenge(req, res, challenges); return; }
      // What the browser told the site about itself, for the fingerprint check.
      if (req.url === '/headers') {
        const told = Object.fromEntries(Object.entries(req.headers)
          .filter(([k]) => /^(user-agent|accept-language|sec-ch-ua.*)$/.test(k)));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(told));
        return;
      }
      // Serve only basenames out of the fixtures directory; nothing else is
      // reachable, however the request is spelled.
      const name = path.basename((req.url || '/').split('?')[0]) || 'idle.html';
      const file = path.join(PAGES, name);
      if (path.dirname(file) !== PAGES || !fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType(name) });
      fs.createReadStream(file).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        /** URL for `page` on its own distinct site, keyed by `index`. */
        url: (page, index) =>
          `http://t${index}.test:${port}/${String(page).replace(/^\/+/, '')}`,
        /*
         * Shut down without waiting for the tabs still holding it open.
         *
         * `server.close()` stops accepting and then waits for every existing
         * connection to end - and a browser with twenty live tabs on these
         * fixtures is keeping twenty keep-alive sockets open, none of which
         * will close on their own. The suite ran all of its checks and then
         * hung on the way out, more often the more tabs it left alive, which
         * read as the machine being slow and was not: it was this, waiting for
         * connections that had no reason to end.
         *
         * `closeAllConnections` is the documented way to say "and drop what is
         * still attached". Guarded because it arrived in Node 18.2 and this
         * file is the one place that would break silently on an older one - by
         * hanging, which is exactly the failure being fixed.
         */
        close: () => new Promise((done) => {
          server.close(done);
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        })
      });
    });
  });
}

/** Local file URL for a fixture, for cases that do not need distinct sites. */
const fileUrl = (page) => `file://${path.join(PAGES, page)}`;

module.exports = { start, fileUrl, HOST_RESOLVER_RULES, PAGES };
