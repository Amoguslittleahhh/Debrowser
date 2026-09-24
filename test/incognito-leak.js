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

/* ------------------------------------------------------------------ */
/* The stand-in for Tor                                                */
/* ------------------------------------------------------------------ */

/**
 * A SOCKS5 server that records every destination it is asked for and connects
 * the `*.test` ones to the fixture server. Anything else is refused - the test
 * never asks for anything else, so a name outside `.test` is itself a finding.
 */
function socksStub(fixturePort) {
  const seen = [];
  const server = net.createServer((client) => {
    client.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 'greet';
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        buf = buf.subarray(2 + buf[1]);
        client.write(Buffer.from([5, 0]));
        stage = 'request';
      }
      if (stage !== 'request' || buf.length < 5) return;
      const atyp = buf[3];
      let host;
      let len;
      if (atyp === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); len = 10; }
      else if (atyp === 3) { const n = buf[4]; if (buf.length < 7 + n) return; host = buf.subarray(5, 5 + n).toString(); len = 7 + n; }
      else if (atyp === 4) { if (buf.length < 22) return; host = '[ipv6]'; len = 22; }
      else { client.destroy(); return; }
      const port = buf.readUInt16BE(len - 2);
      const rest = buf.subarray(len);
      stage = 'done';
      client.removeListener('data', onData);
      seen.push(`${host}:${port}`);
      if (!/\.test$/.test(host)) {
        client.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));   // host unreachable
        return;
      }
      const upstream = net.connect(fixturePort, '127.0.0.1', () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
    };
    client.on('data', onData);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ port: server.address().port, seen, close: () => server.close() })));
}

/** Where a "direct" connection would go: somewhere that is not loopback. */
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
      if (p.address === `127.0.0.1:${proxyPort}`) proxied++;
      else offenders.push(`tcp ${p.address}`);
    } else if (type === 'UDP_CONNECT' && p.address) {
      offenders.push(`udp ${p.address}`);
    } else if ((type === 'HOST_RESOLVER_DNS_TASK' || type === 'HOST_RESOLVER_SYSTEM_TASK') && e.phase === 1) {
      offenders.push(`dns sent (${source})`);
    } else if (type === 'HOST_RESOLVER_MANAGER_REQUEST' && p.host) {
      const host = hostOf(p.host);
      if (host === '127.0.0.1') continue;
      if (source === 'NETWORK_QUALITY_ESTIMATOR') background.add(host);
      else offenders.push(`local lookup for ${urls.get(e.source?.id) || host} (${source})`);
    }
  }
  return { offenders, background: [...background], proxied };
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
  const results = [];
  const check = (name, passed, detail = '') => {
    results.push({ name, passed });
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  console.log(`\nIncognito leak test${inNamespace ? ' (inside a network namespace: loopback only)' : ''}\n`);

  const fixtures = await require('../src/main/fixture-server').start();
  const stub = await socksStub(fixtures.port);
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

  const electron = require('electron');           // the binary's path, from Node
  const browserArgs = [ROOT, '--incognito', '--smoke-test', '--disable-gpu',
    `--incognito-proxy-port=${stub.port}`,
    `--leak-fixture-port=${fixtures.port}`,
    `--leak-canary=${ip}:${canary.tcpPort}`,
    `--leak-stun=${ip}:${canary.udpPort}`,
    `--leak-netlog-dir=${netlogs}`,
    `--leak-idle-ms=${value('idle-ms', '3000')}`];
  // Root - a container, or the namespace's mapped root - cannot run the sandbox.
  if (typeof process.getuid === 'function' && process.getuid() === 0) browserArgs.push('--no-sandbox');

  const headless = process.platform === 'linux' && !process.env.DISPLAY;
  const [cmd, argv] = headless ? ['xvfb-run', ['-a', electron, ...browserArgs]] : [electron, browserArgs];
  const child = spawn(cmd, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('exit', r));

  const line = out.split('\n').find((l) => l.startsWith('__LEAK__'));
  const report = line ? JSON.parse(line.slice(8)) : null;
  check('the incognito run completed and reported', Boolean(report) && code === 0,
    report ? `exit ${code}` : `exit ${code}; last output:\n${out.split('\n').slice(-15).join('\n')}`);
  if (!report) { canary.close(); stub.close(); await fixtures.close(); process.exit(1); }

  const s = report.steps;
  check('pages load, through the proxy', s.pages.every((p) => p.ok), JSON.stringify(s.pages.map((p) => p.host)));
  check('the tripwire can see this platform\'s sockets', s.tripwire.available === true,
    s.tripwire.mechanism || s.tripwire.reason);

  // What the stand-in for Tor was asked for: only fixture names, and all of them.
  const names = [...new Set(stub.seen.map((h) => h.replace(/:\d+$/, '')))];
  const foreign = names.filter((n) => !n.endsWith('.test'));
  check('every request reached the proxy by name, and only test names were asked for',
    ['t1.test', 'dl.test', 'icon.test', 'rtc.test', 'up.test'].every((n) => names.includes(n)) && foreign.length === 0,
    `asked for ${names.join(', ')}${foreign.length ? ` — unexpected: ${foreign.join(', ')}` : ''}`);
  check('the favicon route goes through the proxy', stub.seen.some((h) => h.startsWith('icon.test')),
    `route answered ${s.favicon}`);
  check('a download goes through the proxy', stub.seen.some((h) => h.startsWith('dl.test')) && s.download.finished,
    JSON.stringify(s.download));

  check('a page cannot reach this machine or its network', Array.isArray(s.localNetwork) &&
    s.localNetwork.length === 4 && s.localNetwork.every((r) => r === 'blocked'), JSON.stringify(s.localNetwork));
  check('plain HTTP is upgraded, and a site without HTTPS is explained rather than loaded',
    s.httpsOnly.explained === true, s.httpsOnly.url || 'no page');
  check('an external protocol link starts nothing', s.externalProtocol.includes('openExternal'),
    `refused: ${JSON.stringify(s.externalProtocol)}`);

  const exposing = (s.webrtc || []).filter((c) => /^(host|srflx|prflx)$/.test(c));
  check('WebRTC offers no candidate that names this machine', exposing.length === 0,
    `candidates: ${JSON.stringify(s.webrtc)}`);

  const clean = readNetLog(path.join(netlogs, 'clean.json'), report.proxyPort);
  check('Chromium\'s network log shows every socket going to the proxy, and no UDP',
    clean.offenders.length === 0 && clean.proxied > 0,
    `${clean.proxied} to the proxy${clean.offenders.length ? `; OFFENDERS: ${clean.offenders.slice(0, 8).join(', ')}` : ''}`);
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
    console.log(`  info  proxy asked for: ${stub.seen.join(', ')}`);
    console.log(`  info  canary netlog: ${JSON.stringify(leaked)}`);
  }
  check('canary: the network log flags a deliberate direct connection',
    leaked.offenders.some((o) => o.includes(`127.0.0.1:${canary.tcpPort}`)),
    leaked.offenders.slice(0, 4).join(', ') || 'nothing flagged');
  check('canary: the tripwire catches a deliberate direct socket',
    s.canaryNode.caught === true, JSON.stringify(s.canaryNode.violations.slice(0, 2)));

  // Amnesia.
  // The reaper deletes it after the process has fully ended, so give it a moment.
  for (let i = 0; i < 30 && fs.existsSync(privateRoot); i++) await new Promise((r) => setTimeout(r, 100));
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
