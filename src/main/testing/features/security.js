'use strict';

/**
 * A website attacking the browser it runs in: every way a page could reach
 * the browser's own pages and their command bridge, or files on the computer,
 * tried from a real tab against a hostile server of its own. Each one must
 * leave the tab on the site, with nothing of the browser's in reach.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { crxKey } = require('../../extensions');
const pages = require('../../pages');
const { sanitiseName, runsAsProgram } = require('../../downloads');

/** A site of the attacker's: each path a different way out. */
function hostileServer() {
  const page = (body) => `<!doctype html><meta charset="utf-8"><title>hostile</title><body>${body}</body>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const to = u.searchParams.get('to') || '';
    const html = (body) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page(body)); };
    switch (u.pathname) {
      case '/redirect': res.writeHead(302, { Location: to }); res.end(); return;
      case '/self': return html(`<script>setTimeout(() => { location.href = ${JSON.stringify(to)}; }, 50)</script>`);
      case '/meta': return html(`<meta http-equiv="refresh" content="0;url=${to.replace(/"/g, '&quot;')}">`);
      case '/link': return html(`<a id="a" href="${to.replace(/"/g, '&quot;')}">go</a><script>setTimeout(() => document.getElementById('a').click(), 50)</script>`);
      case '/form': return html(`<form id="f" method="get" action="${to.replace(/"/g, '&quot;')}"></form><script>setTimeout(() => document.getElementById('f').submit(), 50)</script>`);
      case '/open': return html(`<script>setTimeout(() => window.open(${JSON.stringify(to)}), 50)</script>`);
      default: return html('<p>hostile</p>');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}


/**
 * A sign-in from start to finish, as a site does it: the page opens the
 * provider in a pop-up, the provider sends it back to the site with a code,
 * and the site's page there hands the code to the page that opened it and
 * closes the window. Each way sites hand it over - postMessage to the
 * opener, the opener watching for the window to close, and storage when the
 * provider's isolation has cut the opener - and a site's own sign-in path,
 * which is a Peek that must keep the opener just the same.
 */
async function signInRoundTrip({ check, waitFor, sleep, tabs }) {
  const { BaseWindow } = require('electron');
  const certs = path.join(__dirname, '..', '..', '..', '..', 'test', 'certs');
  const cert = fs.readFileSync(path.join(certs, 'localhost-cert.pem'));
  const server = https.createServer({ key: fs.readFileSync(path.join(certs, 'localhost-key.pem')), cert }, (req, res) => {
    const u = new URL(req.url, 'https://x');
    const how = u.searchParams.get('how') || '';
    const page = (body) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><body>${body}`); };
    // The provider: sends the window back to the site with a code.
    if (u.pathname === '/oauth/authorize') {
      res.writeHead(302, { Location: `${u.searchParams.get('back')}/callback?how=${how}&code=c-${how}`, ...(how === 'storage' ? { 'Cross-Origin-Opener-Policy': 'same-origin' } : {}) });
      res.end();
      return;
    }
    if (u.pathname === '/callback' || u.pathname === '/connect') {
      const code = u.searchParams.get('code') || 'c-peek';
      page(`<script>
        ${how === 'storage' ? `localStorage.setItem('signin', '${code}');` : how === 'closed' ? `localStorage.setItem('signin', '${code}');` : `window.opener && window.opener.postMessage({ code: '${code}' }, location.origin);`}
        setTimeout(() => window.close(), 700);
      </script>`);
      return;
    }
    // The site.
    page(`<script>
      localStorage.removeItem('signin');
      const done = (code) => { document.title = 'signed in ' + code; };
      addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.code) done(e.data.code); });
      addEventListener('storage', (e) => { if (e.key === 'signin' && '${how}' === 'storage') done(e.newValue); });
      const w = window.open(${how === 'peek' ? "'/connect'" : "'https://127.0.0.1:' + location.port + '/oauth/authorize?how=" + how + "&back=' + encodeURIComponent(location.origin)"}, 'signin', 'popup,width=420,height=520');
      if ('${how}' === 'closed') { const t = setInterval(() => { if (w.closed) { clearInterval(t); done(localStorage.getItem('signin')); } }, 100); }
    </script>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const site = `https://localhost:${server.address().port}`;
  const tab = tabs.create({ url: 'about:blank', activate: true, realise: true });
  await waitFor(() => tab.isLive, { timeoutMs: 8000 });
  const ses = tab.wc.session;
  const ours = new crypto.X509Certificate(cert).fingerprint256;
  ses.setCertificateVerifyProc((req, done) => {
    let mine = false;
    try { mine = (req.hostname === '127.0.0.1' || req.hostname === 'localhost') && new crypto.X509Certificate(req.certificate.data).fingerprint256 === ours; } catch { /* not ours */ }
    done(mine ? 0 : -3);
  });
  try {
    for (const how of ['message', 'closed', 'storage', 'peek']) {
      const windows = new Set(BaseWindow.getAllWindows());
      const tabCount = tabs.all().length;
      let opened = [];
      let awake = false;
      tab.wc.loadURL(`${site}/app?how=${how}`).catch(() => {});
      const ok = await waitFor(() => {
        opened = opened.concat(BaseWindow.getAllWindows().filter((w) => !windows.has(w) && !opened.includes(w)));
        if (tab.signingIn) awake = true;
        return tab.wc.getTitle() === `signed in c-${how}`;
      }, { timeoutMs: 10000 });
      const fresh = () => BaseWindow.getAllWindows().filter((w) => !windows.has(w) && !w.isDestroyed());
      await waitFor(() => fresh().length === 0 && !tab.signingIn, { timeoutMs: 4000 });
      const left = fresh();
      check(`Sign-in round trip (${how}): the site gets the answer, the window closes itself, no tab is left`,
        ok && left.length === 0 && tabs.all().length === tabCount,
        `title "${tab.wc.getTitle()}", ${left.length} window(s) left, ${tabs.all().length - tabCount} new tab(s)`);
      if (how === 'peek') {
        check('Sign-in round trip: a site\'s own sign-in path is a Peek, not a window', opened.length === 0, `${opened.length} window(s)`);
      } else {
        check(`Sign-in round trip (${how}): it was a sign-in window, and the tab was kept awake meanwhile`, opened.length === 1 && awake, `${opened.length} window(s), awake ${awake}`);
        check(`Sign-in round trip (${how}): the tab is no longer held awake once it ends`, !tab.signingIn);
      }
      for (const w of left) w.destroy();
    }
  } finally {
    ses.setCertificateVerifyProc(null);
    tabs.close(tab.id);
    server.closeAllConnections(); await new Promise((r) => server.close(r));
  }
}
module.exports = async function securityFeature(t) {
  const { check, waitFor, sleep, tabs, inTime } = t;
  const server = await hostileServer();
  const site = `http://hostile.test:${server.address().port}`;

  // Each way a page can send its own tab somewhere, to each place a site must
  // not be able to send it.
  const targets = {
    settings: 'debrowser://settings',
    warning: 'debrowser://danger/?kind=lookalike&like=bank.example&url=https%3A%2F%2Fbank.example%2F',
    file: 'file:///etc/passwd',
    chrome: 'chrome://gpu',
    'view-source': 'view-source:http://hostile.test/'
  };
  for (const way of ['self', 'redirect', 'meta', 'link', 'form']) {
    for (const [name, to] of Object.entries(targets)) {
      const tab = tabs.create({ url: `${site}/${way}?to=${encodeURIComponent(to)}`, activate: false, realise: true });
      await waitFor(() => tab.isLive && !tab.loading, { timeoutMs: 8000 });
      await sleep(400);
      await waitFor(() => !tab.loading, { timeoutMs: 4000 });
      const live = tab.isLive ? tab.wc.getURL() : '';
      const bridge = tab.isLive ? await inTime(tab.wc.executeJavaScript('typeof window.debrowser').catch(() => 'gone'), 2000, 'undefined') : 'gone';
      check(`Security: a website cannot send its tab to ${name} (${way})`,
        !pages.isInternal(live) && !pages.isInternal(tab.url) && !/^(file|chrome|view-source):/i.test(live) && bridge === 'undefined',
        `${live} | tab ${tab.url} | bridge ${bridge}`);
      tabs.close(tab.id);
    }
  }

  // A pop-up to one of ours or to a file: no tab for it.
  for (const to of ['debrowser://passwords', 'file:///etc/passwd']) {
    const before = new Set(tabs.all().map((x) => x.id));
    const tab = tabs.create({ url: `${site}/open?to=${encodeURIComponent(to)}`, activate: true, realise: true });
    await waitFor(() => tab.isLive && !tab.loading, { timeoutMs: 8000 });
    await sleep(600);
    const opened = tabs.all().filter((x) => x !== tab && !before.has(x.id));
    check(`Security: a website's pop-up to ${to} opens nothing`, opened.length === 0, opened.map((x) => x.url).join(', '));
    for (const x of [...opened, tab]) tabs.close(x.id);
  }

  // From inside a site: nothing of the browser to call, read, frame or load.
  const tab = tabs.create({ url: `${site}/plain`, activate: false, realise: true });
  await waitFor(() => tab.isLive && !tab.loading, { timeoutMs: 8000 });
  const seen = await tab.wc.executeJavaScript(`(async () => {
    const out = {};
    out.globals = [typeof window.debrowser, typeof require, typeof process, typeof module, typeof chrome?.runtime?.sendMessage].join(',');
    const tryFetch = async (u) => { try { const r = await fetch(u); return 'read ' + r.status; } catch { return 'refused'; } };
    out.fetchPage = await tryFetch('debrowser://settings/settings.js');
    out.fetchBridge = await tryFetch('debrowser://ext-bridge/?t=x&op=tabs.query&a=%7B%7D');
    out.fetchIcon = await tryFetch('debrowser://icon/?u=' + encodeURIComponent('https://example.com/favicon.ico'));
    out.fetchFile = await tryFetch('file:///etc/passwd');
    out.img = await new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('refused'); i.src = 'debrowser://newtab/icon.svg'; setTimeout(() => r('timeout'), 3000); });
    out.frame = await new Promise((r) => {
      const f = document.createElement('iframe');
      f.src = 'debrowser://settings';
      f.onload = () => { let u = 'opaque'; try { u = f.contentWindow.location.href; } catch {} r('loaded ' + u + ' ' + typeof f.contentWindow.debrowser); };
      document.body.append(f);
      setTimeout(() => r('timeout'), 3000);
    });
    return out;
  })()`).catch((e) => ({ error: e.message }));
  check('Security: a website sees no bridge, Node or extension messaging', seen.globals === 'undefined,undefined,undefined,undefined,undefined', seen.globals);
  check('Security: a website cannot read the browser\'s pages, the extension bridge or files',
    seen.fetchPage === 'refused' && seen.fetchBridge === 'refused' && seen.fetchFile === 'refused', JSON.stringify(seen));
  check('Security: a website cannot load the browser\'s images to tell it is Debrowser', seen.img === 'refused', seen.img);
  check('Security: a website cannot frame one of the browser\'s pages', !/debrowser:\/\/settings|function|object/.test(String(seen.frame)), String(seen.frame));
  tabs.close(tab.id);

  // A page saved to the computer and opened: it may not read the computer's
  // other files, as in Chrome - a downloaded .html reading ~/.ssh.
  if (process.env.DEBROWSER_FILE_PROBE) {
    const local = tabs.create({ url: `file://${process.env.DEBROWSER_FILE_PROBE}`, activate: false, realise: true });
    await waitFor(() => local.isLive && !local.loading, { timeoutMs: 8000 });
    const read = await inTime(local.wc.executeJavaScript('window.result').catch((e) => ({ error: e.message })), 6000, { error: 'timeout' });
    check('Security: a local page cannot read other files', !JSON.stringify(read).includes('SECRET-123'), JSON.stringify(read));
    tabs.close(local.id);
  }

  // Our pages only under their own names: a page's file under another page's
  // name would run with that page's rights.
  const wrongName = tabs.create({ url: 'debrowser://settings/passwords.html', activate: false, realise: true });
  await waitFor(() => wrongName.isLive && !wrongName.loading, { timeoutMs: 8000 });
  const body = await wrongName.wc.executeJavaScript('document.title + "|" + document.body.innerText.slice(0, 40)').catch(() => '');
  check('Security: another page\'s file is not served under Settings\' name', !/Passwords/i.test(body), body);
  tabs.close(wrongName.id);
  const ownName = tabs.create({ url: 'debrowser://settings/settings.html', activate: false, realise: true });
  await waitFor(() => ownName.isLive && !ownName.loading, { timeoutMs: 8000 });
  const own = await ownName.wc.executeJavaScript('document.title').catch(() => '');
  check('Security: a page\'s own file is still served at its own name', /Settings/i.test(own), own);
  tabs.close(ownName.id);

  // An extension's picture of the tab in front: never one of the browser's
  // pages (Passwords with a password showing), and a website only with
  // access to it.
  const ext = t.getExtensions && t.getExtensions();
  if (ext) {
    const fixtures = path.join(__dirname, '..', '..', '..', '..', 'test', 'extensions');
    const everywhere = ext.install(path.join(fixtures, 'chrome-tools'));
    const nowhere = ext.install(path.join(fixtures, 'chrome-hello'));
    const shot = (who) => inTime(ext.bridge(who.token || ext.list().find((e) => e.id === who.id).token, 'tabs.captureVisibleTab', {})
      .then((v) => (String(v).startsWith('data:image/') ? 'captured' : String(v)), (e) => `refused: ${e.message}`), 5000, 'timeout');
    const own = tabs.create({ url: pages.PASSWORDS_URL, activate: true, realise: true });
    await waitFor(() => own.isLive && !own.loading, { timeoutMs: 8000 });
    const ofPasswords = await shot(everywhere);
    const web = tabs.create({ url: `${site}/plain`, activate: true, realise: true });
    await waitFor(() => web.isLive && !web.loading, { timeoutMs: 8000 });
    const ofSite = await shot(everywhere);
    const ofSiteNoAccess = await shot(nowhere);
    check('Security: an extension cannot take a picture of the browser\'s own pages', /^refused/.test(ofPasswords), ofPasswords);
    check('Security: an extension takes a picture of a website it may reach, and not of one it may not',
      ofSite === 'captured' && /^refused/.test(ofSiteNoAccess), `${ofSite} / ${ofSiteNoAccess}`);
    tabs.close(web.id);
    tabs.close(own.id);
    ext.remove(everywhere.id);
    ext.remove(nowhere.id);
  }

  // A .crx's key counts - and with it the store's ID - only when its own
  // signature holds: a header can name any extension's key.
  const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
  const field = (num, data) => Buffer.concat([varint(num * 8 + 2), varint(data.length), data]);
  const crx = (signer, claimed, zip) => {
    const pub = claimed.publicKey.export({ type: 'spki', format: 'der' });
    const signedHeader = field(1, crypto.createHash('sha256').update(pub).digest().subarray(0, 16));
    const sig = crypto.sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'),
      Buffer.from(Uint32Array.of(signedHeader.length).buffer), signedHeader, zip]), signer.privateKey);
    const header = Buffer.concat([field(2, Buffer.concat([field(1, pub), field(2, sig)])), field(10000, signedHeader)]);
    const head = Buffer.alloc(12);
    head.write('Cr24', 0, 'latin1');
    head.writeUInt32LE(3, 4);
    head.writeUInt32LE(header.length, 8);
    return { file: Buffer.concat([head, header, zip]), key: pub.toString('base64') };
  };
  const real = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const zip = Buffer.from('PK\x03\x04 an archive');
  const signedRight = crx(real, real, zip);
  check('Security: a .crx signed by its own key gives that key', crxKey(signedRight.file) === signedRight.key);
  check('Security: a .crx claiming a key it was not signed with gives none', crxKey(crx(other, real, zip).file) === null);
  check('Security: a .crx changed after signing gives none', crxKey(Buffer.concat([signedRight.file, Buffer.from('x')])) === null);

  // Downloads: names that pretend to be something else, and programs by any name.
  const bidi = sanitiseName('invoice‮fdp.cpl');
  check('Security: a download\'s name loses the characters that reverse how it reads', !/[‎‏‪-‮⁦-⁩]/.test(bidi) && bidi.endsWith('.cpl'), JSON.stringify(bidi));
  const programs = ['a.cpl', 'a.msc', 'a.chm', 'a.url', 'a.iso', 'a.img', 'a.vhd', 'a.vhdx', 'a.xll', 'a.psm1', 'a.desktop', 'a.exe', 'a.EXE'];
  const missed = programs.filter((f) => !runsAsProgram(f));
  check('Security: every kind of file that runs when opened is asked about first', missed.length === 0, missed.join(', '));
  check('Security: documents are not called programs', !runsAsProgram('report.pdf') && !runsAsProgram('photo.jpg'));

  server.closeAllConnections(); await new Promise((r) => server.close(r));

  await signInPopups(t);
  await signInRoundTrip(t);
  {
    const { isSignInFrame } = require('../../protection/third-party');
    const { check } = t;
    check('Sign-in buttons: Google\'s frame on a site keeps its cookies',
      isSignInFrame({ url: 'https://accounts.google.com/gsi/button', resourceType: 'subFrame' }) &&
      isSignInFrame({ url: 'https://accounts.google.com/gsi/status', resourceType: 'xhr', frame: { url: 'https://accounts.google.com/gsi/iframe/select' } }));
    check('Sign-in buttons: nothing else gets the exception - a site\'s own call to Google, or a tracker in Google\'s frame',
      !isSignInFrame({ url: 'https://accounts.google.com/gsi/status', resourceType: 'xhr', frame: { url: 'https://site.example/' } }) &&
      !isSignInFrame({ url: 'https://tracker.example/p', resourceType: 'image', frame: { url: 'https://accounts.google.com/gsi/iframe/select' } }) &&
      !isSignInFrame({ url: 'https://ads.google.com/x', resourceType: 'subFrame' }));
  }
};

/**
 * A sign-in pop-up (popup-window.js) and the pop-ups it opens in turn: each a
 * window under the same rules, never Electron's default window, which shows
 * no address; and none of them taken to one of our pages. Over HTTPS, as only
 * HTTPS pop-ups get a window, with a certificate of the test's own.
 */
async function signInPopups({ check, waitFor, sleep, tabs }) {
  const { BaseWindow, BrowserWindow, webContents } = require('electron');
  const certs = path.join(__dirname, '..', '..', '..', '..', 'test', 'certs');
  const cert = fs.readFileSync(path.join(certs, 'localhost-cert.pem'));
  const server = https.createServer({ key: fs.readFileSync(path.join(certs, 'localhost-key.pem')), cert }, (req, res) => {
    const u = new URL(req.url, 'https://x');
    const mode = u.searchParams.get('mode') || '';
    if (u.pathname === '/r') { res.writeHead(302, { Location: 'debrowser://settings' }); res.end(); return; }
    const script = {
      start: `window.open('https://127.0.0.1:' + location.port + '/login?mode=${u.searchParams.get('next')}', 'a', 'popup,width=400,height=400')`,
      nav: "setTimeout(() => { location.href = 'debrowser://settings'; }, 200)",
      redir: "setTimeout(() => { location.href = '/r'; }, 200)",
      nest: "setTimeout(() => window.open('/login?mode=leaf', 'b', 'popup,width=300,height=300'), 200)",
      leaf: "setTimeout(() => window.open('/plain?leafchild', 'c', 'popup,width=300,height=300'), 200)"
    }[u.pathname === '/start' ? 'start' : mode] || '';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>sign in</title><body>${u.pathname}<script>${script}</script>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${server.address().port}`;
  const tab = tabs.create({ url: 'about:blank', activate: true, realise: true });
  await waitFor(() => tab.isLive, { timeoutMs: 8000 });
  const ses = tab.wc.session;
  const ours = new crypto.X509Certificate(cert).fingerprint256;
  ses.setCertificateVerifyProc((req, done) => {
    let mine = false;
    try { mine = (req.hostname === '127.0.0.1' || req.hostname === 'localhost') && new crypto.X509Certificate(req.certificate.data).fingerprint256 === ours; } catch { /* not ours */ }
    done(mine ? 0 : -3);
  });
  const urls = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed()).map((w) => w.getURL()).filter((u) => !u.startsWith('data:'));
  try {
    for (const next of ['nav', 'redir', 'nest']) {
      const windows = new Set(BaseWindow.getAllWindows());
      const plain = BrowserWindow.getAllWindows().length;
      const settingsBefore = urls().filter((u) => u.startsWith('debrowser://settings')).length;
      // From another site than the sign-in's, as a real sign-in is (localhost
      // and 127.0.0.1 are two): a site's own /login pop-up is a Peek.
      tab.wc.loadURL(`${base.replace('127.0.0.1', 'localhost')}/start?next=${next}`).catch(() => {});
      await waitFor(() => urls().some((u) => u.includes(`/login?mode=${next}`)), { timeoutMs: 8000 });
      await sleep(next === 'nest' ? 1500 : 1000);
      const opened = BaseWindow.getAllWindows().filter((w) => !windows.has(w));
      if (next === 'nest') {
        check('Security: a sign-in pop-up\'s own pop-up is a sign-in window too, never a bare one',
          opened.length === 2 && BrowserWindow.getAllWindows().length === plain, `${opened.length} new, ${BrowserWindow.getAllWindows().length - plain} bare`);
        const child = tabs.all().find((x) => /leafchild/.test(x.url));
        check('Security: what a nested sign-in window opens is a tab', !!child, urls().join(' | '));
        if (child) tabs.close(child.id);
      } else {
        const settingsAfter = urls().filter((u) => u.startsWith('debrowser://settings')).length;
        check(`Security: a sign-in pop-up cannot go to one of our pages (${next === 'nav' ? 'script' : 'redirect'})`,
          opened.length === 1 && settingsAfter === settingsBefore, `${opened.length} new: ${urls().join(' | ')}`);
      }
      for (const w of opened) if (!w.isDestroyed()) w.destroy();
    }
  } finally {
    ses.setCertificateVerifyProc(null);
    tabs.close(tab.id);
    server.closeAllConnections(); await new Promise((r) => server.close(r));
  }
}
