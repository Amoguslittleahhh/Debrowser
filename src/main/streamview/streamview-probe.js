'use strict';

/**
 * What the embedded engine offers for DRM, measured from inside it.
 *
 *   --streamview-probe         CI: a local page, the results printed as one
 *                              `STREAMVIEW-PROBE {...}` line (and to the job
 *                              summary), then quit.
 *   --streamview-test[=url]    By hand: opens `url` (Bitmovin's DRM page by
 *                              default) in a streaming view and keeps the
 *                              window open, with the probe's answer in the
 *                              title bar and the engine's inspector open.
 *   --streamview-test=playready
 *                              By hand: Microsoft's own 4K PlayReady test
 *                              content in a small player served from
 *                              loopback, which writes each step - key system,
 *                              licence, key status, frames decoded - on the
 *                              page and the last one in the title bar.
 *
 * Neither touches the profile or starts the browser proper.
 */

const { app, BaseWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StreamView, available } = require('./streamview');

const DEFAULT_TEST_URL = 'https://bitmovin.com/demos/drm';

/** Runs in the page. Starts the checks and leaves the answer in window.__svProbe. */
const PROBE = `(() => {
  if (window.__svProbeStarted) return 'started';
  window.__svProbeStarted = true;
  const video = (codecs) => [{ contentType: 'video/mp4; codecs="' + codecs + '"' }];
  const cases = [
    ['PlayReady', 'com.microsoft.playready.recommendation', ['cenc'], video('avc1.42E01E')],
    ['PlayReady SL3000', 'com.microsoft.playready.recommendation', ['cenc'],
      [{ contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: '3000' }]],
    ['PlayReady SL3000 (key system)', 'com.microsoft.playready.recommendation.3000', ['cenc'], video('avc1.42E01E')],
    ['PlayReady hardware', 'com.microsoft.playready.hardware', ['cenc'], video('avc1.42E01E')],
    ['PlayReady HEVC SL3000', 'com.microsoft.playready.recommendation.3000', ['cenc'], video('hvc1.2.4.L153.B0')],
    ['Widevine', 'com.widevine.alpha', ['cenc'], video('avc1.42E01E')],
    ['FairPlay', 'com.apple.fps', ['sinf', 'skd', 'cenc'], video('avc1.640028')],
    ['FairPlay 3.0', 'com.apple.fps.3_0', ['sinf', 'skd', 'cenc'], video('avc1.640028')],
    ['FairPlay HEVC', 'com.apple.fps', ['sinf', 'skd', 'cenc'], video('hvc1.2.4.L153.B0')]
  ];
  const out = { userAgent: navigator.userAgent, screen: screen.width + 'x' + screen.height,
    hevc: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L153.B0"'),
    eme: typeof navigator.requestMediaKeySystemAccess === 'function', results: {} };
  (async () => {
    for (const [label, ks, init, caps] of cases) {
      if (!out.eme) { out.results[label] = 'no EME'; continue; }
      try {
        const access = await navigator.requestMediaKeySystemAccess(ks, [{ initDataTypes: init, videoCapabilities: caps }]);
        let keys = 'keys ok';
        try { await access.createMediaKeys(); } catch (e) { keys = 'keys ' + e.name; }
        out.results[label] = 'yes (' + keys + ')';
      } catch (e) { out.results[label] = 'no (' + e.name + ')'; }
    }
    window.__svProbe = out;
  })();
  return 'started';
})()`;

function summarise(result) {
  const yes = Object.entries(result.results || {}).filter(([, v]) => v.startsWith('yes')).map(([k]) => k);
  return yes.length ? yes.join(', ') : 'no DRM key systems';
}

async function probe(view) {
  await view.executeScript(PROBE);
  for (let i = 0; i < 60; i++) {
    const result = await view.executeScript('window.__svProbe || null');
    if (result && typeof result === 'object') return result;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { error: 'timed out waiting for the probe' };
}

function run() {
  const argv = process.argv;
  const ci = argv.includes('--streamview-probe');
  const testArg = argv.find((a) => a.startsWith('--streamview-test'));
  if (!ci && !testArg) return false;

  app.whenReady().then(async () => {
    const win = new BaseWindow({ width: 1280, height: 820, title: 'Debrowser streaming view test' });
    if (!available()) {
      const text = `streaming views are not available on ${process.platform}-${process.arch}`;
      console.log(`STREAMVIEW-PROBE ${JSON.stringify({ error: text })}`);
      win.setTitle(text);
      if (ci) app.exit(1);
      return;
    }

    let server = null;
    let url = testArg && testArg.includes('=') ? testArg.slice(testArg.indexOf('=') + 1) : DEFAULT_TEST_URL;
    const playready = !ci && url === 'playready';
    if (playready) {
      // Loopback is a secure context, as EME requires; the page fetches the
      // content and the licence from Microsoft's test servers itself.
      const page = fs.readFileSync(path.join(__dirname, 'streamview-playready.html'));
      server = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(page); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${server.address().port}/`;
    } else if (ci) {
      // Loopback: a secure context, as EME requires, with nothing leaving the machine.
      server = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>probe</title>probe'); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${server.address().port}/`;
    }

    const { width, height } = win.getContentBounds();
    const view = new StreamView(win, {
      url, bounds: { x: 0, y: 0, width, height },
      userDataDir: path.join(ci ? os.tmpdir() : app.getPath('userData'), 'StreamView')
    });
    win.on('resize', () => {
      const b = win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
    });
    view.on('error', (where, code) => console.log(`streamview error: ${where} ${code}`));
    view.on('runtime', (version) => console.log(`streamview runtime: ${version}`));
    view.on('title', (title) => { if (!ci) win.setTitle(`${title} - streaming view test`); });
    // By hand, the inspector comes up with the page: when a player will not
    // play, its console says why - the licence refused, the output not
    // protected, the decoder missing - and that is the thing to report.
    if (!ci) view.once('ready', () => view.openDevTools());
    // The player reports for itself, in the title; the probe would talk over it.
    if (playready) {
      win.on('closed', () => { view.destroy(); if (server) server.close(); app.quit(); });
      return;
    }

    const timeout = setTimeout(() => {
      console.log(`STREAMVIEW-PROBE ${JSON.stringify({ error: 'the engine never became ready' })}`);
      if (ci) app.exit(1);
    }, 60000);

    view.on('navigated', async (_where, ok) => {
      if (view.probed) return;
      view.probed = true;
      clearTimeout(timeout);
      const result = { platform: `${process.platform}-${process.arch}`, loaded: ok, ...(await probe(view)) };
      console.log(`STREAMVIEW-PROBE ${JSON.stringify(result)}`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          `### Streaming view, ${result.platform}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\n`);
      }
      if (ci) {
        view.destroy();
        if (server) server.close();
        // Long enough for the engine's own processes to wind down: left
        // running, they slowed the CI steps after this one.
        setTimeout(() => app.exit(0), 3000);
      } else {
        win.setTitle(`DRM here: ${summarise(result)} - streaming view test`);
      }
    });
    win.on('closed', () => { view.destroy(); app.quit(); });
  });
  return true;
}

module.exports = { run };
