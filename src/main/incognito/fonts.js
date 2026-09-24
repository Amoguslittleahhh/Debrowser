'use strict';

/**
 * Which fonts a private window can use - on Linux, a fixed few.
 *
 * The set of fonts installed on a computer is one of the most identifying
 * things a page can read about it, and it needs no permission: a script
 * measures text drawn in a font it asks for against text in the fallback,
 * and learns which of hundreds of fonts you have. Office suites, design
 * tools, language packs - each leaves a mark.
 *
 * On Linux, Chromium finds fonts through fontconfig, and fontconfig reads its
 * configuration from the file FONTCONFIG_FILE names. The private window gets
 * a configuration of its own: the system's, followed by a rule that rejects
 * every font and then accepts back only the families below - the ones common
 * Linux installs share (DejaVu, Liberation, Noto; Noto CJK so Chinese,
 * Japanese and Korean pages still render). Anything else installed is simply
 * not there as far as a page can tell.
 *
 * Windows and macOS find fonts through their own system services, which have
 * no such control from outside; there the installed fonts remain readable,
 * and the connection page says so.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ALLOWED = [
  'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono',
  'Liberation Sans', 'Liberation Serif', 'Liberation Mono',
  'Noto Sans', 'Noto Serif', 'Noto Sans Mono', 'Noto Color Emoji',
  'Noto Sans CJK SC', 'Noto Sans CJK TC', 'Noto Sans CJK JP', 'Noto Sans CJK KR',
  'Noto Serif CJK SC', 'Noto Serif CJK TC', 'Noto Serif CJK JP', 'Noto Serif CJK KR'
];

/*
 * The rejection is by pattern - every font is scalable or it is not - rather
 * than the `<glob>*</glob>` the fontconfig manual suggests. Measured with
 * fc-list: a glob of `*` rejected nothing, and `/*` rejected everything,
 * accepted families included, because a glob rejection outranks a pattern
 * acceptance. Pattern against pattern, the acceptance wins.
 */

/** The allowed families this machine actually has. */
function installed() {
  const r = spawnSync('fc-list', [':', 'family'], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return [];
  const have = new Set(r.stdout.split('\n').flatMap((line) => line.split(',')).map((f) => f.trim()));
  return ALLOWED.filter((f) => have.has(f));
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function config(families) {
  const accept = families.map((f) =>
    `      <pattern><patelt name="family"><string>${xml(f)}</string></patelt></pattern>`).join('\n');
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<!-- Debrowser private window: every font rejected, then these accepted back. -->
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <selectfont>
    <rejectfont>
      <pattern><patelt name="scalable"><bool>true</bool></patelt></pattern>
      <pattern><patelt name="scalable"><bool>false</bool></patelt></pattern>
    </rejectfont>
    <acceptfont>
${accept}
    </acceptfont>
  </selectfont>
</fontconfig>
`;
}

/**
 * Write the restricted configuration into `dir` and point `env` at it.
 * Returns `{available, families?, reason?}`, the shape every protection here
 * reports itself in.
 *
 * Called by whoever starts the private browser, on the environment it is
 * given (launch.js; the leak test does the same), because Chromium forks the
 * processes pages run in before any of the browser's own code has run. The
 * configuration holds nothing but family names, so it is written to the
 * ordinary profile, where the private profile's sweep will not remove it.
 */
function restrict(dir, env = process.env) {
  if (process.platform !== 'linux') {
    return { available: false, reason: 'only Linux lets an application choose which installed fonts it sees' };
  }
  const families = installed();
  // With none of them installed, restricting would leave pages with no fonts
  // at all: better to say so than to break every page.
  if (!families.length) return { available: false, reason: 'none of the common font families is installed' };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'incognito-fonts.conf');
  fs.writeFileSync(file, config(families), { mode: 0o600 });
  env.FONTCONFIG_FILE = file;
  return { available: true, families };
}

/**
 * From inside the private browser: whether it was started with the
 * restriction in place. Setting it this late would hide some fonts and not
 * others, which would be worse than saying plainly that it is off.
 */
function status(env = process.env) {
  if (process.platform !== 'linux') {
    return { available: false, reason: 'only Linux lets an application choose which installed fonts it sees' };
  }
  const file = env.FONTCONFIG_FILE;
  if (!file || path.basename(file) !== 'incognito-fonts.conf' || !fs.existsSync(file)) {
    return { available: false, reason: 'this window was not started with the font list (start it from the menu or Ctrl+Shift+N)' };
  }
  const families = [...fs.readFileSync(file, 'utf8').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  return { available: true, families };
}

module.exports = { ALLOWED, restrict, status, config, installed };
