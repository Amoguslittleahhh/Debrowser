'use strict';

/**
 * End-to-end checks for the features that took Debrowser from a fast browser
 * to one people can move to: sync, filling cards and addresses, translation,
 * dark websites and importing from Safari.
 *
 * One file per feature in ./features/, each exporting `async function (t)`,
 * where `t` is the suite's own kit - `check`, `waitFor`, `pageUrl` and the
 * browser's real parts (below). They run at the end of the full suite, and on
 * their own while working on them:
 *
 *   DEBROWSER_SMOKE_ONLY=features                      all of them
 *   DEBROWSER_SMOKE_ONLY=features DEBROWSER_SMOKE_FEATURE=sync   one
 *
 * A file that throws fails one check named for it rather than the whole run.
 */

const fs = require('fs');
const path = require('path');

async function runFeatures(t) {
  const dir = path.join(__dirname, 'features');
  const only = process.env.DEBROWSER_SMOKE_FEATURE || '';
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  } catch { /* none yet */ }
  for (const file of files) {
    const name = file.slice(0, -3);
    if (only && name !== only) continue;
    console.log(`\nFeature: ${name}\n`);
    try {
      await require(path.join(dir, file))(t);
    } catch (err) {
      t.check(`${name}: its checks ran to the end`, false, (err && err.stack) || String(err));
    }
  }
}

module.exports = { runFeatures };
