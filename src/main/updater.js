'use strict';

/**
 * Updates, downloaded as deltas rather than as the whole browser.
 *
 * A full artifact is about 110MB and almost all of it is Chromium, which does
 * not change between our releases. electron-builder writes a blockmap beside
 * each installer describing its compressed stream in content-defined chunks, so
 * the updater can fetch only the blocks that actually differ and reuse the rest
 * from the copy already installed. The saving is the whole point of this file.
 *
 * What it will never touch is `userData` - preferences, the browsing session,
 * and saved credentials all live there, and an installer replaces the program
 * directory only. That is not something this file arranges; it is a property of
 * where those files were put in the first place (see prefs.js), and this file
 * must not undo it.
 *
 * Deliberately quiet. It checks, it downloads in the background, and it asks
 * before restarting. A browser that restarts itself while you are reading is a
 * browser that lost your tabs.
 */

const { app, dialog } = require('electron');

/**
 * How long after launch the first check happens.
 *
 * Not zero. Startup is the busiest moment the browser has - renderers being
 * created, the first page loading, the governor taking its first samples - and
 * a network request plus a signature check competing with that is felt as a
 * slow start, in exchange for news that would keep perfectly well for a minute.
 */
const FIRST_CHECK_MS = 60_000;

/** And every few hours after that, for a browser left open for days. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

class Updater {
  /**
   * @param {object} deps
   * @param {() => boolean} deps.enabled - reads the user's preference, live
   * @param {(...args: any[]) => void} deps.log
   * @param {() => Electron.BaseWindow|null} deps.window - for the restart prompt
   */
  constructor({ enabled = () => true, log = () => {}, window = () => null }) {
    this.enabled = enabled;
    this.log = log;
    this.window = window;

    this.timer = null;
    this.state = 'idle';       // idle | checking | downloading | ready | error
    this.info = null;          // { version, releaseDate } once one is found
    this.error = null;
    this.progress = 0;
    this.promptOpen = false;

    /** @type {import('electron-updater').AppUpdater|null} */
    this.impl = null;
  }

  /**
   * Whether updating can work at all here, and why not when it cannot.
   *
   * Reported in the same `{available, reason}` shape the trim capability uses,
   * for the same reason: a feature that is silently inert is indistinguishable
   * from one that is broken, and the user cannot tell which they have.
   */
  capability() {
    if (!app.isPackaged) {
      return { available: false, reason: 'running from source - updates apply to installed builds only' };
    }
    if (process.platform === 'darwin') {
      // Squirrel.Mac validates that the update is signed by the same identity
      // as the running app, and refuses outright when there is no identity at
      // all. This is not a missing feature, it is a signing prerequisite, and
      // saying so is better than an updater that fails on every check forever.
      return { available: false, reason: 'macOS updates need a signed app; this build is unsigned' };
    }
    // A machine-wide install cannot update itself, and must not try.
    //
    // Two cases, one test. An Intune or other managed deployment installs into
    // Program Files as SYSTEM: the browser then runs as an ordinary user who
    // cannot write there, so every download would end in an access denial the
    // user can do nothing about. And in a managed estate updates are the
    // administrator's to schedule - an app quietly replacing itself from GitHub
    // is the opposite of what the deployment is for.
    //
    // Asking whether we can write to our own directory answers both without
    // needing a build flag, and stays true if the app is later moved.
    if (!this.canWriteInstallDir()) {
      return {
        available: false,
        reason: 'installed for all users - updates are handled by whoever deployed it'
      };
    }

    if (process.platform === 'linux' && !process.env.APPIMAGE) {
      // .deb and .tar.gz have no in-place update path - the package manager or
      // the user owns those files, not us.
      return { available: false, reason: 'in-app updates work from the AppImage; use your package manager' };
    }
    return { available: true, reason: null };
  }

  /**
   * Can this process write where it is installed?
   *
   * `fs.accessSync(W_OK)` is unreliable on Windows for directories - it reports
   * the read-only *attribute* rather than the ACL - so this actually tries to
   * create a file and remove it again. One syscall pair, once, at startup.
   */
  canWriteInstallDir() {
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(app.getPath('exe'));
    const probe = path.join(dir, `.debrowser-write-test-${process.pid}`);
    try {
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  start() {
    const cap = this.capability();
    if (!cap.available) {
      this.log('updates', `unavailable: ${cap.reason}`);
      return;
    }

    try {
      // Required lazily. It reads app-update.yml at import time in some
      // versions, and a browser that cannot start because of its updater would
      // be a poor trade for a feature nobody asked to be blocking.
      const { autoUpdater } = require('electron-updater');
      this.impl = autoUpdater;
    } catch (err) {
      this.state = 'error';
      this.error = err.message;
      this.log('updates', `could not load the updater: ${err.message}`);
      return;
    }

    // We drive both steps ourselves: download only when the preference allows
    // it, and never install behind the user's back.
    this.impl.autoDownload = false;
    this.impl.autoInstallOnAppQuit = false;
    this.impl.logger = { info: (m) => this.log('updates', m), warn: (m) => this.log('updates', m),
                         error: (m) => this.log('updates', m), debug: () => {} };

    this.wire();

    this.timer = setInterval(() => this.check(), RECHECK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    const first = setTimeout(() => this.check(), FIRST_CHECK_MS);
    if (typeof first.unref === 'function') first.unref();
  }

  wire() {
    const u = this.impl;

    u.on('update-available', (info) => {
      this.state = 'downloading';
      this.info = { version: info.version, releaseDate: info.releaseDate };
      this.log('updates', `${info.version} is available`);
      // Blockmap differential download happens inside this call: it fetches the
      // new blockmap, diffs it against the installed artifact, and requests only
      // the ranges that differ.
      u.downloadUpdate().catch((err) => this.fail(err));
    });

    u.on('update-not-available', () => {
      this.state = 'idle';
      this.log('updates', 'already up to date');
    });

    u.on('download-progress', (p) => {
      this.progress = Math.round(p.percent || 0);
    });

    u.on('update-downloaded', (info) => {
      this.state = 'ready';
      this.progress = 100;
      this.log('updates', `${info.version} downloaded and ready`);
      this.offerRestart(info.version);
    });

    u.on('error', (err) => this.fail(err));
  }

  fail(err) {
    this.state = 'error';
    this.error = err?.message || String(err);
    // Not surfaced as a dialog. A failed update check is our problem, not
    // something to interrupt someone's browsing over - it retries on the next
    // interval, and the panel shows the state for anyone who cares.
    this.log('updates', `failed: ${this.error}`);
  }

  check() {
    if (!this.impl || !this.enabled()) return;
    // Nothing to do while one is already downloading or waiting to install.
    if (this.state === 'downloading' || this.state === 'ready') return;
    this.state = 'checking';
    this.impl.checkForUpdates().catch((err) => this.fail(err));
  }

  /**
   * Ask, then restart. Never the other way round.
   *
   * The installer for this app is assisted rather than one-click, so installing
   * puts the full NSIS UI on screen. Doing that unannounced while someone is
   * reading would be indefensible, and doing it silently at quit would lose the
   * session to a restart they did not choose.
   */
  async offerRestart(version) {
    if (this.promptOpen) return;
    this.promptOpen = true;

    const win = this.window();
    const opts = {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Debrowser ${version} is ready to install.`,
      detail: 'Your settings, open tabs and saved data are kept. The browser will close while it installs.'
    };

    try {
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (response === 0) {
        // `isSilent: false` because this installer shows its own UI anyway;
        // pretending otherwise produces a window the user did not expect with
        // no explanation of what it is.
        this.impl.quitAndInstall(false, true);
      }
    } catch (err) {
      this.log('updates', `could not prompt: ${err.message}`);
    } finally {
      this.promptOpen = false;
    }
  }

  /**
   * For the task manager, in the same shape as the other capability reports.
   *
   * The capability is computed once and kept. It probes whether the install
   * directory is writable by creating and deleting a file in it, and this is
   * called from `BrowserShell.publish` - on every governor tick and every
   * coalesced tab event. A packaged build was writing a probe file into Program
   * Files thirty times a minute, synchronously, on the main thread, against
   * `capability()`'s own comment saying it runs once at startup.
   */
  snapshot() {
    if (!this.cachedCapability) this.cachedCapability = this.capability();
    const cap = this.cachedCapability;
    return {
      available: cap.available,
      reason: cap.reason,
      state: this.state,
      version: this.info?.version || null,
      progress: this.progress,
      error: this.error
    };
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Updater };
