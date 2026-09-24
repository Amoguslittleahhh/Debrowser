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
const { socksStub } = require('./socks-stub');

const torrc = fs.readFileSync(process.argv[process.argv.indexOf('-f') + 1], 'utf8');
const value = (key) => (new RegExp(`^${key} (.+)$`, 'm').exec(torrc) || [])[1];

const socks = value('SocksPort').replace(/^unix:/, '');
const cookie = value('CookieAuthFile');
const owner = Number(value('__OwningControllerProcess'));
fs.writeFileSync(cookie, Buffer.alloc(32, 7), { mode: 0o600 });

socksStub(Number(process.env.FAKE_TOR_FIXTURE_PORT), { path: socks }, (name) => {
  if (process.env.FAKE_TOR_NAMES) fs.appendFileSync(process.env.FAKE_TOR_NAMES, `${name}\n`);
}).then(() => {
  console.log('Sep 24 00:00:00.000 [notice] Tor 0.0.0.0 (fake, for the kill-switch test) running on Linux.');
  console.log('Sep 24 00:00:00.000 [notice] Bootstrapped 100% (done): Done');
  setInterval(() => {
    try { process.kill(owner, 0); } catch { try { fs.unlinkSync(socks); } catch { /* gone */ } process.exit(0); }
  }, 250);
}, (err) => {
  console.log(`[err] fake tor could not listen on ${path.basename(socks)}: ${err.message}`);
  process.exit(1);
});
