'use strict';

/**
 * Native messaging (native-messaging.js): an extension's page talking to a
 * program on the computer through a host manifest, as Claude in Chrome talks
 * to Claude Code and the Claude app. A port and a one-off message both reach
 * the program and come back; a host that does not name the extension, or
 * none at all, is refused; and the computer's name the program reports comes
 * back marked as Debrowser's, so Chrome and Debrowser on one computer are two
 * browsers to choose between rather than two of the same name.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { tagged, frame, findHost } = require('../../native-messaging');
const { permissionWarnings } = require('../../extensions');

const FIXTURE = path.join(__dirname, '..', '..', '..', '..', 'test', 'extensions', 'chrome-native');

module.exports = async function nativeMessagingFeature(t) {
  const { check, waitFor, tabs, prefs, runCommand } = t;

  // The pure parts.
  check('Native: the computer\'s name is marked as Debrowser\'s, once',
    tagged({ type: 'status_response', computer_name: 'PC' }).computer_name === 'PC (Debrowser)' &&
    tagged(tagged({ computer_name: 'PC' })).computer_name === 'PC (Debrowser)' && tagged({ a: 1 }).a === 1);
  const f = frame({ a: 1 });
  check('Native: a message is its length, then JSON', f.readUInt32LE(0) === 7 && f.subarray(4).toString() === '{"a":1}');
  check('Native: a host name that is not one is refused', /Invalid/.test(findHost('../x', 'chrome-extension://a/', null).error));
  const words = permissionWarnings({ permissions: ['nativeMessaging', 'storage'], content_scripts: [{ matches: ['<all_urls>'] }] });
  check('Extensions: what one may do is put into words before it is added',
    words.includes('Read and change all your data on all websites') && words.includes('Communicate with cooperating native applications') && words.length === 2,
    JSON.stringify(words));

  if (process.platform === 'win32') { check('Native: end to end (not on Windows in this test)', true); return; }
  const ext = t.getExtensions && t.getExtensions();
  if (!ext) { check('Native: extensions available', false, 'no extensions'); return; }
  const wasOn = prefs.get('extensions');
  runCommand('set-pref', { key: 'extensions', value: true });
  const wasDev = prefs.get('extensionsDeveloperMode');
  runCommand('set-pref', { key: 'extensionsDeveloperMode', value: false });
  // A folder that names a store is still not from it: only the store's signed package is.
  let asked = null;
  const added = ext.install(FIXTURE, { store: { store: 'chrome', id: 'a'.repeat(32) }, confirm: (info) => { asked = info; return true; } });
  check('Extensions: asked before one is added, with what it may do',
    Boolean(asked) && asked.warnings.includes('Communicate with cooperating native applications'), JSON.stringify(asked));
  const meta = JSON.parse(fs.readFileSync(path.join(added.dir, 'debrowser-meta.json'), 'utf8'));
  check('Extensions: one added from a file is not counted as from a store, whatever it says', meta.store === null, String(meta.store));
  let refused = false;
  try { ext.install(FIXTURE, { confirm: () => false }); } catch (e) { refused = e.cancelled === true; }
  check('Extensions: answering Cancel adds nothing and leaves it as it was', refused && fs.existsSync(path.join(added.dir, 'manifest.json')));
  await ext.loadEverywhere(added.id);
  let chromeId = null;
  for (const ses of ext.sessions) chromeId ||= ext.loadedId(ses, added.id);
  const origin = `chrome-extension://${chromeId}/`;

  // The host: a script that runs the test program with Electron as Node,
  // and two manifests in Debrowser's own folder - one that lets the
  // extension in, one that names another.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-native-'));
  const run = path.join(scratch, 'host.sh');
  fs.writeFileSync(run, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${path.join(FIXTURE, 'host.js')}" "$@"\n`, { mode: 0o755 });
  const dir = path.join(path.dirname(ext.root), 'NativeMessagingHosts');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, allowed) => fs.writeFileSync(path.join(dir, `${name}.json`),
    JSON.stringify({ name, description: 'test', path: run, type: 'stdio', allowed_origins: allowed }));
  write('com.debrowser.test_host', [origin]);
  write('com.debrowser.test_closed', ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']);

  const openPage = async () => {
    const tab = tabs.create({ url: `${origin}page.html`, activate: true, realise: true });
    await waitFor(() => !tab.wc.isLoading(), { timeoutMs: 8000 }).catch(() => {});
    const out = await Promise.race([
      tab.wc.executeJavaScript('window.results').catch((e) => ({ error: e.message })),
      new Promise((res) => setTimeout(() => res({ error: 'timed out' }), 15000))
    ]);
    return { tab, out };
  };
  // Added from a file, with developer mode off: a borrowed ID reaches nothing.
  const first = await openPage();
  check('Native: one added from a file may not reach a program without developer mode',
    first.out && first.out.echo && /forbidden/.test(String(first.out.echo.error)), JSON.stringify(first.out));
  if (!first.tab.wc.isDestroyed()) tabs.close(first.tab.id);
  await waitFor(() => ext.native.ports.size === 0, { timeoutMs: 3000 }).catch(() => {});

  runCommand('set-pref', { key: 'extensionsDeveloperMode', value: true });
  const { tab: page, out: r } = await openPage();
  const said = JSON.stringify(r);
  check('Native: connectNative is there', r && r.connectNative === 'function', said);
  check('Native: a port reaches the program, started with the extension\'s origin, and its answer comes back',
    r && r.status && r.status.type === 'status_response' && r.status.origin === origin, said);
  check('Native: the computer\'s name comes back as Debrowser\'s', r && r.status && r.status.computer_name === 'Test-PC (Debrowser)', said);
  check('Native: sendNativeMessage answers once', r && r.echo && r.echo.text === 'hi', said);
  check('Native: a host that does not name the extension is refused', r && /forbidden/.test(String(r.forbidden)), said);
  check('Native: a host that is not installed is refused', r && /not found/.test(String(r.missing)), said);
  await waitFor(() => ext.native.ports.size === 0, { timeoutMs: 3000 }).catch(() => {});
  check('Native: no program left running', ext.native.ports.size === 0, String(ext.native.ports.size));

  if (!page.wc.isDestroyed()) tabs.close(page.id);
  ext.remove(added.id);
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const n of ['com.debrowser.test_host', 'com.debrowser.test_closed']) fs.rmSync(path.join(dir, `${n}.json`), { force: true });
  runCommand('set-pref', { key: 'extensionsDeveloperMode', value: wasDev });
  runCommand('set-pref', { key: 'extensions', value: wasOn });
};
