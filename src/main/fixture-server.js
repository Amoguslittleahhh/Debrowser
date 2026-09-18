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
  '.ico': 'image/x-icon'
};

const contentType = (name) => TYPES[path.extname(name).toLowerCase()] || 'text/plain; charset=utf-8';

function start() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
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
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

/** Local file URL for a fixture, for cases that do not need distinct sites. */
const fileUrl = (page) => `file://${path.join(PAGES, page)}`;

module.exports = { start, fileUrl, HOST_RESOLVER_RULES, PAGES };
