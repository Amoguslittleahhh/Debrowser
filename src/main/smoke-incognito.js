'use strict';

/**
 * The incognito half of the leak test.
 *
 * Run inside an incognito process by `test/incognito-leak.js`, which owns
 * everything that has to be true *outside* the browser: the stand-in for Tor
 * that records every name it is asked for, the network namespace that leaves
 * nowhere else to go, and the checks on the profile directory after exit. This
 * file does the browsing - pages, a favicon, a download, WebRTC, DevTools, a
 * stretch of doing nothing - while Chromium's own network log records every
 * socket, and then deliberately leaks, twice, to prove the detectors fire.
 *
 * It reports a single `__LEAK__{...}` line; the harness decides pass or fail,
 * because half of what decides it is not visible from in here.
 */

const net = require('net');
const path = require('path');
const { session, netLog } = require('electron');

// A private tab loads a blank page first, for its fingerprint overrides to go
// on, so "not loading" alone can be true before the real page has started:
// every wait below also names the page it is waiting for.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argValue = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

async function waitFor(predicate, timeoutMs = 10_000, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(pollMs);
  }
  return false;
}

/** Resolve with the value, or with `fallback` after `ms`. */
const within = (promise, ms, fallback) =>
  Promise.race([promise.catch(() => fallback), sleep(ms).then(() => fallback)]);

async function run({ app, tabs, shell, downloads, tripwire, circuits, camouflage, runCommand, ctx, log, setTripHook }) {
  const fixturePort = Number(argValue('leak-fixture-port'));
  const canary = argValue('leak-canary');            // ip:port the harness listens on
  const stun = argValue('leak-stun');                // ip:port for WebRTC's STUN
  const dir = argValue('leak-netlog-dir');
  const idleMs = Number(argValue('leak-idle-ms')) || 3000;
  const report = { proxyPort: ctx.proxyPort, steps: {}, errors: [] };
  const step = (name, value) => { report.steps[name] = value; log('leak', `${name}: ${JSON.stringify(value)}`); };

  const trips = [];
  setTripHook((violations) => trips.push({ at: Date.now(), violations }));

  await netLog.startLogging(path.join(dir, 'clean.json'), { captureMode: 'default' });

  // Kept ready (the harness starts it that way): built, hidden, and shown by
  // the next Ctrl+Shift+N - which reaches this process as a second instance.
  if (process.argv.includes('--warm')) {
    const before = { held: shell.held, visible: shell.window.isVisible() };
    app.emit('second-instance');
    await sleep(500);
    step('warm', { before, after: { held: shell.held, visible: shell.window.isVisible() } });
  }

  step('tripwire', await tripwire.capability());
  step('killSwitch', ctx.killSwitch);

  // --- Ordinary browsing, every kind of request the browser makes ---------
  const url = (host, page) => `http://${host}.test:${fixturePort}/${page}`;
  // The fixtures are plain HTTP. Incognito upgrades navigations to HTTPS and
  // asks before falling back, so the test says yes for these hosts the same
  // way the user does - through the policy's own switch, not a test backdoor.
  // `up.test` is left out on purpose: it is the one that must be upgraded.
  const policy = require('./incognito/policy');
  for (const host of ['t1', 't2', 'rtc', 'lan', 'link', 'nc', 'ch', 'chx', 'fp', 'fp2', 'fpx', 'up2', 'ref', 'img.ref', 'other', 'cam1', 'cam2', 'cam3', 'decoy']) policy.allowHttp(url(host, ''));
  const loaded = [];
  const byHost = {};
  for (const host of ['t1', 't2']) {
    const tab = tabs.create({ url: url(host, 'idle.html') });
    const ok = await waitFor(() => tab.isLive && !tab.loading && /idle/.test(tab.url), 15_000);
    loaded.push({ host, ok, title: tab.title });
    byHost[host] = tab;
  }
  step('pages', loaded);

  // Circuits. A link opened from t1 shares t1's partition and circuit; then
  // t1 is moved to a new circuit and loads another page there. Where each of
  // these arrived is read from the stand-in for Tor, by the harness.
  const linked = tabs.create({ url: url('link', 'idle.html'), opener: byHost.t1, activate: false, realise: true });
  await waitFor(() => linked.isLive && !linked.loading && /idle/.test(linked.url), 15_000);
  if (circuits) circuits.newCircuit(byHost.t1.session);
  await byHost.t1.wc.loadURL(url('nc', 'idle.html')).catch(() => {});
  step('circuits', {
    separateSessions: byHost.t1.session !== byHost.t2.session,
    linkShares: linked.session === byHost.t1.session
  });

  // The favicon route. It runs in the browser process with its own fetch, in
  // the default session - the path a naive design leaves outside the proxy.
  const icon = await within(
    // Its own host name, so the proxy's log says whether *this* fetch arrived -
    // a page on t1.test asks for t1.test's favicon itself, and a check keyed on
    // t1.test passed against a build where this route bypassed the proxy.
    session.defaultSession.fetch(`debrowser://icon?url=${encodeURIComponent(url('icon', 'favicon.ico'))}`)
      .then((res) => res.status), 8000, 'timeout');
  step('favicon', icon);

  // The download manager: its own requests, several ranges, its own session.
  const before = downloads.list ? downloads.list().length : 0;
  downloads.start(url('dl', 'icon.svg'));
  const finished = await waitFor(() => {
    const items = downloads.list ? downloads.list() : [];
    return items.length > before && ['done', 'failed'].includes(items[0].state);
  }, 15_000);
  // Newest first.
  const last = downloads.list ? downloads.list()[0] : null;
  // Where it went: the private downloads folder, not the ordinary one.
  const item = downloads.items ? [...downloads.items.values()].pop() : null;
  step('download', {
    finished, state: last?.state || null, error: last?.error || null,
    folder: item && item.file ? path.basename(path.dirname(item.file)) : null
  });

  // WebRTC, pointed at a STUN server. Nothing may be gathered that names this
  // machine, and nothing may reach the STUN server at all.
  const rtcTab = tabs.create({ url: `${url('rtc', 'webrtc.html')}?stun=${stun}` });
  await waitFor(() => rtcTab.isLive && !rtcTab.loading && /webrtc/.test(rtcTab.url), 15_000);
  const candidates = rtcTab.isLive
    ? await within(rtcTab.wc.executeJavaScript('window.__candidates'), 8000, ['timeout'])
    : ['not-loaded'];
  step('webrtc', candidates);

  // DevTools, which has its own network needs.
  const active = tabs.activeTab();
  if (active?.isLive) {
    active.wc.openDevTools({ mode: 'detach' });
    await sleep(1500);
    active.wc.closeDevTools();
  }
  step('devtools', Boolean(active?.isLive));

  // --- The request policy ---------------------------------------------------
  //
  // A page asking for this machine or this network gets nothing - not the
  // proxy's own port, not a router, not a `.local` name.
  const lanTab = tabs.create({ url: url('lan', 'idle.html') });
  await waitFor(() => lanTab.isLive && !lanTab.loading && /idle/.test(lanTab.url), 15_000);
  const local = lanTab.isLive ? await within(lanTab.wc.executeJavaScript(`Promise.all(${JSON.stringify([
    `http://127.0.0.1:${ctx.proxyPort}/`, 'http://192.168.1.1/', 'http://printer.local/', 'http://[::1]/'
  ])}.map((u) => fetch(u, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')))`), 8000, ['timeout']) : ['not-loaded'];
  step('localNetwork', local);

  // Plain HTTP is upgraded; when HTTPS is not there, the tab explains.
  const upTab = tabs.create({ url: url('up', 'idle.html') });
  const explained = await waitFor(() => upTab.isLive && /^debrowser:\/\/insecure/.test(upTab.wc.getURL()), 15_000);
  step('httpsOnly', { explained, url: upTab.isLive ? upTab.wc.getURL() : null });

  // A site that refuses Tor exits: the tab moves to another circuit and loads
  // again. `ch` lets the third attempt through; `chx` never does, and the tab
  // must stop retrying and say so. Which ports the attempts arrived on is read
  // from the stand-in for Tor, by the harness.
  const chTab = tabs.create({ url: `http://ch.test:${fixturePort}/challenge?id=ch` });
  const passed = await waitFor(() => chTab.isLive && !chTab.loading && chTab.title === 'passed', 20_000);
  const chxTab = tabs.create({ url: `http://chx.test:${fixturePort}/challenge?id=chx&always=1` });
  const refused = await waitFor(() => circuits && circuits.refused(chxTab.id), 30_000);
  step('blocked', { passed, title: chTab.title, refused, shown: shell.incognito().refused === true });

  // Fingerprint. What a site reads - from the page, a dedicated worker and a
  // shared worker, and from the request headers - against what every private
  // window should say; the page's size against the letterbox steps; and the
  // startup self-check's own answer.
  const fp = require('./incognito/fingerprint');
  const fpTab = tabs.create({ url: url('fp', 'idle.html') });
  await waitFor(() => fpTab.isLive && !fpTab.loading && /idle/.test(fpTab.url), 15_000);
  const READ = `(async () => {
    const d = self.navigator.userAgentData;
    // userAgentData exists only in secure contexts; these fixtures are plain
    // HTTP, so it is absent here - the self-check reads it where it exists.
    return { ua: navigator.userAgent, brands: d ? d.brands.map((b) => b.brand + '/' + b.version).join(',') : null,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale,
      langs: navigator.languages.join(','), cores: navigator.hardwareConcurrency,
      sharedWorker: typeof SharedWorker !== 'undefined' };
  })()`;
  // A canvas and an offline-audio fingerprint, the way tracking scripts take
  // them: the same drawing, hashed.
  const PRINTS = `(async () => {
    const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
    const c = document.createElement('canvas'); c.width = 220; c.height = 40;
    const x = c.getContext('2d'); x.fillStyle = '#f60'; x.fillRect(10, 5, 100, 30);
    x.font = '16px sans-serif'; x.fillStyle = '#069'; x.fillText('Cwm fjordbank glyphs', 4, 24);
    const ac = new OfflineAudioContext(1, 5000, 44100); const o = ac.createOscillator(); o.type = 'triangle';
    o.frequency.value = 1000; const k = ac.createDynamicsCompressor(); o.connect(k); k.connect(ac.destination); o.start();
    const buf = await ac.startRendering(); let sum = 0; for (const v of buf.getChannelData(0)) sum += Math.abs(v);
    return { canvas: hash(c.toDataURL()), audio: sum.toFixed(12) };
  })()`;
  const surfaces = fpTab.isLive ? await within(fpTab.wc.executeJavaScript(`(async () => {
    const blob = (src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const page = await ${READ};
    const dedicated = await new Promise((r) => { const w = new Worker(blob('(' + ${JSON.stringify(READ)} + ').then(postMessage)')); w.onmessage = (e) => r(e.data); });
    // A frame from another site, in a process of its own: covered like its page.
    const f = document.createElement('iframe'); f.src = 'http://fpx.test:' + location.port + '/probe-frame.html';
    document.body.appendChild(f);
    const frame = await new Promise((r) => {
      onmessage = (e) => r(e.data);
      const t = setInterval(() => f.contentWindow && f.contentWindow.postMessage('go', '*'), 200);
      setTimeout(() => { clearInterval(t); r(null); }, 6000);
    });
    const headers = await fetch('/headers').then((res) => res.json());
    return { page, dedicated, frame, headers, prints: [await ${PRINTS}, await ${PRINTS}],
      screen: screen.width + 'x' + screen.height, viewport: innerWidth + 'x' + innerHeight,
      webgl: Boolean(document.createElement('canvas').getContext('webgl')) };
  })()`), 10_000, null) : null;
  // The same fingerprint from another tab must differ: it cannot link the two.
  const fp2 = tabs.create({ url: url('fp2', 'idle.html') });
  await waitFor(() => fp2.isLive && !fp2.loading && /idle/.test(fp2.url), 15_000);
  const otherTabPrint = fp2.isLive ? await within(fp2.wc.executeJavaScript(PRINTS), 8000, null) : null;
  const audited = await waitFor(() => shell.incognito().fingerprint, 15_000);
  // Take the debugger away, the way the user's DevTools could: the overrides
  // must come back by themselves. Judged by the screen, the one override the
  // process environment does not also provide (TZ and the locale are set for
  // the whole process, so they would read right either way).
  let afterDetach = null;
  if (fpTab.isLive) {
    try { fpTab.wc.debugger.detach(); } catch { /* not attached: that is its own failure, seen below */ }
    await sleep(500);
    fpTab.wc.reload();
    await waitFor(() => !fpTab.loading, 10_000);
    afterDetach = await within(fpTab.wc.executeJavaScript(
      '({ screen: screen.width + "x" + screen.height, viewport: innerWidth + "x" + innerHeight })'), 5000, null);
  }
  const bounds = fpTab.bounds || {};
  step('fingerprint', {
    expected: fp.expected(), surfaces,
    bounds: { width: bounds.width, height: bounds.height },
    audit: audited ? shell.incognito().fingerprint : null,
    afterDetach, reattached: fpTab.isLive && fpTab.wc.debugger.isAttached(), otherTabPrint
  });

  // Uploads. A photo carrying GPS coordinates, picked for a file input: the
  // page must receive it without them, and with exactly the same pixels.
  const { nativeImage } = require('electron');
  const sanitise = require('./incognito/sanitise');
  const px = Buffer.alloc(64 * 48 * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = i & 255; px[i + 1] = (i >> 8) & 255; px[i + 2] = 128; px[i + 3] = 255; }
  const jpeg = nativeImage.createFromBitmap(px, { width: 64, height: 48 }).toJPEG(90);
  const exifBody = Buffer.from('Exif\0\0MM\0*GPSLatitude 35.6895N GPSLongitude 139.6917E', 'latin1');
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(exifBody.length + 2, 2);
  const photo = Buffer.concat([jpeg.subarray(0, 2), app1, exifBody, jpeg.subarray(2)]);
  const photoPath = path.join(dir, 'holiday.jpg');
  require('fs').writeFileSync(photoPath, photo);
  process.env.DEBROWSER_TEST_UPLOAD = photoPath;
  const upTab2 = tabs.create({ url: url('up2', 'upload.html') });
  await waitFor(() => upTab2.isLive && !upTab2.loading && /upload/.test(upTab2.url), 15_000);
  let upload = null;
  if (upTab2.isLive) {
    // A click the page could not have made itself: file inputs need a gesture.
    await upTab2.wc.executeJavaScript("document.getElementById('f').click()", true).catch(() => {});
    await waitFor(() => upTab2.wc.executeJavaScript('Boolean(window.__upload)').catch(() => false), 8000);
    upload = await upTab2.wc.executeJavaScript('window.__upload').catch(() => null);
  }
  delete process.env.DEBROWSER_TEST_UPLOAD;
  const received = upload && upload.base64 ? Buffer.from(upload.base64, 'base64') : null;
  step('upload', {
    name: upload && upload.name,
    sentHadGps: photo.includes('GPS'),
    receivedHasGps: upload ? upload.gps : null,
    samePixels: received ? nativeImage.createFromBuffer(received).toBitmap()
      .equals(nativeImage.createFromBuffer(photo).toBitmap()) : false,
    exactlyTheCleanCopy: received ? received.equals(sanitise.stripImage(photo).data) : false
  });

  // A PDF carrying JavaScript, a form, a remote link and its author: the safe
  // copy must keep the pages and nothing else. Anything the document tried to
  // reach would show up at the stand-in for Tor as a name outside `.test`.
  const pdfBefore = downloads.list().length;
  downloads.start(url('dl', 'tracked.pdf'));
  await waitFor(() => downloads.list().length > pdfBefore && ['done', 'failed'].includes(downloads.list()[0].state), 15_000);
  const pdfItem = [...downloads.items.values()].pop();
  let safeCopy = { error: 'not downloaded' };
  if (pdfItem && pdfItem.state === 'done') {
    const sanitiser = require('./incognito/sanitise');
    const out = sanitiser.safeCopyName(pdfItem.file);
    const started = Date.now();
    try {
      const pages = await sanitiser.flattenPdf(require('electron'), pdfItem.file, out, log);
      const text = require('fs').readFileSync(out).toString('latin1');
      const original = require('fs').readFileSync(pdfItem.file).toString('latin1');
      safeCopy = {
        pages, ms: Date.now() - started, name: path.basename(out),
        originalHad: { js: /\/JavaScript/.test(original), form: /AcroForm/.test(original), uri: /\/URI/.test(original), author: /Alice/.test(original) },
        copyHas: { js: /\/JavaScript|\/JS\b/.test(text), form: /AcroForm|\/Widget/.test(text), uri: /\/URI|tracker/.test(text), author: /Alice|Secret Corp/.test(text) }
      };
    } catch (err) {
      safeCopy = { error: err.message };
    }
  }
  step('safeCopy', safeCopy);

  // A certificate nobody vouches for: the page must not show, and nothing on
  // the screen may offer to show it anyway.
  const tlsPort = Number(argValue('leak-tls-port'));
  let badCertificate = { error: 'no HTTPS fixture' };
  if (tlsPort) {
    const tlsTab = tabs.create({ url: 'about:blank' });
    await waitFor(() => tlsTab.isLive && !tlsTab.loading, 10_000);
    let failure = null;
    tlsTab.wc.once('did-fail-load', (_e, code, description) => { failure = `${description} (${code})`; });
    tlsTab.wc.loadURL(`https://tls.test:${tlsPort}/`).catch(() => {});
    await waitFor(() => failure !== null, 10_000);
    await sleep(500);
    const seen = await within(tlsTab.wc.executeJavaScript(
      '({ title: document.title, text: document.body ? document.body.innerText : "" })'), 4000, { title: '', text: '' });
    badCertificate = {
      error: failure,
      shown: seen.title === 'intercepted' || /exit relay could read/.test(seen.text),
      proceedOffered: /proceed|continue anyway|accept the risk/i.test(seen.text)
    };
  }
  step('badCertificate', badCertificate);

  // Camouflage: with it on, each real page load brings one decoy load, on a
  // circuit that page is not using; with it off, none. The harness reads
  // which ports the pages and the decoys arrived on.
  let camo = null;
  if (camouflage) {
    const firedBefore = camouflage.fired;
    camouflage.enabled = true;
    for (const host of ['cam1', 'cam2']) {
      const t = tabs.create({ url: url(host, 'idle.html') });
      await waitFor(() => t.isLive && !t.loading && /idle/.test(t.url), 15_000);
      await sleep(2000);
    }
    const firedWhileOn = camouflage.fired - firedBefore;
    camouflage.enabled = false;
    const t3 = tabs.create({ url: url('cam3', 'idle.html') });
    await waitFor(() => t3.isLive && !t3.loading && /idle/.test(t3.url), 15_000);
    await sleep(1500);
    camo = { firedWhileOn, firedWhileOff: camouflage.fired - firedBefore - firedWhileOn };
  }
  step('camouflage', camo);

  // Fonts: one installed here but not on the list must not be measurable.
  // The harness names it; equal widths mean the page fell back.
  const hiddenFont = argValue('leak-hidden-font');
  let fonts = { skipped: 'no font to test with' };
  if (hiddenFont && fpTab.isLive) {
    fonts = await within(fpTab.wc.executeJavaScript(`(() => {
      const width = (family) => { const c = document.createElement('canvas').getContext('2d');
        c.font = '32px ' + family; return c.measureText('mmmmmmmmmmlli WWW 0123').width; };
      // The allowed font must still measure differently, or the method proves nothing.
      return { font: ${JSON.stringify(hiddenFont)}, withFont: width('"' + ${JSON.stringify(hiddenFont)} + '", monospace'),
        fallback: width('monospace'), allowed: width('"DejaVu Serif", monospace'),
        survey: Object.fromEntries(['OpenSymbol', 'Carlito', 'FreeSans', 'Unifont', 'Loma', 'Courier 10 Pitch'].map((f) => [f, width('"' + f + '", monospace')])) };
    })()`), 5000, null);
  }
  step('fonts', { ...fonts, restricted: ctx.fonts });

  // Referrers: kept within a site, gone between sites.
  const refTab = tabs.create({ url: url('ref', 'idle.html') });
  await waitFor(() => refTab.isLive && !refTab.loading && /idle/.test(refTab.url), 15_000);
  const referrers = refTab.isLive ? await within(refTab.wc.executeJavaScript(`(async () => {
    const told = (host) => fetch('http://' + host + ':' + location.port + '/headers').then((r) => r.json()).then((h) => h.referer || null);
    return { sameSite: await told('img.ref.test'), crossSite: await told('other.test') };
  })()`), 8000, null) : null;
  step('referrers', referrers);

  // Files dropped and pasted onto a page's own handlers: the photo with GPS
  // must arrive without it, the pixels the same, and a fresh timestamp.
  let dropped = null;
  if (upTab2.isLive) {
    const b64 = photo.toString('base64');
    const got = await within(upTab2.wc.executeJavaScript(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const make = () => { const dt = new DataTransfer(); dt.items.add(new File([bytes], 'holiday.jpg', { type: 'image/jpeg', lastModified: 1000 })); return dt; };
      const receive = (type) => new Promise((resolve) => {
        const zone = document.body;
        const on = async (e) => {
          const list = type === 'drop' ? e.dataTransfer.files : e.clipboardData.files;
          const f = list[0];
          const buf = new Uint8Array(await f.arrayBuffer());
          let s = ''; for (const c of buf) s += String.fromCharCode(c);
          zone.removeEventListener(type, on);
          resolve({ gps: s.includes('GPS'), size: buf.length, lastModified: f.lastModified, b64: btoa(s) });
        };
        zone.addEventListener(type, on);
        setTimeout(() => resolve(null), 5000);
      });
      const d = receive('drop');
      document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: make() }));
      const p = receive('paste');
      const drop = await d;
      document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: make() }));
      return { drop, paste: await p };
    })()`), 12_000, null);
    const judge = (r) => r && {
      gps: r.gps, freshTimestamp: r.lastModified > 1000,
      samePixels: nativeImage.createFromBuffer(Buffer.from(r.b64, 'base64')).toBitmap()
        .equals(nativeImage.createFromBuffer(photo).toBitmap())
    };
    dropped = got ? { drop: judge(got.drop), paste: judge(got.paste) } : null;
  }
  step('dropped', dropped);

  // An external protocol starts nothing.
  const deniedBefore = tabs.deniedPermissions.length;
  const extTab = tabs.create({ url: url('t2', 'idle.html') });
  await waitFor(() => extTab.isLive && !extTab.loading && /idle/.test(extTab.url), 15_000);
  if (extTab.isLive) extTab.wc.loadURL('mailto:someone@example.com').catch(() => {});
  await waitFor(() => tabs.deniedPermissions.length > deniedBefore, 4000);
  step('externalProtocol', tabs.deniedPermissions.slice(deniedBefore));

  // Nothing at all, for a while - where background fetches show themselves.
  await sleep(idleMs);
  step('idle', idleMs);

  // New identity, last, because it closes every tab. A cookie set in t1 must
  // be gone afterwards, and one fresh tab left.
  const t1Session = byHost.t1.session;
  await t1Session.cookies.set({ url: url('t1', ''), name: 'marker', value: 'kept?' }).catch(() => {});
  runCommand('new-identity');
  await waitFor(() => tabs.all().length === 1, 5000);
  await sleep(300);
  const left = await t1Session.cookies.get({}).catch(() => ['error']);
  step('newIdentity', { tabsAfter: tabs.all().length, cookiesLeft: left.length });

  step('tripwireDuringCleanRun', { trips: trips.length, ...tripwire.status() });
  await netLog.stopLogging();

  // --- Canaries: leak on purpose, and require both detectors to see it ----
  //
  // A detector that has never fired has not been shown to work. These two are
  // real direct connections made by the incognito process; the harness counts
  // the run a failure unless the network log flags the first and the tripwire
  // closes on the second.
  const [canaryHost, canaryPort] = String(canary).split(':');
  await netLog.startLogging(path.join(dir, 'canary.json'), { captureMode: 'default' });

  // Loopback, on a port that is not the proxy's. The resolver rules refuse
  // every other address before a socket opens - measured, a direct fetch to a
  // LAN address never reached connect() - so this is the one direct connection
  // Chromium can still make, and the network log has to catch it. It is also
  // exactly the leak that was found: a context quietly using a different local
  // proxy.
  // Its request policy is taken away too: this stands for a context that
  // incognito's configuration did not reach, which is the whole point.
  const direct = session.fromPartition('leak-canary-direct');
  await direct.setProxy({ mode: 'direct' });
  direct.webRequest.onBeforeRequest(null);
  const viaChromium = await within(direct.fetch(`http://127.0.0.1:${canaryPort}/`)
    .then((r) => r.status), 4000, 'no-response');
  step('canaryChromium', viaChromium);

  // Under the Linux kill switch this connection cannot be made at all - the
  // namespace has no route - and that failure is what the harness checks.
  // Without it, the socket opens and the tripwire has to close the window.
  const tripsBefore = trips.length;
  const outcome = { connected: false, error: null };
  // The harness may aim this one somewhere real (the Windows firewall test
  // does, after showing an ordinary process can reach it).
  const [nodeHost, nodePort] = String(argValue('leak-canary-node') || `${canaryHost}:${canaryPort}`).split(':');
  const socket = net.connect(Number(nodePort), nodeHost);
  socket.on('connect', () => { outcome.connected = true; });
  socket.on('error', (err) => { outcome.error = err.code || err.message; });
  // A trip ends the watcher, so the clean run above had to happen first.
  const caught = await waitFor(() => trips.length > tripsBefore || outcome.error, 3000, 50) &&
    trips.length > tripsBefore;
  socket.destroy();
  step('canaryNode', { caught, ...outcome, violations: trips.slice(-1)[0]?.violations || [] });
  await netLog.stopLogging();

  process.stdout.write(`\n__LEAK__${JSON.stringify(report)}\n`);
  // The panic key, when asked: the harness times how long the process, Tor
  // and the private profile take to be gone after this line.
  if (process.argv.includes('--leak-panic')) {
    process.stdout.write(`__PANIC__${Date.now()}\n`);
    runCommand('panic');
    return new Promise(() => {});
  }
  if (shell) shell.window.destroy();
  return 0;
}

module.exports = { run };
