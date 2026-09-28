'use strict';
// One-off probe, run by release.yml with test=eme-probe: which DRM key systems
// castLabs' Electron actually offers a page on this machine. Run as the
// Electron main script; extra Chromium switches come from the command line.
const { app, BrowserWindow, components } = require('electron');
const http = require('http');
const fs = require('fs');

const CASES = [
  ['com.widevine.alpha', 'SW_SECURE_DECODE'],
  ['com.widevine.alpha', 'HW_SECURE_ALL'],
  ['com.microsoft.playready.recommendation', ''],
  ['com.microsoft.playready.recommendation', '3000'],
  ['com.microsoft.playready.recommendation.3000', ''],
  ['com.microsoft.playready', ''],
  ['com.apple.fps', ''],
  ['com.apple.fps.1_0', '']
];

app.whenReady().then(async () => {
  try { await Promise.race([components.whenReady(), new Promise((r) => setTimeout(r, 90000))]); } catch { /* reported below */ }
  const server = http.createServer((_q, r) => r.end('<!doctype html>probe')).listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const win = new BrowserWindow({ show: false });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const results = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    for (const [ks, rob] of ${JSON.stringify(CASES)}) {
      const cap = { contentType: 'video/mp4; codecs="avc1.42E01E"' };
      if (rob) cap.robustness = rob;
      try {
        const a = await navigator.requestMediaKeySystemAccess(ks, [{ initDataTypes: ['cenc'], videoCapabilities: [cap] }]);
        let keys = 'createMediaKeys ok';
        try { await a.createMediaKeys(); } catch (e) { keys = 'createMediaKeys ' + e.name + ': ' + e.message; }
        out.push(ks + ' [' + (rob || 'default') + ']: GRANTED, ' + keys);
      } catch (e) { out.push(ks + ' [' + (rob || 'default') + ']: ' + e.name); }
    }
    return out;
  })()`);
  const flags = process.argv.filter((a) => a.startsWith('--enable-features')).join(' ') || '(no extra switches)';
  const text = `### EME probe, ${process.platform}, ${flags}\n` +
    `components: ${JSON.stringify(components.status())}\n\n` + results.map((r) => `- ${r}`).join('\n') + '\n\n';
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  server.close();
  app.quit();
});
