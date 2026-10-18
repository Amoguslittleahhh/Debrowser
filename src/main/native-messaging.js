'use strict';

/**
 * Native messaging: an extension talking to a program on the computer
 * (`chrome.runtime.connectNative`, `sendNativeMessage`), as Chrome does it.
 *
 * The program is found by its host manifest, looked for in Debrowser's own
 * folder first and then where Chrome, Chromium, Edge and Brave keep theirs, so
 * a program that set itself up for Chrome - Claude Code, the Claude app, a
 * password manager - works here without being told about Debrowser. Its
 * `allowed_origins` must name the extension, as in Chrome. It is started with
 * the extension's origin as its argument and spoken to over stdin and stdout,
 * each message a 32-bit length then JSON.
 *
 * Programs that name the computer to the extension (Claude's hosts answer a
 * status request with `computer_name`, which Claude shows in its list of
 * browsers) are told "(Debrowser)" after it, so with Chrome and Debrowser on
 * one computer the two can be told apart and either one chosen.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const MAX_IN = 1024 * 1024;
const BROWSER_TAG = ' (Debrowser)';

/** The folders a host manifest may be in, Debrowser's own first. */
function manifestDirs(own) {
  const home = os.homedir();
  const list = own ? [path.join(own, 'NativeMessagingHosts')] : [];
  if (process.platform === 'darwin') {
    const lib = path.join(home, 'Library', 'Application Support');
    for (const b of ['Google/Chrome', 'Chromium', 'Microsoft Edge', 'BraveSoftware/Brave-Browser']) list.push(path.join(lib, b, 'NativeMessagingHosts'));
    list.push('/Library/Google/Chrome/NativeMessagingHosts', '/Library/Application Support/Chromium/NativeMessagingHosts');
  } else if (process.platform !== 'win32') {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const b of ['google-chrome', 'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser']) list.push(path.join(config, b, 'NativeMessagingHosts'));
    list.push('/etc/opt/chrome/native-messaging-hosts', '/etc/chromium/native-messaging-hosts');
  }
  return list;
}

/** Windows keeps the manifest's path in the registry. */
const REG_KEYS = ['Google\\Chrome', 'Chromium', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser'];
function registryManifest(name) {
  for (const root of ['HKCU', 'HKLM']) {
    for (const key of ['Debrowser', ...REG_KEYS]) {
      try {
        const out = execFileSync('reg', ['query', `${root}\\Software\\${key}\\NativeMessagingHosts\\${name}`, '/ve'],
          { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const m = /REG_SZ\s+(.+)\s*$/m.exec(out);
        if (m) return m[1].trim();
      } catch { /* not under this key */ }
    }
  }
  return null;
}

/**
 * A host's manifest and where it is, if it lets `origin` in; or why not.
 * @returns {{ manifest: object, file: string } | { error: string }}
 */
function findHost(name, origin, own) {
  if (!NAME.test(String(name || ''))) return { error: 'Invalid native messaging host name specified.' };
  const files = process.platform === 'win32' ? [path.join(own || '', 'NativeMessagingHosts', `${name}.json`), registryManifest(name)]
    : manifestDirs(own).map((d) => path.join(d, `${name}.json`));
  for (const file of files.filter(Boolean)) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!manifest || manifest.name !== name || manifest.type !== 'stdio' || typeof manifest.path !== 'string') continue;
    if (!(manifest.allowed_origins || []).includes(origin)) return { error: 'Access to the specified native messaging host is forbidden.' };
    return { manifest, file };
  }
  return { error: 'Specified native messaging host not found.' };
}

function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** "My-PC" as "My-PC (Debrowser)", once. */
function tagged(msg) {
  if (msg && typeof msg === 'object' && typeof msg.computer_name === 'string' && !msg.computer_name.endsWith(BROWSER_TAG)) {
    return { ...msg, computer_name: `${msg.computer_name}${BROWSER_TAG}` };
  }
  return msg;
}

class NativeHosts {
  /** @param {{ own?: string }} opts own: Debrowser's profile folder */
  constructor({ own } = {}) {
    this.own = own || null;
    this.ports = new Map();
  }

  /**
   * Start a host for one port of an extension. `onMessage(msg)` for each
   * message from it, `onGone(error)` once when it ends.
   */
  connect(key, owner, name, origin, onMessage, onGone) {
    this.disconnect(key);
    const found = findHost(name, origin, this.own);
    if (found.error) { onGone(found.error); return false; }
    const { manifest, file } = found;
    const exe = path.isAbsolute(manifest.path) ? manifest.path : path.join(path.dirname(file), manifest.path);
    let child;
    try {
      child = process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${exe}" ${origin} --parent-window=0"`],
          { windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
        : spawn(exe, [origin], { stdio: ['pipe', 'pipe', 'ignore'], cwd: path.dirname(exe) });
    } catch { onGone('Failed to start native messaging host.'); return false; }
    const port = { child, owner, gone: false };
    this.ports.set(key, port);
    let buf = Buffer.alloc(0);
    const end = (error) => {
      if (port.gone) return;
      port.gone = true;
      if (this.ports.get(key) === port) this.ports.delete(key);
      try { child.kill(); } catch { /* gone */ }
      onGone(error || null);
    };
    child.on('error', () => end('Failed to start native messaging host.'));
    child.on('exit', () => end('Native host has exited.'));
    child.stdin.on('error', () => end('Error when communicating with the native messaging host.'));
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (len > MAX_IN) { end('Error when communicating with the native messaging host.'); return; }
        if (buf.length < 4 + len) break;
        let msg;
        try { msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')); } catch { end('Error when communicating with the native messaging host.'); return; }
        buf = buf.subarray(4 + len);
        onMessage(tagged(msg));
      }
    });
    return true;
  }

  post(key, msg) {
    const port = this.ports.get(key);
    if (!port || port.gone) return false;
    try { port.child.stdin.write(frame(msg)); } catch { return false; }
    return true;
  }

  disconnect(key) {
    const port = this.ports.get(key);
    if (!port) return;
    this.ports.delete(key);
    port.gone = true;
    try { port.child.kill(); } catch { /* gone */ }
  }

  /** Every port an extension (or, with no id, anyone) has open. */
  closeAll(owner) {
    for (const [key, port] of [...this.ports]) if (!owner || port.owner === owner) this.disconnect(key);
  }
}

module.exports = { NativeHosts, findHost, frame, tagged, manifestDirs };
