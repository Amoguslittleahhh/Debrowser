'use strict';

/**
 * Bridges: what makes Tor look like something else to the ISP.
 *
 * Plain Tor hides which sites you visit but not that you use Tor - the relays
 * are a public list. A bridge is an unlisted entry point, and a pluggable
 * transport disguises the connection to it: obfs4 as random bytes, Snowflake as
 * a WebRTC call through volunteers' browsers, WebTunnel as ordinary HTTPS to a
 * real website. They come from the Tor Expert Bundle, which also carries the
 * Tor Project's own built-in bridge lines (pt_config.json) - nothing here
 * fetches bridges from anywhere.
 *
 *   auto    every built-in obfs4 and Snowflake bridge at once. Tor tries them
 *           all and uses whichever connect, which is the racing: no transport
 *           waits for another to time out first.
 *   custom  the user's own lines - a bridge of their own from the bridge kit
 *           (tools/bridge-kit), which is the only kind no list contains.
 *   none    plain Tor: fastest, and the ISP can see that it is Tor.
 *
 * Built-in bridges are published, so an ISP that matches addresses against the
 * list can still tell. That is said in the UI rather than left implied.
 */

const fs = require('fs');
const path = require('path');

/** Transports this browser ships a client for. Conjure is left out of the bundle. */
const TRANSPORTS = ['obfs4', 'webtunnel', 'snowflake', 'meek_lite'];

/** The bundle's own transport config, or null if it is not there. */
function ptConfig(bundle) {
  try {
    return JSON.parse(fs.readFileSync(path.join(bundle, 'pluggable_transports', 'pt_config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * One bridge line, checked: the transport first, then an address with a port.
 * Anything else is refused rather than handed to Tor, which would otherwise
 * be given whatever was pasted - including a torrc option on its own line.
 */
function parseLine(raw) {
  const line = String(raw).trim().replace(/^Bridge\s+/i, '');
  if (!line || line.startsWith('#')) return null;
  const [transport, address] = line.split(/\s+/);
  if (!TRANSPORTS.includes(transport)) return { error: `unknown transport "${transport}"`, line };
  if (!/^(\[[0-9a-f:]+\]|[\w.-]+):\d{1,5}$/i.test(address || '')) return { error: 'no address:port', line };
  if (/[\r\n]/.test(line)) return { error: 'more than one line', line };
  return { transport, line };
}

/** The user's pasted lines, split into what Tor gets and what was refused. */
function parseCustom(text) {
  const good = [];
  const bad = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.error) bad.push(parsed);
    else good.push(parsed);
  }
  return { good, bad };
}

/**
 * The torrc lines for a bridge mode.
 *
 * Transport programs are named relative to Tor's working directory - the
 * bundle - because torrc splits on spaces and "C:\Program Files" would break an
 * absolute path in two.
 */
function torrcLines({ mode = 'auto', custom = '' } = {}, bundle) {
  if (mode === 'none') return [];
  const config = ptConfig(bundle);
  const bridges = mode === 'custom'
    ? parseCustom(custom).good
    : ['obfs4', 'snowflake']
      .flatMap((t) => ((config && config.bridges && config.bridges[t]) || []).map((line) => ({ transport: t, line })));
  if (!bridges.length) return [];

  const exe = process.platform === 'win32' ? '.exe' : '';
  const plugin = `pluggable_transports${path.sep}lyrebird${exe}`;
  const used = [...new Set(bridges.map((b) => b.transport))];
  return [
    'UseBridges 1',
    // lyrebird carries every transport this browser uses, Snowflake included.
    `ClientTransportPlugin ${used.join(',')} exec ${plugin}`,
    ...bridges.map((b) => `Bridge ${b.line}`)
  ];
}

/** Which transport a bridge fingerprint belongs to, for saying what connected. */
function transportFor(fingerprint, lines) {
  const fp = String(fingerprint || '').replace(/^\$/, '').split(/[~=]/)[0].toUpperCase();
  if (!fp) return null;
  for (const line of lines) {
    if (!line.startsWith('Bridge ')) continue;
    if (line.toUpperCase().includes(fp)) return line.split(/\s+/)[1];
  }
  return null;
}

module.exports = { TRANSPORTS, ptConfig, parseLine, parseCustom, torrcLines, transportFor };
