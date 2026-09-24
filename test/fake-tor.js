#!/usr/bin/env node
'use strict';

/**
 * Stands in for the Tor binary under the Linux kill-switch test.
 *
 * tools/netns-launch starts "Tor" as `<tor> -f <torrc>` in the original
 * network namespace, exactly as it starts the real one. This reads the same
 * torrc, listens where it says - SOCKS on a Unix socket - with the SOCKS
 * stand-in behind it, writes the control cookie, and prints the bootstrap
 * line the browser follows. Every name it is asked for is appended to
 * $FAKE_TOR_NAMES, for the harness to read after the browser has gone.
 *
 * It exits when its owning process does, as `__OwningControllerProcess` makes
 * the real one do.
 */

const fs = require('fs');
const path = require('path');
const { socksPool } = require('./socks-stub');

const torrc = fs.readFileSync(process.argv[process.argv.indexOf('-f') + 1], 'utf8');
const value = (key) => (new RegExp(`^${key} (.+)$`, 'm').exec(torrc) || [])[1];

// Every SocksPort line, as the real Tor would open them - one per slot.
const sockets = [...torrc.matchAll(/^SocksPort unix:(.+)$/gm)].map((m) => m[1]);
const cookie = value('CookieAuthFile');
const owner = Number(value('__OwningControllerProcess'));
fs.writeFileSync(cookie, Buffer.alloc(32, 7), { mode: 0o600 });

const fixturePort = Number(process.env.FAKE_TOR_FIXTURE_PORT);
const tlsPort = Number(process.env.FAKE_TOR_TLS_PORT) || fixturePort;
const route = (host) => (host.startsWith('tls.') ? tlsPort : fixturePort);
socksPool(sockets.length, route, (slot) => ({ path: sockets[slot] })).then((pool) => {
  // Appended as they arrive, so the harness can read them after the browser has gone.
  const flush = () => {
    if (!process.env.FAKE_TOR_NAMES || !pool.seen.length) return;
    fs.appendFileSync(process.env.FAKE_TOR_NAMES, pool.seen.splice(0).map((s) => `${s.name} ${s.slot}\n`).join(''));
  };
  setInterval(flush, 100);
  console.log('Sep 24 00:00:00.000 [notice] Tor 0.0.0.0 (fake, for the kill-switch test) running on Linux.');
  console.log('Sep 24 00:00:00.000 [notice] Bootstrapped 100% (done): Done');
  setInterval(() => {
    try { process.kill(owner, 0); } catch {
      flush();
      for (const s of sockets) { try { fs.unlinkSync(s); } catch { /* gone */ } }
      process.exit(0);
    }
  }, 250);
}, (err) => {
  console.log(`[err] fake tor could not listen on ${path.basename(sockets[0] || '?')}: ${err.message}`);
  process.exit(1);
});
