'use strict';

/**
 * A SOCKS5 stand-in for Tor, for the incognito tests.
 *
 * It records every destination it is asked for and connects the `*.test` ones
 * to the fixture server. Anything else is refused - the tests never ask for
 * anything else, so a name outside `.test` is itself a finding. It listens on a
 * TCP port or, standing in for Tor under the Linux kill switch, a Unix socket.
 */

const net = require('net');

/**
 * @param {number} fixturePort
 * @param {{port?: number, path?: string}} [where] - default: a free loopback port
 * @param {(host: string) => void} [onName]
 */
function socksStub(fixturePort, where = { port: 0 }, onName = () => {}) {
  const seen = [];
  const server = net.createServer((client) => {
    client.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 'greet';
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        buf = buf.subarray(2 + buf[1]);
        client.write(Buffer.from([5, 0]));
        stage = 'request';
      }
      if (stage !== 'request' || buf.length < 5) return;
      const atyp = buf[3];
      let host;
      let len;
      if (atyp === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); len = 10; }
      else if (atyp === 3) { const n = buf[4]; if (buf.length < 7 + n) return; host = buf.subarray(5, 5 + n).toString(); len = 7 + n; }
      else if (atyp === 4) { if (buf.length < 22) return; host = '[ipv6]'; len = 22; }
      else { client.destroy(); return; }
      const port = buf.readUInt16BE(len - 2);
      const rest = buf.subarray(len);
      stage = 'done';
      client.removeListener('data', onData);
      seen.push(`${host}:${port}`);
      onName(`${host}:${port}`);
      if (!/\.test$/.test(host)) {
        client.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));   // host unreachable
        return;
      }
      const upstream = net.connect(fixturePort, '127.0.0.1', () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
    };
    client.on('data', onData);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const done = () => resolve({
      port: where.path ? null : server.address().port,
      seen,
      close: () => server.close()
    });
    if (where.path) server.listen(where.path, done);
    else server.listen(where.port || 0, '127.0.0.1', done);
  });
}

module.exports = { socksStub };
