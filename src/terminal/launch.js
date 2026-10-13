'use strict';

const fs = require('fs');
const path = require('path');

/**
 * `debrowser --terminal`, before anything else in main.js runs.
 *
 * Chromium picks its display platform from the command line as it starts,
 * long before app.commandLine.appendSwitch could say anything, and with no
 * display it gives up. So the first time through, this process replaces
 * itself - same process, so an AppImage's mount stays - with one started on
 * the headless platform, which needs no display at all, and the second time
 * through it runs the terminal browser (index.js).
 *
 * The replacing is done by sh, to send Chromium's log lines to
 * Debrowser/Terminal/terminal.log in the config folder rather than the
 * terminal, where they would be drawn over the page.
 *
 * Returns true when it has taken over, and main.js stops there.
 */
function launch(argv = process.argv) {
  if (!argv.includes('--terminal')) return false;
  if (process.platform !== 'linux' || argv.includes('--ozone-platform=headless') || typeof process.execve !== 'function') {
    require('./index').run(argv);
    return true;
  }
  const { app } = require('electron');
  const dir = path.join(app.getPath('appData'), 'Debrowser', 'Terminal');
  let log = '/dev/null';
  try { fs.mkdirSync(dir, { recursive: true }); log = path.join(dir, 'terminal.log'); } catch { /* no log, then */ }
  // Electron set CHROME_DESKTOP in this process as it started, and inherited
  // it stops the next one starting its GPU helper; ELECTRON_RUN_AS_NODE would
  // make it Node. The private window drops the same (incognito/launch.js,
  // childEnv - not required here, for all it would load).
  const env = { ...process.env, DEBROWSER_TERMINAL_LOG: log };
  delete env.CHROME_DESKTOP;
  delete env.ELECTRON_RUN_AS_NODE;
  process.execve('/bin/sh', ['sh', '-c', 'exec "$@" 2>"$DEBROWSER_TERMINAL_LOG"', 'sh',
    process.execPath, ...argv.slice(1), '--ozone-platform=headless'], env);
  return true;
}

module.exports = { launch };
