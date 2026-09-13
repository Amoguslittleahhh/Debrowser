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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
