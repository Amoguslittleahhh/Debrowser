'use strict';

/**
 * Installing a site as an app (web-apps.js): from its manifest - its name,
 * start page and icon - to a shortcut that starts Debrowser with the app's
 * id, the app's own window at its start page, and Remove taking all of it
 * away. The shortcut goes to a scratch folder, never the real menu.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, pngToIco, appArg } = require('../../web-apps');

module.exports = async function webAppsFeature(t) {
  const { check, waitFor, sleep, tabs, runCommand, pageUrl } = t;
  const apps = t.getWebApps && t.getWebApps();
  if (!apps) { check('Apps: available', false, 'no WebApps'); return; }

  // The pure parts.
  const info = describe({ url: 'https://a.example/x/page', title: 'Page', manifestUrl: 'https://a.example/m.json',
    manifest: { short_name: 'A', start_url: '/x/?home', scope: '/x/', icons: [{ src: '/i.png', sizes: '512x512' }, { src: '/s.png', sizes: '192x192' }] } });
  check('Apps: a manifest gives the name, start page, scope and icon',
    info.name === 'A' && info.startUrl === 'https://a.example/x/?home' && info.scope === 'https://a.example/x/' && info.iconUrl === 'https://a.example/s.png',
    JSON.stringify(info));
  const foreign = describe({ url: 'https://a.example/', manifest: { start_url: 'https://evil.example/' } });
  check('Apps: a start page on another site is refused', foreign.startUrl === 'https://a.example/', foreign.startUrl);
  check('Apps: only websites', describe({ url: 'file:///x.html' }) === null);
  const ico = pngToIco(Buffer.from('png'));
  check('Apps: the .ico wraps the PNG', ico.readUInt16LE(2) === 1 && ico.length === 25);
  check('Apps: the shortcut\'s argument is read back', appArg(['x', '--web-app=0123456789abcdef']) === '0123456789abcdef' && appArg(['--web-app=../x']) === null);

  // End to end.
  const menu = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-apps-'));
  apps.places = { menu, desktop: null };
  const page = tabs.create({ url: pageUrl('web-app.html'), activate: true, realise: true });
  await waitFor(() => !page.loading, 10000);
  runCommand('install-web-app');
  await waitFor(() => apps.list().length === 1, 10000).catch(() => {});
  const app = apps.list()[0];
  check('Apps: installed with its manifest\'s name', Boolean(app) && app.name === 'Probe App', app && app.name);
  if (!app) return;
  check('Apps: at its start page', /web-app\.html\?start$/.test(app.startUrl), app.startUrl);
  check('Apps: its icon saved', Boolean(app.icon) && fs.statSync(app.icon).size > 100, String(app.icon));
  const entry = (app.shortcuts || []).find((f) => f.endsWith('.desktop'));
  const text = entry ? fs.readFileSync(entry, 'utf8') : '';
  check('Apps: a shortcut that opens it', text.includes(`--web-app=${app.id}`) && text.includes('Name=Probe App'), entry || 'none');
  await waitFor(() => apps.windows.get(app.id) && !apps.windows.get(app.id).page.webContents.isLoading(), 10000).catch(() => {});
  const win = apps.windows.get(app.id);
  check('Apps: its own window at its start page', Boolean(win) && /web-app\.html\?start$/.test(win.page.webContents.getURL()),
    win ? win.page.webContents.getURL() : 'no window');
  await sleep(500);
  const barText = win ? await win.bar.webContents.executeJavaScript(`document.getElementById('t').textContent + '|' + getComputedStyle(document.body).backgroundColor`) : '';
  check('Apps: a title bar of the app\'s own colour, with the page\'s title', /^Probe app page\|rgb\(42, 122, 108\)$/.test(barText), barText);
  if (win && process.env.DEBROWSER_SHOT) {
    fs.writeFileSync(`${process.env.DEBROWSER_SHOT}-bar.png`, (await win.bar.webContents.capturePage()).toPNG());
    fs.writeFileSync(`${process.env.DEBROWSER_SHOT}-page.png`, (await win.page.webContents.capturePage()).toPNG());
  }
  runCommand('open-web-app', { id: app.id });
  await sleep(300);
  check('Apps: opening it again brings the same window forward', apps.windows.size === 1);
  check('Apps: removed', apps.remove(app.id) && apps.list().length === 0);
  await sleep(300);
  check('Apps: its shortcut and window go with it', !fs.existsSync(entry) && (!win || win.isDestroyed()));
  if (!page.wc.isDestroyed()) tabs.close(page.id);
  fs.rmSync(menu, { recursive: true, force: true });
};
