'use strict';

/**
 * Starting incognito, from the normal browser.
 *
 * Incognito is a separate process (see mode.js for why), so opening it is a
 * spawn of this same executable with `--incognito`. If one is already running,
 * the new one loses the profile lock at once and the running one opens a tab
 * instead - so this does not need to know whether incognito is up.
 *
 * Detached and with no pipes: the two processes are independent. Closing the
 * normal browser must not take a private session with it, and a pipe back to a
 * parent that has exited is a write error waiting to happen in the child.
 */

const { spawn } = require('child_process');
const { app } = require('electron');

/**
 * Switches the child inherits because this process could only start with them:
 * `--no-sandbox` for a root container, `--disable-gpu` for a headless one.
 * Nothing else is passed down, so the parent cannot weaken incognito by being
 * started with something unusual.
 */
const INHERITED = ['--no-sandbox', '--disable-gpu'];

function launchIncognito(log = () => {}) {
  const args = [];
  // A development run is `electron <app dir>`; an installed build is the app.
  if (!app.isPackaged) args.push(app.getAppPath());
  args.push('--incognito');
  for (const flag of INHERITED) if (process.argv.includes(flag)) args.push(flag);

  const env = { ...process.env };
  // Never inherited: it turns the binary into a plain Node interpreter.
  delete env.ELECTRON_RUN_AS_NODE;

  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env });
    child.on('error', (err) => log('incognito', `could not start: ${err.message}`));
    child.unref();
    return true;
  } catch (err) {
    log('incognito', `could not start: ${err.message}`);
    return false;
  }
}

module.exports = { launchIncognito };
