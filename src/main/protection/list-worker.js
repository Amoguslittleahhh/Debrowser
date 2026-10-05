'use strict';

/**
 * Compiles a filter list, in a utility process of its own (list-helper.js).
 *
 * Fetching and parsing the lists is the most memory the browser process ever
 * asks for at once - the ad and tracker lists are two hundred thousand rules,
 * and parsing them took it 170MB higher for a second, of which 25MB was still
 * held half a minute later; the dangerous-site lists, 65MB, nearly all still
 * held. Here it is a process that exits when it is done, and the browser gets
 * back only the compiled bytes: the 8MB it keeps either way.
 *
 * One job per process: { kind: 'blocker', urls } - or `rules`, a list given
 * as text, which is how the tests run it - or { kind: 'threats' }.
 * Replies { ok: true, bytes } or { ok: false, error }, then the parent kills it.
 */

const { net } = require('electron');

const jobs = {
  async blocker({ urls, rules }) {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    if (typeof rules === 'string') return ElectronBlocker.parse(rules, { loadCosmeticFilters: true }).serialize();
    // Chromium's network stack, as in the browser: it follows the system's proxy.
    const engine = await ElectronBlocker.fromLists((url, init) => net.fetch(url, init), urls,
      { loadCosmeticFilters: true });
    return engine.serialize();
  },
  async threats() {
    const { compileThreats } = require('./threats');
    return compileThreats();
  }
};

process.parentPort.once('message', async ({ data }) => {
  try {
    const job = jobs[data && data.kind];
    if (!job) throw new Error(`no such list: ${data && data.kind}`);
    const bytes = await job(data);
    process.parentPort.postMessage({ ok: true, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  } catch (err) {
    process.parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
  }
});
