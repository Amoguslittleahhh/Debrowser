'use strict';

/**
 * Is the Tor we ship the newest stable one?
 *
 *   node tools/tor-watch.js
 *
 * Reads the pinned version from tools/tor.json and the published ones from the
 * Tor Project's own distribution directory, and exits 1 - saying which is
 * newer - when ours is behind. Alphas ("16.0a12") are not stable releases and
 * are ignored. Run weekly by .github/workflows/tor-watch.yml, which opens an
 * issue when it fails: a stale Tor is a security problem, and one that
 * nothing else in this repository would notice.
 *
 * At runtime the browser also asks the Tor network itself whether its Tor is
 * obsolete (GETINFO status/version/current) and says so on the connection
 * page; this is the other half, for the build.
 */

const path = require('path');

const PIN = require(path.join(__dirname, 'tor.json'));

const parse = (v) => v.split('.').map(Number);
function newer(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

/** The stable versions in a directory listing, newest first. */
function stableVersions(html) {
  const found = [...html.matchAll(/href="(\d+(?:\.\d+)+)\/"/g)].map((m) => m[1]);
  return [...new Set(found)].sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
}

async function main() {
  const res = await fetch(`${PIN.base}/`);
  if (!res.ok) throw new Error(`${PIN.base}/: HTTP ${res.status}`);
  const versions = stableVersions(await res.text());
  if (!versions.length) throw new Error('no stable versions found in the listing');
  const latest = versions[0];
  if (newer(latest, PIN.version)) {
    console.log(`Tor is behind: shipping ${PIN.version}, latest stable is ${latest}.`);
    console.log(`Update "version" in tools/tor.json to ${latest}, run \`node tools/fetch-tor.js\`, and check the signature step still passes.`);
    process.exit(1);
  }
  console.log(`Tor is current: shipping ${PIN.version}, latest stable is ${latest}.`);
}

if (require.main === module) {
  main().catch((err) => { console.error(`tor-watch: ${err.message}`); process.exit(2); });
}

module.exports = { newer, stableVersions };
