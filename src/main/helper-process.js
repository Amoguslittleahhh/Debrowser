'use strict';

/**
 * A long-lived native helper, spoken to over a line protocol on stdin/stdout.
 *
 * Extracted from the trim helper rather than copied for the second one. Almost
 * none of what follows is obvious, and every non-obvious part is here because
 * something broke:
 *
 *   - Writing to a dead child raises EPIPE as an asynchronous 'error' event on
 *     the stream, not as a throw from `write()`. A try/catch never sees it, and
 *     an unhandled 'error' event is fatal to the *browser*. A helper for an
 *     optimisation taking the whole browser down with it was observed live.
 *   - An 'error' on the child itself is a different animal from a broken pipe:
 *     it means the process could not be spawned at all, and Node does not
 *     promise an 'exit' afterwards - so nothing else would ever record a reason
 *     and the restart path would spin on a binary that cannot run.
 *   - "The helper is gone" cannot be inferred after the fact by looking at
 *     `this.child`. The exit handler nulls it, resolves the pending request -
 *     which only *queues* the continuation - and then synchronously restarts,
 *     so by the time the caller resumes, `this.child` is live again and a crash
 *     looks like a per-pid timeout. Hence a sentinel that no reply can be.
 *   - The handles are referenced only while a request is outstanding. Left
 *     referenced, the helper keeps the browser from exiting; left unreferenced,
 *     the event loop can exit before a reply arrives and the request simply
 *     never resolves.
 *
 * Subclasses supply what the helper *is*: its binary, what a reply is about,
 * and whether this platform can run it at all.
 */

const fs = require('fs');
const { spawn } = require('child_process');

/**
 * Resolution meaning "there is no helper", as distinct from "the helper did not
 * answer in time". The difference decides whether a failure is charged to the
 * request that happened to be in flight. Not a string any reply can be.
 */
const HELPER_GONE = '\u0000helper-gone';

class HelperProcess {
  /**
   * @param {object} spec
   * @param {string} spec.name      - for log lines
   * @param {string} spec.binary    - absolute path
   * @param {number} spec.timeoutMs
   * @param {(line: string) => string} spec.replyId - what a line is *about*
   * @param {() => string|null} spec.precondition - a reason this cannot run, or null
   * @param {(binary: string) => string} spec.missingHint - message when the binary is absent
   */
  constructor({ name, binary, timeoutMs, replyId, precondition = () => null, missingHint, log = () => {} }) {
    this.name = name;
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.replyId = replyId;
    this.precondition = precondition;
    this.missingHint = missingHint;
    this.log = log;

    this.child = null;
    this.pending = null;      // { id, resolve, timer } - one request at a time
    this.queue = [];
    this.restarts = 0;
    this.stopped = false;
    /** Null until something has gone wrong; then a named, permanent reason. */
    this.reason = null;
  }

  /**
   * Start the helper, once. Deliberately long-lived: a process spawn per call
   * would cost more than the call saves, and these are made on a tick.
   */
  start() {
    if (this.child || this.reason || this.stopped) return Boolean(this.child);

    const blocked = this.precondition();
    if (blocked) { this.reason = blocked; return false; }

    if (!fs.existsSync(this.binary)) {
      this.reason = this.missingHint(this.binary);
      return false;
    }

    try {
      this.child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      this.reason = `could not start helper: ${err.message}`;
      return false;
    }

    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        // Every reply names what it answers, so a line that does not name the
        // outstanding request is the late answer to one that already timed out.
        // Dropping it on that basis is what stops a stale result for A being
        // handed to the caller waiting on B. A timed-out request is never
        // cancelled: the helper is inside a syscall and answers eventually.
        if (!this.pending || this.replyId(line) !== this.pending.id) continue;
        this.settle(line);
      }
    });

    const pipeFailed = (err) => {
      this.log(`${this.name} pipe error: ${err.message}`);
      this.settle(HELPER_GONE);
    };
    this.child.stdin.on('error', pipeFailed);
    this.child.stdout.on('error', pipeFailed);

    this.child.on('error', (err) => {
      this.reason = `could not start helper: ${err.message}`;
      this.child = null;
      this.settle(HELPER_GONE);
    });

    // The exit code and signal are carried into the log and into the permanent
    // reason. Without them a helper that dies on startup reports only "exited
    // repeatedly", which says that it died and nothing about why - and the
    // difference between a non-zero exit, a signal and a clean exit on EOF is
    // most of the diagnosis.
    this.child.on('exit', (code, signal) => {
      const how = signal ? `signal ${signal}` : `code ${code}`;
      this.child = null;
      this.settle(HELPER_GONE);
      if (this.stopped) return;      // we asked it to go
      if (this.restarts++ === 0) {
        this.log(`${this.name} helper exited (${how}); restarting once`);
        this.start();
      } else {
        this.reason = `helper exited repeatedly (${how})`;
        this.log(`${this.name} ${this.reason}`);
      }
    });

    this.child.unref();
    this.release();
    return true;
  }

  /**
   * Shut the helper down. Called on quit; safe when not running.
   *
   * The flag is the point: killing the child fires `exit`, whose job is to
   * bring a crashed helper back. Without it, shutting down spawns a fresh
   * helper on the way out of the browser.
   */
  stop() {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
      child.kill();
    } catch { /* already gone */ }
  }

  /** Keep the event loop alive while waiting for a reply. */
  hold() {
    if (!this.child) return;
    this.child.stdout.ref();
    this.child.stdin.ref();
  }

  /** Stop holding it once nothing is outstanding. */
  release() {
    if (!this.child || this.pending || this.queue.length) return;
    this.child.stdout.unref();
    this.child.stdin.unref();
  }

  settle(line) {
    const waiting = this.pending;
    this.pending = null;
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.resolve(line);
    }
    const next = this.queue.shift();
    if (next) this.send(next.command, next.resolve);
    else this.release();
  }

  send(command, resolve) {
    if (!this.start()) {
      // Everything already queued behind this one is waiting on a helper that
      // is not coming. Resolving only the caller in hand leaves those promises
      // unsettled forever, and any caller that gates on "a round is in flight"
      // never runs another - measurement silently stopped for the life of the
      // process, with nothing logged and nothing to see.
      resolve(HELPER_GONE);
      const stranded = this.queue.splice(0, this.queue.length);
      for (const item of stranded) item.resolve(HELPER_GONE);
      return undefined;
    }
    if (this.pending) {
      this.queue.push({ command, resolve });
      return undefined;
    }
    const timer = setTimeout(() => {
      // A wedged helper must never stall the caller. Giving up does not cancel
      // the request; the stdout handler drops the late reply when it arrives,
      // because it will not name the request outstanding by then.
      this.log(`${this.name} timed out on "${command}"`);
      this.settle(null);
    }, this.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.pending = { id: this.replyId(command), resolve, timer };
    this.hold();
    try {
      this.child.stdin.write(`${command}\n`);
    } catch {
      this.settle(HELPER_GONE);
    }
    return undefined;
  }

  request(command) {
    return new Promise((resolve) => this.send(command, resolve));
  }
}

module.exports = { HelperProcess, HELPER_GONE };
