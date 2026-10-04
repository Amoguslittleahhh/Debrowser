'use strict';

/**
 * Compile a filter list away from the browser process (list-worker.js).
 *
 * Resolves with the compiled bytes. Rejects if the helper cannot be started,
 * fails, or takes longer than `timeoutMs` - and the caller then does the work
 * itself, as it always used to: slower to give memory back, but a blocker that
 * still blocks.
 */

const path = require('path');
const { utilityProcess } = require('electron');

const WORKER = path.join(__dirname, 'list-worker.js');

function compileInHelper(kind, payload = {}, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = utilityProcess.fork(WORKER, [], { serviceName: `Debrowser lists (${kind})` });
    } catch (err) {
      reject(err);
      return;
    }
    // Background work by nature, on battery or not: efficiency mode
    // (platform.setEfficiency) from the moment it starts.
    child.once('spawn', () => { if (child.pid) require('./platform').setEfficiency(child.pid, true); });
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`${kind} lists took over ${timeoutMs / 1000}s`)), timeoutMs);
    timer.unref?.();
    child.on('message', (msg) => {
      if (msg && msg.ok && msg.bytes) finish(resolve, Buffer.from(msg.bytes.buffer, msg.bytes.byteOffset, msg.bytes.byteLength));
      else finish(reject, new Error(msg && msg.error || 'no answer'));
    });
    child.on('exit', (code) => finish(reject, new Error(`helper exited (${code})`)));
    child.postMessage({ kind, ...payload });
  });
}

module.exports = { compileInHelper };
