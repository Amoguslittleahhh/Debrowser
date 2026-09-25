'use strict';

/**
 * The bundled Tor, on the real Tor network - what the leak test's stand-in
 * cannot show.
 *
 *   node test/real-tor.js [--direct] [--bridges] [--bridge-line "<line>"]
 *
 * For each mode asked for (all of them when none is), starts the bundled Tor
 * with the torrc the browser itself builds, waits for it to bootstrap, and
 * asks check.torproject.org through it whether the request arrived over Tor.
 *
 *   --direct       plain Tor, no bridges
 *   --bridges      the built-in bridges, raced - the browser's default
 *   --obfs4, --snowflake  the built-in bridges of that transport alone
 *   --bridge-line  one bridge of your own, as Settings takes it (the CI job
 *                  passes the line tools/bridge-kit/setup-bridge.sh printed)
 *
 * Needs a network that can reach Tor, so it runs in CI and on real machines,
 * not in the container this project is built in. Exits 1 if any mode failed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { spawn } = require('child_process');
const { baseConfig, bundleDir } = require('../src/main/incognito/tor');
const bridges = require('../src/main/incognito/bridges');

const BOOTSTRAP_MS = Number(process.env.REAL_TOR_TIMEOUT_MS) || 300_000;
const exe = process.platform === 'win32' ? 'tor.exe' : 'tor';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Start Tor with `extra` torrc lines; resolve once it reports 100%. */
async function startTor(label, extra) {
  const bundle = bundleDir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-tor-'));
  const port = await freePort();
  const torrc = path.join(dir, 'torrc');
  fs.writeFileSync(torrc, baseConfig({
    dir, socks: [`127.0.0.1:${port}`], control: 'auto', owner: process.pid, extra
  }).join('\n'));
  const child = spawn(path.join(bundle, exe), ['-f', torrc], {
    cwd: bundle,
    env: { ...process.env, LD_LIBRARY_PATH: bundle },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  const started = Date.now();
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), BOOTSTRAP_MS);
    const onData = (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        log.push(line);
        const m = /Bootstrapped (\d+)%/.exec(line);
        if (m) console.log(`  ${label}: ${line.replace(/^.*\[notice\] /, '')}`);
        if (m && m[1] === '100') { clearTimeout(timer); resolve(true); }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => { clearTimeout(timer); resolve(false); });
  });
  return { child, port, dir, ready, seconds: Math.round((Date.now() - started) / 1000), log };
}

/** GET https://host/path through a SOCKS5 proxy on 127.0.0.1:port. */
function getViaSocks(port, host, urlPath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.setTimeout(60_000, () => { sock.destroy(); reject(new Error('timed out')); });
    sock.once('error', reject);
    sock.once('connect', () => sock.write(Buffer.from([5, 1, 0])));
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    sock.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet' && buf.length >= 2) {
        if (buf[1] !== 0) { reject(new Error('SOCKS refused the greeting')); return; }
        buf = buf.subarray(2);
        const name = Buffer.from(host);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([1, 187])]));
        stage = 'connect';
      }
      if (stage === 'connect' && buf.length >= 10) {
        if (buf[1] !== 0) { reject(new Error(`SOCKS connect failed (${buf[1]})`)); return; }
        sock.removeListener('data', onData);
        const secure = tls.connect({ socket: sock, servername: host }, () => {
          secure.write(`GET ${urlPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: debrowser-test\r\n\r\n`);
        });
        let res = '';
        secure.on('data', (d) => { res += d; });
        secure.on('end', () => resolve(res.split('\r\n\r\n').slice(1).join('\r\n\r\n')));
        secure.on('error', reject);
      }
    });
  });
}

async function check(label, extra) {
  console.log(`\n${label}`);
  const tor = await startTor(label, extra);
  let result = { label, bootstrapped: tor.ready, seconds: tor.seconds, isTor: false };
  try {
    if (tor.ready) {
      // Asked up to three times: a fresh circuit's first request can come
      // back empty, which says nothing about whether the connection is Tor.
      let lastError = null;
      for (let attempt = 0; attempt < 3 && !result.isTor; attempt++) {
        try {
          const body = await getViaSocks(tor.port, 'check.torproject.org', '/api/ip');
          const json = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
          result = { ...result, isTor: json.IsTor === true };
        } catch (err) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (!result.isTor && lastError) throw lastError;
    } else {
      console.log(tor.log.slice(-15).map((l) => `    ${l}`).join('\n'));
    }
  } catch (err) {
    result.error = err.message;
  } finally {
    tor.child.kill();
    // Tor holds a lock file for a moment after it is told to go, and Windows
    // will not delete a file that is open: retried, and never fatal - a temp
    // directory left behind is not a failed test.
    try { fs.rmSync(tor.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* left */ }
  }
  console.log(`  ${result.isTor ? 'PASS' : 'FAIL'}  ${label}: bootstrapped ${result.bootstrapped} in ${result.seconds}s, ` +
    `IsTor ${result.isTor}${result.error ? ` (${result.error})` : ''}`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const all = !args.some((a) => a.startsWith('--'));
  const lineAt = args.indexOf('--bridge-line');
  const results = [];
  if (all || args.includes('--direct')) results.push(await check('plain Tor', []));
  if (all || args.includes('--bridges')) {
    results.push(await check('the default: built-in Snowflake', bridges.torrcLines({ mode: 'auto' }, bundleDir())));
  }
  // Each built-in transport on its own, so a failure says which one.
  for (const transport of ['obfs4', 'snowflake']) {
    if (!args.includes(`--${transport}`)) continue;
    results.push(await check(`built-in ${transport} bridges only`, bridges.torrcLines({ mode: transport }, bundleDir())));
  }
  if (lineAt >= 0) {
    const lines = bridges.torrcLines({ mode: 'custom', custom: args[lineAt + 1] || '' }, bundleDir());
    if (!lines.length) {
      console.log('  FAIL  your own bridge: the line was not accepted');
      results.push({ isTor: false });
    } else {
      results.push(await check('a bridge of your own (from the bridge kit)', lines));
    }
  }
  const failed = results.filter((r) => !r.isTor).length;
  console.log(`\n=== ${results.length - failed}/${results.length} reached the Tor network ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
