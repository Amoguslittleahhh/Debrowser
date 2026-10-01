'use strict';

/**
 * Is the Electron we ship the newest castLabs build?
 *
 *   node tools/electron-watch.js
 *
 * Every Chromium security fix reaches Debrowser through Electron, and Widevine
 * ties us to castLabs' builds of it, which follow upstream Electron by days to
 * weeks. This reads the pinned tag from package.json, castLabs' published tags
 * (git ls-remote, no API token needed) and upstream's release list, and:
 *
 *   exit 1  castLabs has a newer stable build in the same major - update now;
 *   exit 0  we are on castLabs' newest, and it says how far upstream is ahead,
 *           which is the Chromium security fixes we are waiting for.
 *
 * Run daily by .github/workflows/electron-watch.yml, which opens an issue when
 * it fails, like tor-watch does for the bundled Tor.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const REPO = 'https://github.com/castlabs/electron-releases';
const pkg = require(path.join(__dirname, '..', 'package.json'));

const parse = (v) => v.split('.').map(Number);
function newer(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

/** "github:castlabs/electron-releases#v44.1.0+wvcus" -> "44.1.0". */
function pinned(spec) {
  const m = /#v(\d+\.\d+\.\d+)\+wvcus$/.exec(spec || '');
  if (!m) throw new Error(`cannot read the castLabs tag from "${spec}"`);
  return m[1];
}

/** Stable castLabs versions, from `git ls-remote --tags` output. */
function castlabsVersions(listing) {
  const found = [...listing.matchAll(/refs\/tags\/v(\d+\.\d+\.\d+)\+wvcus$/gm)].map((m) => m[1]);
  return [...new Set(found)];
}

const latestIn = (versions, major) => versions
  .filter((v) => parse(v)[0] === major)
  .reduce((best, v) => (!best || newer(v, best) ? v : best), null);

async function main() {
  const current = pinned(pkg.devDependencies?.electron || pkg.dependencies?.electron);
  const major = parse(current)[0];
  const tags = castlabsVersions(execFileSync('git', ['ls-remote', '--tags', REPO], { encoding: 'utf8' }));
  const castlabs = latestIn(tags, major);

  const res = await fetch('https://releases.electronjs.org/releases.json');
  if (!res.ok) throw new Error(`releases.json: HTTP ${res.status}`);
  const upstream = (await res.json()).filter((r) => /^\d+\.\d+\.\d+$/.test(r.version));
  const info = (v) => upstream.find((r) => r.version === v);
  const top = info(latestIn(upstream.map((r) => r.version), major));
  const ours = info(current);

  if (castlabs && newer(castlabs, current)) {
    console.log(`Electron is behind: shipping ${current}+wvcus, castLabs has ${castlabs}+wvcus` +
      (info(castlabs) ? ` (Chromium ${info(castlabs).chrome}).` : '.'));
    console.log(`Set "electron" in package.json to github:castlabs/electron-releases#v${castlabs}+wvcus, ` +
      'run `npm install`, and run the smoke suite before merging.');
    process.exit(1);
  }
  // A newer major from castLabs: this line will stop getting Chromium fixes,
  // and watching only it would report "up to date" for good once it does.
  const newestMajor = Math.max(...tags.map((v) => parse(v)[0]));
  if (newestMajor > major) {
    const next = latestIn(tags, newestMajor);
    console.log(`castLabs has moved on to Electron ${newestMajor} (${next}+wvcus), and ${major}.x will stop ` +
      'receiving Chromium security fixes. Plan the move: set "electron" in package.json to ' +
      `github:castlabs/electron-releases#v${next}+wvcus, run \`npm install\`, and run the smoke suite.`);
    process.exit(1);
  }
  console.log(`Electron is on castLabs' newest ${major}.x: ${current}+wvcus` +
    (ours ? `, Chromium ${ours.chrome}.` : '.'));
  if (top && ours && newer(top.version, current)) {
    const days = Math.round((Date.parse(top.date) - Date.parse(ours.date)) / 864e5);
    console.log(`Upstream Electron is at ${top.version} (Chromium ${top.chrome}), ${days} days newer; ` +
      'waiting on castLabs for those Chromium fixes.');
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(`electron-watch: ${err.message}`); process.exit(2); });
}

module.exports = { newer, pinned, castlabsVersions, latestIn };
