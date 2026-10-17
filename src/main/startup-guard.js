'use strict';

/**
 * A way back from an update that will not start.
 *
 * Each start is counted in `startup.json` and cleared once the browser has
 * run for half a minute. A version that fails to get that far twice running
 * is offered, at its next start, the profile as the last version left it
 * (Backups/<version>, store-file.js) and the page to download that version
 * again - asked with the system's own dialog, since the browser's own window
 * is exactly what may not be working.
 */

const fs = require('fs');
const path = require('path');

const FAILED_STARTS = 2;
const STARTED_MS = 30_000;

class StartupGuard {
  constructor(userData, version, log = () => {}) {
    this.file = path.join(userData, 'startup.json');
    this.userData = userData;
    this.version = version;
    this.log = log;
  }

  read() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return s && s.version === this.version && Number.isInteger(s.attempts) ? s : { version: this.version, attempts: 0 };
    } catch {
      return { version: this.version, attempts: 0 };
    }
  }

  write(state) {
    try { fs.writeFileSync(this.file, JSON.stringify(state), { mode: 0o600 }); } catch { /* read-only profile */ }
  }

  /** Count this start. Returns how many starts of this version failed before it. */
  begin() {
    const state = this.read();
    const failed = state.attempts;
    this.write({ version: this.version, attempts: failed + 1 });
    return failed;
  }

  /** Cleared once this run has lasted long enough to call it a start. */
  settle() {
    setTimeout(() => this.clear(), STARTED_MS).unref?.();
  }

  /**
   * Cleared now: a run that reached a clean quit got going, however short.
   * Counting it was what turned two quick "Restart to update"s - an update
   * that then failed to install - into "has not started properly the last 2
   * times", offering to undo an update that had never happened.
   */
  clear() {
    this.write({ version: this.version, attempts: 0 });
  }

  /** The newest backup from another version, if there is one to go back to. */
  backup() {
    const root = path.join(this.userData, 'Backups');
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== this.version && !d.name.endsWith('-before-restore'))
        .map((d) => ({ version: d.name, dir: path.join(root, d.name), at: fs.statSync(path.join(root, d.name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)[0] || null;
    } catch {
      return null;
    }
  }

  /** Put the backup's files back, keeping what is there now beside it first. */
  restore(backup) {
    const now = path.join(this.userData, 'Backups', `${this.version}-before-restore`);
    fs.mkdirSync(now, { recursive: true });
    for (const f of fs.readdirSync(this.userData).filter((n) => n.endsWith('.json') && n !== 'startup.json')) {
      fs.copyFileSync(path.join(this.userData, f), path.join(now, f));
    }
    for (const f of fs.readdirSync(backup.dir).filter((n) => n.endsWith('.json'))) {
      fs.copyFileSync(path.join(backup.dir, f), path.join(this.userData, f));
    }
    this.log('startup', `profile restored from Backups/${backup.version}; the current one kept in ${path.basename(now)}`);
  }

  /** Whether this start should offer the way back. */
  troubled(failed) {
    return failed >= FAILED_STARTS;
  }
}

module.exports = { StartupGuard, FAILED_STARTS };
