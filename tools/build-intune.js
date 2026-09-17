#!/usr/bin/env node
'use strict';

/**
 * Build the Intune variant of the Windows installer.
 *
 * The same browser, differing from the normal installer in exactly two ways,
 * both forced by how the Intune Management Extension works: it runs install
 * commands **as SYSTEM**, so the installer must be per-machine (a per-user
 * install run as SYSTEM lands in SYSTEM's profile, where no real user will find
 * it) and silent (nobody is present to click Next).
 *
 * A generated config rather than `-c.nsis.perMachine=true` on the command line.
 * Those overrides carry `${productName}` in the artifact name, which is
 * electron-builder's template syntax and also bash's, so the same npm script
 * produced a correct name under cmd.exe and a mangled one under any POSIX
 * shell. Writing a config file removes the shell from the question entirely.
 *
 * See build/intune/README.md - and the disclaimer at the top of it. None of
 * this has been run against a real tenant.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const base = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));

// Start from the real configuration so the Intune build cannot drift from the
// normal one: same files, same helpers, same signing setup.
const config = {
  ...base,
  directories: {
    ...base.directories,
    // Its own directory, so this build cannot overwrite dist/latest.yml. That
    // manifest describes the *updatable* build, and a machine-wide install does
    // not update itself - publishing this one's manifest would tell every
    // ordinary install to fetch an installer it cannot run.
    output: 'dist-intune'
  },
  win: {
    ...base.win,
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: '${productName}-${version}-win-${arch}-intune.${ext}'
  },
  nsis: {
    ...base.nsis,
    oneClick: true,                          // silent: no UI for nobody to click
    perMachine: true,                        // SYSTEM installs it for everyone
    allowToChangeInstallationDirectory: false,
    // Still keep the user's data on uninstall, for the same reason as the
    // normal build: settings and saved credentials are theirs, not the
    // installer's, and an uninstall-reinstall cycle during a deployment must
    // not wipe them.
    deleteAppDataOnUninstall: false
  }
};

const file = path.join(os.tmpdir(), `debrowser-intune-${process.pid}.json`);
fs.writeFileSync(file, JSON.stringify(config, null, 2));

try {
  const r = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron-builder', '--win', '--config', file, '--publish', 'never'],
    { stdio: 'inherit', cwd: root }
  );
  process.exit(r.status === null ? 1 : r.status);
} finally {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}
