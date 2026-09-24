'use strict';

/**
 * The one door out of the private namespace.
 *
 * On Linux the private browser runs in a network namespace with nothing in it
 * but loopback (tools/netns-launch.c), and Tor runs outside, listening on a
 * Unix socket. Chromium can only speak SOCKS over TCP, so this listens on the
 * namespace's loopback and hands every connection to Tor's socket, byte for
 * byte. It does not read or change what passes through: SOCKS is between
 * Chromium and Tor.
 *
 * It listens only on 127.0.0.1 inside the namespace, which nothing outside the
 * namespace can reach - a different loopback from the machine's own.
 */

const net = require('net');

/**
 * @param {number} port        - where Chromium was told the proxy is
 * @param {string} socketPath  - Tor's SOCKS socket
 * @returns {Promise<net.Server>} rejects with EADDRINUSE if the port is taken
 */
function startRelay(port, socketPath, log = () => {}) {
  const server = net.createServer((client) => {
    const upstream = net.connect({ path: socketPath });
    // Either end failing ends both: a half-open relay is a request hanging
    // for no reason the page can see.
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on('error', end);
    upstream.on('error', (err) => {
      if (err.code !== 'ECONNRESET') log('relay', `Tor socket: ${err.code || err.message}`);
      end();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', (err) => log('relay', `error: ${err.message}`));
      resolve(server);
    });
  });
}

module.exports = { startRelay };
