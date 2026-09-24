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

async function run({ app, tabs, shell, downloads, tripwire, circuits, runCommand, ctx, log, setTripHook }) {
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

  step('tripwire', await tripwire.capability());
  step('killSwitch', ctx.killSwitch);

  // --- Ordinary browsing, every kind of request the browser makes ---------
  const url = (host, page) => `http://${host}.test:${fixturePort}/${page}`;
  // The fixtures are plain HTTP. Incognito upgrades navigations to HTTPS and
  // asks before falling back, so the test says yes for these hosts the same
  // way the user does - through the policy's own switch, not a test backdoor.
  // `up.test` is left out on purpose: it is the one that must be upgraded.
  const policy = require('./incognito/policy');
  for (const host of ['t1', 't2', 'rtc', 'lan', 'link', 'nc', 'ch', 'chx']) policy.allowHttp(url(host, ''));
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
  await waitFor(() => linked.isLive && !linked.loading, 15_000);
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
  step('download', { finished, state: last?.state || null });

  // WebRTC, pointed at a STUN server. Nothing may be gathered that names this
  // machine, and nothing may reach the STUN server at all.
  const rtcTab = tabs.create({ url: `${url('rtc', 'webrtc.html')}?stun=${stun}` });
  await waitFor(() => rtcTab.isLive && !rtcTab.loading, 15_000);
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
  await waitFor(() => lanTab.isLive && !lanTab.loading, 15_000);
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

  // An external protocol starts nothing.
  const deniedBefore = tabs.deniedPermissions.length;
  const extTab = tabs.create({ url: url('t2', 'idle.html') });
  await waitFor(() => extTab.isLive && !extTab.loading, 15_000);
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
  if (shell) shell.window.destroy();
  return 0;
}

module.exports = { run };
