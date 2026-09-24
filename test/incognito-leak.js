#!/usr/bin/env node
'use strict';

/**
 * The incognito leak test.
 *
 *     node test/incognito-leak.js [--idle-ms=600000] [--no-namespace]
 *
 * Everything incognito claims about the network is checked here from outside
 * the browser, where the browser cannot flatter itself:
 *
 *   - A stand-in for Tor, on loopback, records every name the browser asks it
 *     for. Pages, a favicon, a download, WebRTC and DevTools are all driven
 *     through it by src/main/smoke-incognito.js.
 *   - Chromium's own network log must show every socket going to that one
 *     port, and no UDP at all.
 *   - A STUN server listens for WebRTC, and must hear nothing.
 *   - On Linux the whole run happens in a fresh network namespace with no
 *     route anywhere, so a leak that every detector missed still reaches
 *     nothing.
 *   - Then the browser leaks on purpose, twice. The network log must flag the
 *     first and the tripwire must close on the second. A detector that has
 *     never been seen to fire is not evidence of anything.
 *   - After exit, the private profile directory must be gone and the normal
 *     profile must be byte-for-byte what it was.
 */

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/** In the namespace, a second address on loopback stands in for "the internet". */
const NS_CANARY_IP = '10.77.0.1';

/* ------------------------------------------------------------------ */
/* Re-run inside a network namespace, where one can be made            */
/* ------------------------------------------------------------------ */

// Brings loopback up and gives it a second, non-loopback address. Python
// because Node has no ioctl and CI images do not reliably carry `ip`.
const NS_SETUP = `
import socket, fcntl, struct
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
flags = struct.unpack('16sH', fcntl.ioctl(s, 0x8913, struct.pack('16sH14s', b'lo', 0, b''))[:18])[1]
fcntl.ioctl(s, 0x8914, struct.pack('16sH14s', b'lo', flags | 1, b''))
fcntl.ioctl(s, 0x8916, struct.pack('16sH2s4s8s', b'lo:0', socket.AF_INET, b'', socket.inet_aton('${NS_CANARY_IP}'), b''))
`;

function maybeEnterNamespace() {
  if (process.platform !== 'linux' || flag('no-namespace') || process.env.LEAK_IN_NAMESPACE) return false;
  const probe = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'true']);
  if (probe.status !== 0) {
    console.log('  NOTE  no network namespace here (unshare refused); the detectors run without the backstop');
    return false;
  }
  const inner = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'sh', '-c',
    `python3 -c "$NS_SETUP" && exec "$0" "$@"`, process.execPath, __filename, ...args], {
    stdio: 'inherit',
    env: { ...process.env, LEAK_IN_NAMESPACE: '1', NS_SETUP }
  });
  process.exit(inner.status ?? 1);
}

const { socksPoolOnPorts } = require('./socks-stub');
const { POOL_SIZE } = require('../src/main/incognito/mode');

/** Where a "direct" connection would go: somewhere that is not loopback. */
/**
 * An HTTPS server on a certificate made for this run, signed by nobody.
 * Made with openssl rather than committed, so no private key - however
 * harmless - sits in the repository. Resolves `{port: 0, reason}` when
 * openssl is missing, which the check then reports as a failure.
 */
function selfSignedServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-tls-'));
  const key = path.join(dir, 'tls.key');
  const cert = path.join(dir, 'tls.pem');
  const made = require('child_process').spawnSync('openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
     '-days', '2', '-subj', '/CN=tls.test'], { encoding: 'utf8' });
  if (made.status !== 0 || !fs.existsSync(cert)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return Promise.resolve({ port: 0, reason: (made.error && made.error.message) || made.stderr || 'openssl failed' });
  }
  const credentials = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true, force: true });
  const server = require('https').createServer(credentials, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>intercepted</title><p>An exit relay could read and change this page.');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server })));
}

/**
 * A font installed on this machine that a private window must not show pages:
 * any family not on the allowed list. Linux only - elsewhere fonts are not
 * restricted, and the connection page says so.
 */
function hiddenFont() {
  if (process.platform !== 'linux') return null;
  const { ALLOWED } = require('../src/main/incognito/fonts');
  const r = require('child_process').spawnSync('fc-list', [':scalable=true:lang=en', 'family'], { encoding: 'utf8' });
  const families = (r.stdout || '').split('\n').map((l) => l.split(',')[0].trim()).filter(Boolean);
  return families.find((f) => !ALLOWED.includes(f) && /^[\w ]+$/.test(f)) || null;
}

function canaryAddress() {
  if (process.env.LEAK_IN_NAMESPACE) return NS_CANARY_IP;
  const nic = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  return nic ? nic.address : null;
}

/** A listener for the canaries: TCP answers, UDP only counts. */
function canaryListeners(ip) {
  const hits = { tcp: 0, udp: 0 };
  const tcp = net.createServer((s) => {
    hits.tcp++;
    s.on('error', () => {});
    s.once('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: keep-alive\r\n\r\ncanary'));
  });
  const udp = dgram.createSocket('udp4');
  udp.on('message', () => { hits.udp++; });
  return Promise.all([
    new Promise((r) => tcp.listen(0, '0.0.0.0', r)),
    new Promise((r) => udp.bind(0, ip, r))
  ]).then(() => ({
    hits,
    tcpPort: tcp.address().port,
    udpPort: udp.address().port,
    close: () => { tcp.close(); udp.close(); }
  }));
}

/* ------------------------------------------------------------------ */
/* Reading Chromium's network log                                      */
/* ------------------------------------------------------------------ */

const isLiteral = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
const hostOf = (text) => String(text).replace(/^[a-z]+:\/\//i, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

/**
 * Every socket and lookup that did not go to the proxy.
 *
 * The lookup rule is the strict one, and it has to be. A request sent through
 * SOCKS5 never resolves its host locally - the name goes to the proxy - so a
 * local lookup made *for a URL request* means that request was going direct,
 * even when the resolver rules then refused it. Counting refused lookups as
 * harmless is how the first version of this test passed a build whose favicon
 * route bypassed the proxy entirely: the rules caught it, and the rules are
 * the second line, not the first.
 *
 * Lookups attributed to Chromium's network-quality estimator are listed
 * separately. They follow proxied connections one for one, carry the mapped
 * name `~notfound` rather than any page's host, and the rules refuse them
 * before a packet exists; a proxied request's routing is judged by the
 * decision recorded above, not by these.
 */
function readNetLog(file, proxyPort) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]));
  const sources = Object.fromEntries(Object.entries(log.constants.logSourceType).map(([k, v]) => [v, k]));
  const offenders = [];
  const background = new Set();
  const urls = new Map();
  // UDP is judged by what was sent, not by `connect()`. Connecting a UDP
  // socket transmits nothing - it asks the routing table - and Chromium does
  // exactly that to see whether IPv6 works at all (a "connect" to Google's
  // public DNS on 2001:4860:4860::8888, measured on the Linux CI runner and
  // absent here, where there is no IPv6 to ask about). A datagram that leaves
  // is `UDP_BYTES_SENT`, and that is the leak.
  const udpTarget = new Map();
  const udpProbes = new Set();
  let proxied = 0;
  for (const e of log.events) {
    const p = e.params || {};
    const type = names[e.type];
    if ((type === 'URL_REQUEST_START_JOB' || type === 'HTTP_STREAM_JOB_CONTROLLER') && p.url) {
      urls.set(e.source?.id, p.url);
    }
  }
  for (const e of log.events) {
    const type = names[e.type];
    const p = e.params || {};
    const source = sources[e.source?.type];
    if (type === 'PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST' && /DIRECT/.test(String(p.proxy_info))) {
      // Chromium's own routing decision for one request, before any socket:
      // the most direct evidence there is. A connection the resolver rules
      // then refused never reaches TCP_CONNECT_ATTEMPT, so this is also the
      // only place such a request shows up at all - measured, a favicon route
      // left outside the proxy appeared here and nowhere else.
      offenders.push(`routed direct: ${urls.get(e.source?.id) || 'unknown request'}`);
    } else if (type === 'TCP_CONNECT_ATTEMPT' && p.address) {
      // Any port of Tor's pool - one per tab - and nothing else, not even
      // another port on loopback.
      const [host, port] = String(p.address).split(/:(?=\d+$)/);
      if (host === '127.0.0.1' && Number(port) >= proxyPort && Number(port) < proxyPort + POOL_SIZE) proxied++;
      else offenders.push(`tcp ${p.address}`);
    } else if (type === 'UDP_CONNECT' && p.address) {
      udpTarget.set(e.source?.id, p.address);
      udpProbes.add(p.address);
    } else if (type === 'UDP_BYTES_SENT') {
      offenders.push(`udp sent ${p.byte_count || '?'} bytes to ${udpTarget.get(e.source?.id) || p.address || 'unknown'}`);
      udpProbes.delete(udpTarget.get(e.source?.id));
    } else if ((type === 'HOST_RESOLVER_DNS_TASK' || type === 'HOST_RESOLVER_SYSTEM_TASK') && e.phase === 1) {
      offenders.push(`dns sent (${source})`);
    } else if (type === 'HOST_RESOLVER_MANAGER_REQUEST' && p.host) {
      const host = hostOf(p.host);
      if (host === '127.0.0.1') continue;
      if (source === 'NETWORK_QUALITY_ESTIMATOR') background.add(host);
      else offenders.push(`local lookup for ${urls.get(e.source?.id) || host} (${source})`);
    }
  }
  return { offenders, background: [...background], udpProbes: [...udpProbes], proxied };
}

/* ------------------------------------------------------------------ */
/* Profile fingerprint, to prove the normal one was not touched        */
/* ------------------------------------------------------------------ */

function treeHash(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      hash.update(path.relative(dir, full));
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) hash.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ */

async function main() {
  maybeEnterNamespace();
  const inNamespace = Boolean(process.env.LEAK_IN_NAMESPACE);
  const killSwitch = flag('kill-switch');
  // Windows: run as a hard-linked copy that a firewall rule blocks, the way the
  // installer sets it up, and show that the rule - not the browser - stops a
  // real outbound connection. Needs an elevated shell (CI runners are).
  const windowsFirewall = flag('windows-firewall') && process.platform === 'win32';
  const results = [];
  const check = (name, passed, detail = '') => {
    results.push({ name, passed });
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  console.log(`\nIncognito leak test${inNamespace ? ' (inside a network namespace: loopback only)' : ''}` +
    `${killSwitch ? ', started through the kill switch' : ''}\n`);

  const fixtures = await require('../src/main/fixture-server').start();
  // An HTTPS site with a certificate nobody vouches for - what an exit relay
  // intercepting the connection would present. Its page must never show.
  const tls = await selfSignedServer();
  const route = (host) => (host.startsWith('tls.') && tls.port ? tls.port : fixtures.port);
  const stub = await socksPoolOnPorts(POOL_SIZE, route);
  const ip = canaryAddress();
  if (!ip) {
    check('a canary address exists to leak to', false, 'no non-loopback IPv4 address on this machine');
    process.exit(1);
  }
  const canary = await canaryListeners(ip);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-leak-'));
  const home = path.join(scratch, 'home');
  const runtime = path.join(scratch, 'run');
  const netlogs = path.join(scratch, 'netlog');
  for (const d of [home, runtime, netlogs]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtime, 0o700);

  // Where each platform keeps the normal profile, and where incognito's goes,
  // with every variable the app reads pointed into the scratch directory. Both
  // paths are computed the way the app computes them: a check against a
  // directory the app never uses would pass without testing anything, which
  // is what a Linux-only version of this did on the other two platforms.
  const who = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username;
  const normalProfile = {
    linux: path.join(home, '.config', 'debrowser'),
    darwin: path.join(home, 'Library', 'Application Support', 'debrowser'),
    win32: path.join(home, 'AppData', 'Roaming', 'debrowser')
  }[process.platform];
  const privateRoot = process.platform === 'linux'
    ? path.join(runtime, 'debrowser-incognito')
    : path.join(runtime, `debrowser-incognito-${who}`);

  // A normal profile with something in it, so "untouched" means something.
  fs.mkdirSync(normalProfile, { recursive: true });
  fs.writeFileSync(path.join(normalProfile, 'preferences.json'),
    JSON.stringify({ theme: 'dark', searchEngine: 'mojeek', incognitoJsLevel: 'balanced' }));
  const normalBefore = treeHash(normalProfile);

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_RUNTIME_DIR: runtime,
    // The temp directory is incognito's profile root off Linux.
    TMPDIR: runtime,
    TEMP: runtime,
    TMP: runtime,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    USERPROFILE: home
  };
  for (const key of Object.keys(env)) if (/_proxy$/i.test(key)) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  // As launch.js does for the real thing: the font list is in place before the
  // private browser starts. Not in the normal profile here - that is checked
  // to be byte-for-byte unchanged.
  require('../src/main/incognito/fonts').restrict(path.join(home, 'fonts'), env);

  const electron = require('electron');           // the binary's path, from Node
  const browserArgs = [ROOT, '--incognito', '--smoke-test', '--disable-gpu',
    `--incognito-proxy-port=${stub.base}`,
    `--leak-fixture-port=${fixtures.port}`,
    `--leak-canary=${ip}:${canary.tcpPort}`,
    `--leak-stun=${ip}:${canary.udpPort}`,
    `--leak-netlog-dir=${netlogs}`,
    `--leak-idle-ms=${value('idle-ms', '3000')}`,
    // Decoys for the camouflage check: the fixture, never a real site.
    `--leak-decoys=http://decoy.test:${fixtures.port}/idle.html`,
    `--leak-tls-port=${tls.port || 0}`,
    `--leak-hidden-font=${hiddenFont() || ''}`];
  // The kill-switch run ends through the panic key rather than a normal quit,
  // so both ways out are covered and the panic key is timed.
  if (killSwitch) browserArgs.push('--leak-panic');
  // Root - a container, or the namespace's mapped root - cannot run the sandbox.
  if (typeof process.getuid === 'function' && process.getuid() === 0) browserArgs.push('--no-sandbox');

  // Under the kill switch the browser is started the way the product starts
  // it: through tools/netns-launch, with "Tor" - a stand-in on a Unix socket -
  // outside and the browser in a namespace of its own. No proxy port is
  // given: the browser relays to Tor's socket itself.
  let launch = [electron, browserArgs];
  let firewallCleanup = () => {};
  if (windowsFirewall) {
    const RULE = 'Debrowser private window';
    const target = '1.1.1.1:80';
    // Control: an ordinary process can reach the target, so a failure below
    // is the rule's doing and not a runner with no network.
    const control = await new Promise((resolve) => {
      const s = net.connect(80, '1.1.1.1');
      s.setTimeout(5000, () => { s.destroy(); resolve('timeout'); });
      s.on('connect', () => { s.destroy(); resolve('connected'); });
      s.on('error', (e) => resolve(e.code || e.message));
    });
    check('control: an ordinary process can reach the internet', control === 'connected', `${target}: ${control}`);
    const copy = path.join(path.dirname(electron), 'Debrowser-Incognito.exe');
    try { fs.unlinkSync(copy); } catch { /* not there */ }
    fs.linkSync(electron, copy);
    spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${RULE}`]);
    const added = spawnSync('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${RULE}`, 'dir=out',
      'action=block', `program=${copy}`,
      'remoteip=0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255,::,::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      'profile=any', 'enable=yes'], { encoding: 'utf8' });
    check('the firewall rule can be installed here', added.status === 0, (added.stdout || added.stderr || '').trim());
    firewallCleanup = () => {
      spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${RULE}`]);
      try { fs.unlinkSync(copy); } catch { /* in use or gone */ }
    };
    browserArgs.push(`--leak-canary-node=${target}`);
    launch = [copy, browserArgs];
  }
  const namesFile = path.join(scratch, 'names.txt');
  if (killSwitch) {
    const helper = path.join(ROOT, 'tools', 'netns-launch');
    if (!fs.existsSync(helper)) {
      check('the kill-switch launcher is built', false, 'npm run build:netns');
      process.exit(1);
    }
    fs.mkdirSync(privateRoot, { mode: 0o700 });
    const template = path.join(privateRoot, 'torrc-test');
    fs.writeFileSync(template, require('../src/main/incognito/tor').launcherTemplate(), { mode: 0o600 });
    env.FAKE_TOR_FIXTURE_PORT = String(fixtures.port);
    if (tls.port) env.FAKE_TOR_TLS_PORT = String(tls.port);
    env.FAKE_TOR_NAMES = namesFile;
    const args = browserArgs.filter((a) => !a.startsWith('--incognito-proxy-port='));
    launch = [helper, [privateRoot, path.join(__dirname, 'fake-tor.js'), template, '--', electron, ...args]];
  }

  const headless = process.platform === 'linux' && !process.env.DISPLAY;
  const [cmd, argv] = headless ? ['xvfb-run', ['-a', launch[0], ...launch[1]]] : launch;
  const child = spawn(cmd, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  // A deadline, so a browser that hangs fails the test with its last output
  // instead of holding a CI runner until the job times out hours later - which
  // is what the first macOS run did.
  const deadlineMs = Number(value('idle-ms', '3000')) + 150_000;
  const killer = setTimeout(() => {
    out += `\n[harness] no result after ${Math.round(deadlineMs / 1000)}s; stopping the browser\n`;
    child.kill('SIGKILL');
  }, deadlineMs);
  const code = await new Promise((r) => child.on('exit', r));
  const exitedAt = Date.now();
  clearTimeout(killer);

  const line = out.split('\n').find((l) => l.startsWith('__LEAK__'));
  const report = line ? JSON.parse(line.slice(8)) : null;
  check('the incognito run completed and reported', Boolean(report) && code === 0,
    report ? `exit ${code}` : `exit ${code}; last output:\n${out.split('\n').slice(-40).join('\n')}`);
  if (!report) { canary.close(); stub.close(); await fixtures.close(); process.exit(1); }

  const s = report.steps;
  check('pages load, through the proxy', s.pages.every((p) => p.ok), JSON.stringify(s.pages.map((p) => p.host)));
  check('the tripwire can see this platform\'s sockets', s.tripwire.available === true,
    s.tripwire.mechanism || s.tripwire.reason);

  // What the stand-in for Tor was asked for: only fixture names, and all of them.
  const arrivals = killSwitch
    ? (fs.existsSync(namesFile) ? fs.readFileSync(namesFile, 'utf8').split('\n').filter(Boolean) : [])
      .map((l) => { const [name, slot] = l.split(' '); return { name, slot: Number(slot) }; })
    : stub.seen;
  const asked = arrivals.map((a) => a.name);
  /**
   * The slot - the Tor circuit - a host's page first arrived on. Slot 1 is
   * skipped for every host but `icon`: that is the site's icon, fetched over
   * the icon circuit, and the tab strip can ask for it before the page itself
   * has started (a private tab loads a blank page first, for its fingerprint
   * overrides).
   */
  const slotOf = (host) => (arrivals.find((a) => a.name.startsWith(`${host}.test:`) &&
    (host === 'icon' || a.slot !== 1)) || {}).slot;
  const names = [...new Set(asked.map((h) => h.replace(/:\d+$/, '')))];
  const foreign = names.filter((n) => !n.endsWith('.test'));
  check('every request reached the proxy by name, and only test names were asked for',
    ['t1.test', 'dl.test', 'icon.test', 'rtc.test', 'up.test', 'link.test', 'nc.test'].every((n) => names.includes(n)) &&
      foreign.length === 0,
    `asked for ${names.join(', ')}${foreign.length ? ` — unexpected: ${foreign.join(', ')}` : ''}`);
  check('the favicon route goes through the proxy', asked.some((h) => h.startsWith('icon.test')),
    `route answered ${s.favicon}`);
  check('a download goes through the proxy, into the private downloads folder',
    asked.some((h) => h.startsWith('dl.test')) && s.download.finished && s.download.folder === 'Private downloads',
    JSON.stringify(s.download));

  check('a page cannot reach this machine or its network', Array.isArray(s.localNetwork) &&
    s.localNetwork.length === 4 && s.localNetwork.every((r) => r === 'blocked'), JSON.stringify(s.localNetwork));
  check('plain HTTP is upgraded, and a site without HTTPS is explained rather than loaded',
    s.httpsOnly.explained === true, s.httpsOnly.url || 'no page');
  check('an external protocol link starts nothing', s.externalProtocol.includes('openExternal'),
    `refused: ${JSON.stringify(s.externalProtocol)}`);

  // Circuits, judged by where the requests actually arrived.
  const [t1, t2, link, moved, icon] = ['t1', 't2', 'link', 'nc', 'icon'].map(slotOf);
  check('each private tab uses its own Tor circuit', t1 != null && t2 != null && t1 !== t2,
    `t1 on port ${t1}, t2 on port ${t2}`);
  check('a link opened from a tab shares that tab\'s circuit', link != null && link === t1,
    `link on port ${link}, its opener on ${t1}`);
  check('"new circuit" moves the tab to another circuit', moved != null && moved !== t1,
    `before ${t1}, after ${moved}`);
  check('site icons use a circuit no tab uses', icon === 1 && icon !== t1 && icon !== t2, `icons on port ${icon}`);
  check('"new identity" closes every tab and clears every cookie',
    s.newIdentity && s.newIdentity.tabsAfter === 1 && s.newIdentity.cookiesLeft === 0,
    JSON.stringify(s.newIdentity));

  // A site refusing Tor: each attempt on a fresh circuit, then a stop. Slot 1
  // is left out: that is the site's icon, fetched on the icon circuit.
  const slotsOf = (host) => [...new Set(arrivals.filter((a) => a.name.startsWith(`${host}.test:`) && a.slot !== 1)
    .map((a) => a.slot))];
  const ch = slotsOf('ch');
  const chx = slotsOf('chx');
  check('a page that refuses Tor is retried on new circuits until it loads',
    s.blocked.passed === true && ch.length === 3, `loaded: ${s.blocked.title}; attempts on ports ${ch.join(', ')}`);
  check('a page that always refuses stops after three new circuits, and the window says so',
    s.blocked.refused === true && s.blocked.shown === true && chx.length === 4,
    `refused: ${s.blocked.refused}, shown: ${s.blocked.shown}; attempts on ports ${chx.join(', ')}`);

  // Fingerprint: every surface says the same thing, and what it should.
  const f = s.fingerprint;
  const want = f.expected;
  const surfaceOk = (r) => r && r.ua === want.userAgent && r.tz === want.timezone && r.locale === want.locale &&
    r.langs === want.languages && r.cores === want.cores && r.sharedWorker === false &&
    (r.brands === null || r.brands.includes(`Chromium/${want.major}`));
  const fs3 = f.surfaces || {};
  const badSurfaces = ['page', 'dedicated'].filter((k) => !surfaceOk(fs3[k]));
  const fr = fs3.frame;
  if (!(fr && fr.tz === want.timezone && fr.cores === want.cores && fr.sharedWorker === false)) badSurfaces.push('cross-site frame');
  check('a site reads the same user agent, time zone, language and core count from the page, a worker and a cross-site frame',
    Boolean(f.surfaces) && badSurfaces.length === 0,
    badSurfaces.length ? `differs in ${badSurfaces.join(', ')}: ${JSON.stringify(badSurfaces.map((k) => fs3[k]))}` : `${want.userAgent}, ${want.timezone}, ${want.languages}, ${want.cores} cores`);
  const h = (fs3.headers || {});
  check('the request headers say the same, with no Electron or Debrowser token',
    h['user-agent'] === want.userAgent &&
      h['accept-language'] === (want.languages === 'en-US' ? 'en-US' : 'en-US,en;q=0.9') &&
      !/Electron|Debrowser/i.test(JSON.stringify(h)),
    JSON.stringify(h));
  check('the page is letterboxed, and the screen it reports is its own size',
    f.bounds.width % 200 === 0 && f.bounds.height % 100 === 0 && fs3.screen === fs3.viewport && fs3.webgl === false,
    `page ${f.bounds.width}x${f.bounds.height}, screen ${fs3.screen}, viewport ${fs3.viewport}, WebGL ${fs3.webgl}`);
  const [p1, p2] = fs3.prints || [];
  const other = f.otherTabPrint;
  check('canvas and audio fingerprints stay the same within a tab and differ between tabs',
    Boolean(p1 && p2 && other) && p1.canvas === p2.canvas && p1.audio === p2.audio &&
      p1.canvas !== other.canvas && p1.audio !== other.audio,
    JSON.stringify({ tab: p1, again: p2, otherTab: other }));
  check('the startup self-check ran and found nothing',
    Boolean(f.audit) && !f.audit.error && f.audit.checked > 0 && f.audit.problems.length === 0,
    JSON.stringify(f.audit));
  check('taking the debugger away does not take the overrides with it',
    f.reattached === true && f.afterDetach && f.afterDetach.screen === f.afterDetach.viewport,
    `reattached ${f.reattached}; after: ${JSON.stringify(f.afterDetach)}`);

  const u = s.upload || {};
  check('a photo picked for upload reaches the page without its GPS data, pixels unchanged',
    u.sentHadGps === true && u.receivedHasGps === false && u.samePixels === true && u.exactlyTheCleanCopy === true &&
      u.name === 'holiday.jpg',
    JSON.stringify(u));

  const sc = s.safeCopy || {};
  const had = sc.originalHad || {};
  const has = sc.copyHas || {};
  check('a PDF\'s safe copy keeps both pages and drops its script, form, link and author',
    !sc.error && sc.pages === 2 && had.js && had.form && had.uri && had.author &&
      !has.js && !has.form && !has.uri && !has.author,
    sc.error || `${sc.pages} pages in ${sc.ms} ms; original ${JSON.stringify(had)}, copy ${JSON.stringify(has)}`);

  const fo = s.fonts || {};
  if (process.platform === 'linux' && fo.font) {
    check('fonts installed on this computer but not on the list are invisible to pages',
      fo.restricted && fo.restricted.available && fo.withFont === fo.fallback && fo.allowed !== fo.fallback &&
        Object.values(fo.survey || {}).every((w) => w === fo.fallback),
      `${fo.font}: ${fo.withFont} vs fallback ${fo.fallback} (an allowed font: ${fo.allowed}) ${JSON.stringify(fo.survey || {})}`);
  } else {
    console.log(`  NOTE  fonts not checked: ${fo.skipped || (fo.restricted && fo.restricted.reason) || 'not Linux'}`);
  }

  const refs = s.referrers || {};
  check('a Referer is kept within a site and dropped between sites',
    /^http:\/\/ref\.test/.test(String(refs.sameSite)) && refs.crossSite === null, JSON.stringify(refs));
  const dr = s.dropped || {};
  const cleanArrival = (r) => r && r.gps === false && r.samePixels === true && r.freshTimestamp === true;
  check('a photo dropped or pasted onto a page arrives without its GPS data or its timestamp',
    cleanArrival(dr.drop) && cleanArrival(dr.paste), JSON.stringify(dr));

  const cert = s.badCertificate || {};
  check('a site with a certificate nobody vouches for is refused, with no way past it',
    tls.port > 0 && cert.shown === false && /CERT/.test(String(cert.error)) && cert.proceedOffered === false,
    tls.port ? JSON.stringify(cert) : `no test certificate: ${tls.reason}`);

  const camo = s.camouflage || {};
  const decoySlots = slotsOf('decoy');
  const [cam1, cam2] = ['cam1', 'cam2'].map(slotOf);
  check('camouflage: one decoy per page load, on another circuit - and none when it is off',
    camo.firedWhileOn === 2 && camo.firedWhileOff === 0 && decoySlots.length === 2 &&
      !decoySlots.includes(cam1) && !decoySlots.includes(cam2),
    `decoys ${camo.firedWhileOn} on, ${camo.firedWhileOff} off; decoys on ports ${decoySlots.join(', ')}, pages on ${cam1}, ${cam2}`);

  // Onion-Location: honoured from HTTPS pages only, and only for onion addresses.
  const policy = require('../src/main/incognito/policy');
  const onionCases = [
    policy.onionFrom('https://example.com/', { 'onion-location': ['http://abcdefghijklmnop.onion/a'] }) === 'http://abcdefghijklmnop.onion/a',
    policy.onionFrom('http://example.com/', { 'Onion-Location': ['http://abcdefghijklmnop.onion/'] }) === null,
    policy.onionFrom('https://example.com/', { 'Onion-Location': ['https://evil.example/'] }) === null
  ];
  check('Onion-Location is followed from HTTPS pages only, and only to an onion address', onionCases.every(Boolean),
    JSON.stringify(onionCases));

  const exposing = (s.webrtc || []).filter((c) => /^(host|srflx|prflx)$/.test(c));
  check('WebRTC offers no candidate that names this machine', exposing.length === 0,
    `candidates: ${JSON.stringify(s.webrtc)}`);

  const clean = readNetLog(path.join(netlogs, 'clean.json'), report.proxyPort);
  check('Chromium\'s network log shows every socket going to Tor\'s ports, and no UDP sent',
    clean.offenders.length === 0 && clean.proxied > 0,
    `${clean.proxied} to the proxy${clean.offenders.length ? `; OFFENDERS: ${clean.offenders.slice(0, 8).join(', ')}` : ''}`);
  if (clean.udpProbes.length) console.log(`  NOTE  UDP sockets connected but never sent (Chromium's IPv6 reachability probe): ${clean.udpProbes.join(', ')}`);
  if (clean.background.length) console.log(`  NOTE  Chromium's network-quality estimator probed, and the resolver rules refused it: ${clean.background.join(', ')}`);

  check('the STUN server heard nothing and nothing connected directly during normal browsing',
    // Checks must actually have happened: zero trips over zero checks is a
    // tripwire that was not running, which is how the first version passed.
    s.tripwireDuringCleanRun.trips === 0 && s.tripwireDuringCleanRun.checks > 0 && canary.hits.udp === 0,
    `tripwire trips ${s.tripwireDuringCleanRun.trips} over ${s.tripwireDuringCleanRun.checks} checks, STUN packets ${canary.hits.udp}`);

  // The canaries.
  const leaked = readNetLog(path.join(netlogs, 'canary.json'), report.proxyPort);
  if (flag('verbose')) {
    console.log(`  info  canary fetch: ${JSON.stringify(s.canaryChromium)}; listener hits ${JSON.stringify(canary.hits)}`);
    console.log(`  info  proxy asked for: ${asked.join(', ')}`);
    console.log(`  info  canary netlog: ${JSON.stringify(leaked)}`);
  }
  check('canary: the network log flags a deliberate direct connection',
    leaked.offenders.some((o) => o.includes(`127.0.0.1:${canary.tcpPort}`)),
    leaked.offenders.slice(0, 4).join(', ') || 'nothing flagged');
  if (windowsFirewall) {
    check('kill switch: Windows reports the firewall rule covering this executable', s.killSwitch.available === true,
      s.killSwitch.mechanism || s.killSwitch.reason);
    check('kill switch: a real outbound connection from the private browser is refused by Windows',
      !s.canaryNode.connected && Boolean(s.canaryNode.error), `connect: ${s.canaryNode.error || 'connected'}`);
    firewallCleanup();
  } else if (killSwitch) {
    // The wall, not the detectors: from inside, the canary's address does not
    // exist, and nothing the browser did reached the listener at all.
    check('kill switch: the browser runs in a network namespace', s.killSwitch.available === true,
      s.killSwitch.mechanism || s.killSwitch.reason);
    check('kill switch: a direct connection from inside fails at the kernel',
      !s.canaryNode.connected && /UNREACH/.test(String(s.canaryNode.error)) && canary.hits.tcp === 0,
      `connect: ${s.canaryNode.error || 'connected'}; canary listener hits ${canary.hits.tcp}`);
  } else {
    check('canary: the tripwire catches a deliberate direct socket',
      s.canaryNode.caught === true, JSON.stringify(s.canaryNode.violations.slice(0, 2)));
  }

  // Amnesia.
  // The reaper deletes it after the process has fully ended, so give it a moment.
  for (let i = 0; i < 30 && fs.existsSync(privateRoot); i++) await new Promise((r) => setTimeout(r, 100));
  const panicLine = /__PANIC__(\d+)/.exec(out);
  if (panicLine) {
    // Measured from the panic to the profile being gone - the reaper waits for
    // the process to end, so this covers both.
    const panickedAt = Number(panicLine[1]);
    const goneAt = fs.existsSync(privateRoot) ? null : Date.now();
    const survivors = process.platform === 'linux'
      ? require('child_process').spawnSync('pgrep', ['-f', privateRoot], { encoding: 'utf8' }).stdout.trim()
      : '';
    check('the panic key: the browser and Tor gone at once, the private profile within a second or so',
      exitedAt - panickedAt < 1000 && goneAt !== null && goneAt - panickedAt < 2000 && survivors === '',
      `process gone after ${exitedAt - panickedAt} ms, profile ${goneAt ? `after ${goneAt - panickedAt} ms` : 'still there'}` +
        (survivors ? `; still running: ${survivors.split('\n').length} process(es)` : ''));
  }
  check('the private profile is gone after exit', !fs.existsSync(privateRoot),
    fs.existsSync(privateRoot) ? `left: ${fs.readdirSync(privateRoot).join(', ')}` : privateRoot);
  const normalAfter = treeHash(normalProfile);
  check('the normal profile is byte-for-byte unchanged', normalAfter === normalBefore, `${normalBefore} -> ${normalAfter}`);

  canary.close();
  stub.close();
  await fixtures.close();
  if (flag('keep')) console.log(`  info  kept ${scratch}`);
  else fs.rmSync(scratch, { recursive: true, force: true });

  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== ${results.length - failed.length}/${results.length} leak checks passed ===\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
