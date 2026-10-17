'use strict';

/**
 * Real extensions, as people install them: the widely used ones, from the
 * Chrome Web Store and Firefox Add-ons, each added, started and used the way
 * the toolbar uses it.
 *
 * For each one: it installs and loads without an error; its background (a
 * service worker or a page) is running; its content scripts reach a page it
 * asks for; its popup opens and draws something; and its own logo is found
 * for the puzzle menu and Settings.
 *
 * Off unless asked for, because it needs the stores and the stores change:
 *
 *   DEBROWSER_REAL_EXTENSIONS=<folder>  DEBROWSER_SMOKE_ONLY=features
 *     DEBROWSER_SMOKE_FEATURE=real-extensions
 *
 * The folder holds the downloaded files, named as downloadFromStore names them
 * (chrome-<id>.crx, firefox-<slug>.xpi); any missing one is fetched into it.
 */

const fs = require('fs');
const path = require('path');
const { webContents } = require('electron');
const { downloadFromStore } = require('../../extensions');

/** The ones most people have, by store and id. */
const POPULAR = [
  ['chrome', 'ddkjiahejlhfcafbddmgiahcphecmpfh', 'uBlock Origin Lite'],
  ['chrome', 'bgnkhhnnamicmpeenaelnjfhikgbkllg', 'AdGuard AdBlocker'],
  ['chrome', 'cfhdojbkjhnklbpkdaibdccddilifddb', 'Adblock Plus'],
  ['chrome', 'gighmmpiobklfepjocnamgkkbiglidom', 'AdBlock'],
  ['chrome', 'mlomiejdfkolichcflejclcbmpeaniij', 'Ghostery'],
  ['chrome', 'pkehgijcmpdhfbdbbnkijodmdjhbjlgp', 'Privacy Badger'],
  ['chrome', 'nngceckbapebfimnlniiiahkandclblb', 'Bitwarden'],
  ['chrome', 'hdokiejnpimakedhajhdlcegeplioahd', 'LastPass'],
  ['chrome', 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', '1Password'],
  ['chrome', 'eimadpbcbfnmbkopoojfekhnkhdbieeh', 'Dark Reader'],
  ['chrome', 'kbfnbcaeplbcioakkpcpgfkobkghlhen', 'Grammarly'],
  ['chrome', 'fcoeoabgfenejglbffodgkkbkcdhcgfn', 'Claude'],
  ['chrome', 'aapbdbdomjkkjkaonfhkkikfgjllcleb', 'Google Translate'],
  ['chrome', 'fheoggkfdfchfphceeifdbepaooicaho', 'McAfee WebAdvisor'],
  ['chrome', 'bmnlcjabgnpnenekpadlanbbkooimhnj', 'Honey'],
  ['chrome', 'dhdgffkkebhmkfjojejmpbldmpobfkfo', 'Tampermonkey'],
  ['chrome', 'fmkadmapgofadopljbjfkapdkoienihi', 'React Developer Tools'],
  ['chrome', 'bhlhnicpbhignbdhedgjhgdocnmhomnp', 'ColorZilla'],
  ['chrome', 'liecbddmkiiihnedobmlmillhodjkdmb', 'Loom'],
  ['chrome', 'ghbmnnjooekpmoecnnnilnnbdlolhkhi', 'Google Docs Offline'],
  ['firefox', 'ublock-origin', 'uBlock Origin (Firefox)'],
  ['firefox', 'darkreader', 'Dark Reader (Firefox)'],
  ['firefox', 'bitwarden-password-manager', 'Bitwarden (Firefox)']
];

/** What each kind does that can be seen from the page. */
const BLOCKERS = /uBlock|AdGuard|Adblock|AdBlock|Ghostery/;
const DARKENERS = /Dark Reader/;
const AD_SCRIPT = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';

/** Whether a content script's matches cover a plain http page on 127.0.0.1. */
function coversLocalPage(manifest) {
  return (manifest.content_scripts || []).some((cs) => (cs.matches || []).some((m) =>
    m === '<all_urls>' || /^(\*|http):\/\/(\*|127\.0\.0\.1)\/\*?/.test(m)));
}

module.exports = async function realExtensions(t) {
  const { check, waitFor, sleep, tabs, prefs, runCommand, getExtensions } = t;
  const dir = process.env.DEBROWSER_REAL_EXTENSIONS;
  const ext = getExtensions && getExtensions();
  if (!dir || !ext) {
    console.log('  (skipped: set DEBROWSER_REAL_EXTENSIONS to a folder to run it)');
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const wasLab = prefs.get('extensions');
  runCommand('set-pref', { key: 'extensions', value: true });
  await sleep(500);

  const page = tabs.create({ url: t.pageUrl('idle.html'), activate: true, realise: true });
  await waitFor(() => page.wc && !page.loading, { timeoutMs: 10_000 });
  const ses = page.wc.session;
  const summary = [];
  // Whether the page can fetch the ad script: true before any blocker, so a
  // blocked fetch afterwards is the blocker's doing and not the network's.
  const adLoads = () => page.wc.executeJavaScript(
    `fetch(${JSON.stringify(AD_SCRIPT)}, { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false)`).catch(() => null);
  const adsReachable = await adLoads();

  const only = (process.env.DEBROWSER_REAL_EXTENSIONS_ONLY || '').toLowerCase();
  for (const [store, id, label] of POPULAR) {
    if (only && !label.toLowerCase().includes(only)) continue;
    const file = path.join(dir, `${store}-${id.replace(/[^\w.-]/g, '_')}.${store === 'firefox' ? 'xpi' : 'crx'}`);
    const r = { label, install: '', background: false, scripts: null, popup: null, icon: false };
    let added = null;
    try {
      if (!fs.existsSync(file)) await downloadFromStore({ store, id }, (u) => ses.fetch(u), dir, process.versions.chrome);
      added = ext.install(file);
      const [loaded] = await ext.loadEverywhere(added.id);
      if (loaded && !loaded.ok) throw new Error(loaded.error);
    } catch (err) {
      r.install = err.message;
    }

    if (added && !r.install) {
      const manifest = JSON.parse(fs.readFileSync(path.join(added.dir, 'manifest.json'), 'utf8'));
      const loadedId = ext.loadedId(ses, added.id);
      const origin = `chrome-extension://${loadedId}/`;
      r.icon = Boolean(ext.iconData(added.id));

      // Its background: a running worker, or a page at its own address.
      const hasBackground = Boolean(manifest.background);
      if (hasBackground) {
        r.background = await waitFor(async () => {
          const running = Object.values(ses.serviceWorkers.getAllRunning?.() || {});
          if (running.some((w) => String(w.scope || w.scriptUrl || '').startsWith(origin))) return true;
          return webContents.getAllWebContents().some((wc) => !wc.isDestroyed() && wc.getURL().startsWith(origin));
        }, { timeoutMs: 10_000 });
      } else r.background = true;

      // Its content scripts, in their own world on a fresh load of the page.
      if (coversLocalPage(manifest)) {
        const worlds = [];
        const dbg = page.wc.debugger;
        try {
          dbg.attach('1.3');
          dbg.on('message', (_e, method, params) => {
            if (method === 'Runtime.executionContextCreated') worlds.push(params.context);
          });
          await dbg.sendCommand('Runtime.enable');
          page.wc.reload();
          r.scripts = await waitFor(() => worlds.some((c) => String(c.origin || '').startsWith(origin.slice(0, -1)) ||
            (c.auxData && c.auxData.type === 'isolated' && c.name === added.name)), { timeoutMs: 15_000 });
        } catch (err) {
          r.scripts = false;
          r.scriptsError = err.message;
        } finally {
          try { dbg.detach(); } catch { /* already */ }
          dbg.removeAllListeners('message');
        }
        await waitFor(() => !page.loading, { timeoutMs: 8000 });
      }

      // Its popup, from the puzzle menu, over the page.
      if (added.popup) {
        ext.keepPopupOpen = true;
        runCommand('open-extension-popup', { id: added.id, right: 700, y: 40 });
        const popup = () => (ext.popupWindow && !ext.popupWindow.isDestroyed() ? ext.popupWindow : null);
        // Caught as soon as it exists: one that closes itself can be gone by
        // the time it has finished loading.
        await waitFor(() => popup(), { timeoutMs: 10_000, pollMs: 10 });
        const said = [];
        // Some close themselves once they have done their work - Loom's starts
        // its recorder over the page - which counts, as long as it loaded.
        let closedItself = false;
        let finished = false;
        const opened = popup();
        if (opened) {
          opened.webContents.on('console-message', (e) => { if (e.level === 'error') said.push(e.message); });
          opened.once('closed', () => { if (!finished) closedItself = true; });
        }
        r.popup = await waitFor(async () => {
          if (opened && closedItself) return true;
          const w = popup();
          if (!w) return false;
          const drawn = await w.webContents.executeJavaScript(
            '({ n: document.body ? document.body.querySelectorAll("*").length : 0, text: document.body ? document.body.innerText.trim().length : 0 })')
            .catch(() => null);
          return Boolean(drawn && (drawn.n >= 3 || drawn.text > 0));
        }, { timeoutMs: 12_000 });
        if (!r.popup) {
          const html = popup() ? await popup().webContents.executeJavaScript('document.documentElement.outerHTML').catch(() => '') : 'closed';
          r.popupError = [...said.slice(0, 2), String(html).slice(0, 400)].join(' | ');
        }
        finished = true;
        if (popup()) popup().destroy();
        ext.keepPopupOpen = false;
      }
    }

    // What it is for, on the page: ad blockers block, Dark Reader darkens.
    if (added && !r.install && BLOCKERS.test(label) && adsReachable) {
      r.works = await waitFor(async () => (await adLoads()) === false, { timeoutMs: 10_000 });
    }
    if (added && !r.install && DARKENERS.test(label)) {
      page.wc.reload();
      await waitFor(() => !page.loading, { timeoutMs: 8000 });
      r.works = await waitFor(() => page.wc.executeJavaScript(
        'Boolean(document.querySelector("style.darkreader, meta[name=darkreader]"))').catch(() => false), { timeoutMs: 10_000 });
    }

    const fine = !r.install && r.background && r.scripts !== false && r.popup !== false && r.icon && r.works !== false;
    summary.push(`${label}: ${fine ? 'works' : 'FAILS'}`);
    check(`real extensions: ${label} installs, starts, reaches pages, opens its popup, shows its own logo and does its job`, fine,
      r.install ? `install: ${r.install}` : `background ${r.background}, content scripts ${r.scripts ?? 'none for this page'}` +
        `${r.scriptsError ? ` (${r.scriptsError})` : ''}, popup ${r.popup ?? 'none'}${r.popupError ? ` (${r.popupError})` : ''}, logo ${r.icon}${r.works === undefined ? '' : `, does its job ${r.works}`}`);
    if (added) ext.remove(added.id);
    await sleep(300);
  }

  console.log(`\n  ${summary.join('\n  ')}\n`);
  if (!page.wc.isDestroyed()) tabs.close(page.id);
  runCommand('set-pref', { key: 'extensions', value: wasLab });
};
