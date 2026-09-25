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

const { app } = require('electron');

/**
 * How long after launch the first check happens.
 *
 * Not zero. Startup is the busiest moment the browser has - renderers being
 * created, the first page loading, the governor taking its first samples - and
 * a network request plus a signature check competing with that is felt as a
 * slow start, in exchange for news that would keep perfectly well for a minute.
 */
const FIRST_CHECK_MS = 60_000;

/**
 * The least time between two checks the browser makes on its own.
 *
 * There is no interval any more. It used to re-check every six hours, which is
 * a browser reaching out to GitHub on its own schedule for the life of a window
 * left open for days - and nobody asked it to. It checks when the browser
 * starts, when you look at the Updates section in Settings, and when you press
 * the button. This floor is what keeps the second of those from being a request
 * per scroll.
 *
 * The button is not subject to it: pressing Check now means check now.
 */
const MIN_AUTO_INTERVAL_MS = 10 * 60 * 1000;

class Updater {
  /**
   * @param {object} deps
   * @param {() => boolean} deps.enabled - reads the user's preference, live
   * @param {(...args: any[]) => void} deps.log
   * @param {(version: string) => void} deps.onReady - called once an update is
   *   downloaded and waiting. The browser draws its own prompt for this; see
   *   `update.html`. It used to be `dialog.showMessageBox`, which is a Win32
   *   dialog in the middle of a browser that draws everything else itself -
   *   light-themed on a dark window, in a different typeface, with the system's
   *   own buttons.
   */
  constructor({ enabled = () => true, log = () => {}, onReady = () => {} }) {
    this.enabled = enabled;
    this.log = log;
    this.onReady = onReady;
    /** When the last check actually started, for MIN_AUTO_INTERVAL_MS. */
    this.lastCheckAt = 0;

    this.timer = null;

    /**
     * unchecked | idle | checking | available | downloading | ready | error
     *
     * `unchecked` and `idle` are deliberately different states. Both mean "no
     * update is in flight", but the first means we have never asked and the
     * second means we asked and there was nothing - and the first minute of
     * every launch is spent in `unchecked`, because the first check is delayed
     * to keep a network request off the busiest moment the browser has.
     *
     * Collapsing them is what made Settings say "Up to date." before it had
     * asked anything, which is the one thing a version indicator must not do.
     */
    this.state = 'unchecked';
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
      return { available: false, reason: 'running from source – updates apply to installed builds only' };
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
        reason: 'installed for all users – updates are handled by whoever deployed it'
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

    // Once, shortly after launch. Nothing periodic: see MIN_AUTO_INTERVAL_MS.
    this.timer = setTimeout(() => this.check(), FIRST_CHECK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  wire() {
    const u = this.impl;

    u.on('update-available', (info) => {
      this.info = { version: info.version, releaseDate: info.releaseDate };
      this.log('updates', `${info.version} is available`);

      // Found one, but only download it if the user asked us to.
      //
      // Reachable with the preference off because "Check now" ignores it: being
      // able to ask is not the same as agreeing to a hundred megabytes arriving
      // unannounced, and someone who turned automatic updates off and then went
      // looking wants the answer, not the download.
      if (!this.enabled()) {
        this.state = 'available';
        return;
      }

      this.state = 'downloading';
      // Blockmap differential download happens inside this call: it fetches the
      // new blockmap, diffs it against the installed artifact, and requests only
      // the ranges that differ.
      u.downloadUpdate().catch((err) => this.fail(err));
    });

    u.on('update-not-available', () => {
      this.state = 'idle';
      this.info = null;
      this.error = null;
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

  /**
   * @param {boolean} manual - true when the user pressed the button, which is
   *   the one case that ignores the preference. Turning automatic updates off
   *   means the browser stops checking on its own, not that it refuses to
   *   answer when asked.
   */
  check(manual = false) {
    if (!this.impl) return;
    if (!manual && !this.enabled()) return;
    // Nothing to do while one is already downloading or waiting to install.
    if (this.state === 'downloading' || this.state === 'ready') return;
    // Looking at the Updates section asks for a check, and looking at it twice
    // in a minute is still one question.
    if (!manual && Date.now() - this.lastCheckAt < MIN_AUTO_INTERVAL_MS) return;
    this.lastCheckAt = Date.now();
    this.state = 'checking';
    this.error = null;
    this.impl.checkForUpdates().catch((err) => this.fail(err));
  }

  /**
   * "Check now", from Settings.
   *
   * Returns the state the button should draw immediately rather than leaving
   * the page to wait for the next broadcast - a button that does nothing
   * visible for half a second is a button people press twice.
   *
   * @param {boolean} manual - false for the Updates section coming into view,
   *   which is an automatic check: it must respect the preference and the rate
   *   limit, or merely scrolling Settings reaches GitHub with updates off.
   */
  checkNow(manual = true) {
    this.check(manual);
    return this.snapshot();
  }

  /**
   * Ask, then restart. Never the other way round.
   *
   * The installer for this app is assisted rather than one-click, so installing
   * puts the full NSIS UI on screen. Doing that unannounced while someone is
   * reading would be indefensible, and doing it silently at quit would lose the
   * session to a restart they did not choose.
   */
  offerRestart(version) {
    if (this.promptOpen) return;
    this.promptOpen = true;
    try {
      this.onReady(version);
    } catch (err) {
      this.log('updates', `could not prompt: ${err.message}`);
      this.promptOpen = false;
    }
  }

  /**
   * Restart into the new version, from the browser's own prompt.
   *
   * Silently, which reverses an earlier call. The reasoning then was that the
   * installer shows its own UI anyway, so pretending otherwise would produce a
   * window the user did not expect - and that was right while the prompt came
   * from the system and could be mistaken for something else. It is not right
   * now: the user has been asked, in the browser's own prompt, and pressed
   * Restart now. Putting the full NSIS wizard in front of someone who already
   * answered that question is asking it twice.
   *
   * It also skips the part that looks broken. Pressing Finish on that wizard
   * leaves it titled "Not Responding" for a few seconds while NSIS deletes the
   * couple of hundred megabytes it extracted to a temp directory - that is the
   * installer's own cleanup, on its own UI thread, and nothing in this browser
   * can hurry it. An update that never shows the wizard never reaches it.
   *
   * The second argument keeps "run after installing", so Restart now still
   * means restart rather than quit. A first install from a downloaded .exe is
   * unaffected: that one is the wizard, and it is meant to be.
   */
  install() {
    if (!this.impl || this.state !== 'ready') return false;
    try {
      this.impl.quitAndInstall(true, true);
      return true;
    } catch (err) {
      this.log('updates', `could not install: ${err.message}`);
      return false;
    }
  }

  /** The prompt was dismissed. It comes back on the next launch. */
  dismissPrompt() {
    this.promptOpen = false;
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
    clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { Updater };
