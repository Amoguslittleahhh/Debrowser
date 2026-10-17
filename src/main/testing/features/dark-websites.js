'use strict';

/**
 * Dark websites: pages that only come in light, shown dark (dark-pages.js).
 *
 * End to end: the setting switched as Settings switches it, real pages loaded
 * from test/pages/dark-websites-*.html, the root's filter read back out of the
 * page, and the tab's picture captured to see what the user would see - a dark
 * background, pictures still in their own colours, a fixed bar still at the
 * top. The right-click menu is opened with a real right-click, and the
 * per-site switch is picked in it.
 *
 * The rules being held to: only a page that is light as drawn, never one
 * that is dark already, never one of the browser's own pages, never a private
 * window; off at once everywhere when the setting is; off for one site only
 * when picked there, and remembered for it.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const pages = require('../../pages');
const darkPages = require('../../dark-pages');
const { SitePrefs } = require('../../data/site-prefs');
const { PAGES } = require('../fixture-server');

// The colours the fixtures draw with, as [r, g, b].
const RGB = {
  red: [0xd0, 0x30, 0x30],
  blue: [0x30, 0x50, 0xd0],
  purple: [0x80, 0x40, 0xc0],
  maroon: [0x90, 0x20, 0x40],
  navy: [0x20, 0x30, 0x60],
  dark: [0x1b, 0x1b, 0x1f],
  scheme: [0x15, 0x17, 0x1a]
};

const lum = (c) => (c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : NaN);
const diff = (a, b) => (a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : Infinity);
const show = (c) => (c ? `rgb(${c.join(',')})` : 'nothing');
// Through the page's filter and back again, a picture loses the 6% the
// filter's brightness takes off, and a little to rounding between the steps.
const kept = (c, want) => diff(c, want.map((v) => v * 0.94)) <= 60;

module.exports = async function darkWebsites(t) {
  const { check, waitFor, sleep, tabs, shell, context, prefs, sitePrefs, runCommand, contextMenu } = t;
  if (!prefs || !sitePrefs) {
    check('dark websites have preferences and site choices to test against', false, 'no prefs or site prefs in this run');
    return;
  }

  // Everything this changes, to put back for the features after it.
  const before = { dark: prefs.get('darkWebsites'), theme: prefs.get('theme') };
  const touched = new Set();
  const opened = [];
  const tmpDirs = [];
  const tabsBefore = tabs.all().length;
  let slowServer = null;

  const setPref = (key, value) => runCommand('set-pref', { key, value });
  const hostOf = (tab) => darkPages.hostOf(tab.wc.getURL());
  const loaded = (tab, name) => waitFor(() => tab.isLive && !tab.loading && tab.wc.getURL().includes(name), { timeoutMs: 10_000 });
  const js = (tab, code) => tab.wc.executeJavaScript(code).catch((err) => `threw ${err.message}`);
  const frames = (tab) => t.inTime(js(tab, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'), 1000);
  const open = async (url, { activate = true } = {}) => {
    const tab = tabs.create({ url, activate, realise: true });
    opened.push(tab);
    await loaded(tab, url.split('/').pop().split('?')[0]);
    if (activate) await tabs.activate(tab.id);
    const host = darkPages.hostOf(url);
    if (host) touched.add(host);
    return tab;
  };
  const page = (name, options) => open(t.pageUrl(name), options);
  /** Another page on the same site as `tab`. */
  const sameSite = (tab, name) => {
    const u = new URL(tab.wc.getURL());
    u.pathname = `/${name}`;
    return u.toString();
  };
  const go = async (tab, url) => {
    await tab.wc.loadURL(url).catch(() => {});
    await loaded(tab, url.split('/').pop());
    const host = darkPages.hostOf(url);
    if (host) touched.add(host);
  };
  const close = (tab) => { if (tab && tabs.all().includes(tab)) tabs.close(tab.id); };

  /** The root's filter as the page itself reads it. */
  const filterOf = (tab) => js(tab, 'getComputedStyle(document.documentElement).filter');
  const darkened = async (tab) => /invert/.test(String(await filterOf(tab)));
  /** Wait for a page to be darkened (or not); the answer as it stands at the end. */
  const becomes = async (tab, want, timeoutMs = 3000) => {
    await waitFor(async () => (await darkened(tab)) === want, { timeoutMs, pollMs: 50 });
    return darkened(tab);
  };
  /** Nothing should change: give it the time a change would take, then read. */
  const settled = async (tab) => { await sleep(700); return darkened(tab); };

  /** The middle of an element, in the page's own pixels. */
  const centre = (tab, selector, inFrame = null) => js(tab, `(() => {
    const frame = ${inFrame ? `document.querySelector(${JSON.stringify(inFrame)})` : 'null'};
    const doc = frame ? frame.contentDocument : document;
    const el = doc && doc.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const off = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: Math.round(off.left + r.left + r.width / 2), y: Math.round(off.top + r.top + r.height / 2) };
  })()`);

  /**
   * The tab's picture, as the user sees it. It has to be in front to be
   * drawn; `at(x, y)` is in the page's pixels, averaged over a few.
   */
  async function shot(tab) {
    await tabs.activate(tab.id);
    await frames(tab);
    await sleep(150);
    await frames(tab);
    const image = await t.inTime(tab.wc.capturePage(), 4000, null);
    if (!image || image.isEmpty()) return { at: () => null, pixel: () => null };
    const { width, height } = image.getSize();
    const cssWidth = await js(tab, 'innerWidth');
    const scale = typeof cssWidth === 'number' && cssWidth > 0 ? width / cssWidth : 1;
    const bmp = image.toBitmap();
    return {
      /** One pixel, unaveraged: for thin things like the strokes of letters. */
      pixel(x, y) {
        const px = Math.round(x * scale);
        const py = Math.round(y * scale);
        if (px < 0 || py < 0 || px >= width || py >= height) return null;
        const i = (py * width + px) * 4;
        return [bmp[i + 2], bmp[i + 1], bmp[i]];
      },
      at(x, y) {
        if (typeof x !== 'number' || typeof y !== 'number') return null;
        const sum = [0, 0, 0];
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const px = Math.round(x * scale) + dx;
            const py = Math.round(y * scale) + dy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const i = (py * width + px) * 4;
            // BGRA.
            sum[0] += bmp[i + 2]; sum[1] += bmp[i + 1]; sum[2] += bmp[i];
            n++;
          }
        }
        return n ? sum.map((v) => Math.round(v / n)) : null;
      }
    };
  }
  const colourOf = async (tab, selector, inFrame) => {
    const at = await centre(tab, selector, inFrame);
    return at ? (await shot(tab)).at(at.x, at.y) : null;
  };

  const items = (model) => (model?.items || []).filter((i) => i.id);
  const darkItem = (model) => items(model).find((i) => i.id === 'toggle-site-dark') || null;
  const describe = (model) => (model ? (darkItem(model)?.label || `no dark item (${items(model).map((i) => i.id).join(',')})`) : 'no menu');

  /** A real right-click on an empty part of the page, as the mouse sends it. */
  async function rightClick(tab, { x = 20, y = 300, keepOpen = false } = {}) {
    await tabs.activate(tab.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      await frames(tab);
      context.model = null;
      tab.wc.sendInputEvent({ type: 'mouseMove', x, y });
      tab.wc.sendInputEvent({ type: 'mouseDown', button: 'right', x, y, clickCount: 1 });
      tab.wc.sendInputEvent({ type: 'mouseUp', button: 'right', x, y, clickCount: 1 });
      if (await waitFor(() => context.model && context.model.tabId === tab.id, { timeoutMs: 2000, pollMs: 50 })) break;
    }
    const model = context.model;
    if (!keepOpen && shell.sheetPage === 'context') shell.closeSheet();
    return model;
  }

  try {
    // Pages are told the browser prefers light, so the fixtures draw light
    // whatever the machine running this is set to.
    setPref('darkWebsites', false);
    setPref('theme', 'light');

    // ---------------------------------------------------------------
    // The pure parts first: which addresses have a host, when it is wanted,
    // what the menu says, and what a site's choice may be.
    {
      const fakePrefs = (v) => ({ get: (k) => (k === 'darkWebsites' ? v : undefined) });
      const fakeSites = (map) => ({ get: (h, k) => (k === 'dark' ? map[h] : undefined) });
      const hosts = [
        ['https://Example.COM:8443/a?b#c', 'example.com'],
        ['http://[::1]:8080/', '[::1]'],
        ['file:///etc/passwd', null],
        [pages.SETTINGS_URL, null],
        ['view-source:https://example.com/', null],
        ['javascript:alert(1)', null],
        ['data:text/html,<p>hi</p>', null],
        ['about:blank', null],
        ['not a url', null],
        ['', null],
        [undefined, null],
        [{ toString: () => 'https://object.example/' }, 'object.example']
      ];
      const wrongHosts = hosts.filter(([url, want]) => darkPages.hostOf(url) !== want)
        .map(([url, want]) => `${String(url)} -> ${darkPages.hostOf(url)} (want ${want})`);
      check('only a website\'s address has a host for dark websites to be decided on',
        wrongHosts.length === 0, wrongHosts.join('; ') || `${hosts.length} addresses`);

      const cases = [
        [fakePrefs(true), fakeSites({}), 'a.test', true],
        [fakePrefs(false), fakeSites({}), 'a.test', false],
        [fakePrefs('true'), fakeSites({}), 'a.test', false],
        [fakePrefs(1), fakeSites({}), 'a.test', false],
        [null, fakeSites({}), 'a.test', false],
        [fakePrefs(true), fakeSites({ 'a.test': false }), 'a.test', false],
        [fakePrefs(true), fakeSites({ 'a.test': false }), 'b.test', true],
        // Only `false` turns it off: anything else a corrupt store held does not.
        [fakePrefs(true), fakeSites({ 'a.test': 'false' }), 'a.test', true],
        [fakePrefs(true), fakeSites({ 'a.test': 0 }), 'a.test', true],
        [fakePrefs(true), null, 'a.test', true]
      ];
      const wrongWanted = cases.map((c, i) => [i, darkPages.wanted(c[0], c[1], c[2]), c[3]]).filter(([, got, want]) => got !== want);
      check('dark websites apply only when switched on, and not on a site it was turned off for',
        wrongWanted.length === 0, wrongWanted.map(([i, got]) => `case ${i} gave ${got}`).join('; ') || `${cases.length} cases`);

      const label = (darkHere) => darkItem({ items: contextMenu.buildModel({ x: 1, y: 1 }, { darkHere }) })?.label || null;
      const onLink = darkItem({ items: contextMenu.buildModel({ x: 1, y: 1, linkURL: 'https://example.com/' }, { darkHere: true }) });
      check('the page menu says what picking it will do on this site, and says nothing while dark websites are off',
        label(true) === 'Turn off dark mode on this site' && label(false) === 'Use dark mode on this site' &&
          label(null) === null && label(undefined) === null && label('yes') === null && label(1) === null && !onLink,
        `on ${label(true)}, off here ${label(false)}, off ${label(null)}, junk ${label('yes')}, on a link ${onLink ? 'shown' : 'not shown'}`);

      // The choice as it is kept, and as it is read back after a restart.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-dark-'));
      tmpDirs.push(dir);
      const store = new SitePrefs(dir);
      store.set('off.test', 'dark', false);
      store.set('true.test', 'dark', true);
      store.set('string.test', 'dark', 'false');
      store.set('bad host!', 'dark', false);
      const refused = store.get('true.test', 'dark') === undefined && store.get('string.test', 'dark') === undefined &&
        store.get('bad host!', 'dark') === undefined;
      store.flush();
      // A hand-edited file: only `false` is believed.
      const file = path.join(dir, 'site-prefs.json');
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...written, 'edited.test': { dark: true }, 'junk.test': { dark: 'no' }, 'zero.test': { dark: 0 } }));
      const again = new SitePrefs(dir);
      store.set('off.test', 'dark', null);
      store.flush();
      const cleared = new SitePrefs(dir);
      check('a site\'s dark choice is kept only as "off", survives a restart, and is forgotten when switched back',
        refused && again.get('off.test', 'dark') === false && again.get('edited.test', 'dark') === undefined &&
          again.get('junk.test', 'dark') === undefined && again.get('zero.test', 'dark') === undefined &&
          cleared.get('off.test', 'dark') === undefined && !cleared.sites.has('off.test'),
        `refused bad values ${refused}, after restart ${again.get('off.test', 'dark')}, edited true ${again.get('edited.test', 'dark')}, ` +
        `after switching back ${cleared.get('off.test', 'dark')}`);
    }

    // ---------------------------------------------------------------
    // Off, as it is by default: nothing is touched and the menu says nothing.
    const light = await page('dark-websites-light.html');
    {
      const filter = await settled(light);
      const model = await rightClick(light);
      check('with dark websites off a light page is left as it is, and its menu offers nothing about it',
        filter === false && model && !darkItem(model) && light.darkCssKey == null,
        `filter ${await filterOf(light)}, menu ${describe(model)}`);
    }

    // Opened before the switch: one behind, one never loaded yet.
    const behind = await page('dark-websites-transparent.html', { activate: false });
    const sleeping = tabs.create({ url: t.pageUrl('dark-websites-light.html'), activate: false, realise: false });
    opened.push(sleeping);
    touched.add(darkPages.hostOf(sleeping.url));
    const dark = await page('dark-websites-dark.html');
    await tabs.activate(light.id);

    // ---------------------------------------------------------------
    // On, as Settings switches it: the open light page goes dark at once.
    setPref('darkWebsites', true);
    {
      const on = await becomes(light, true);
      const filter = await filterOf(light);
      const picture = await shot(light);
      const blank = await centre(light, '#blank');
      const bg = picture.at(blank?.x, blank?.y);
      const textAt = await centre(light, '#text');
      check('switched on, a light page already open goes dark at once',
        on && /invert\(1\)/.test(filter) && /hue-rotate\(180deg\)/.test(filter) && lum(bg) < 0.12,
        `filter ${filter}, background ${show(bg)}`);

      // Each picture's colour, through the page's filter.
      const swatches = {};
      for (const [id, colour] of [['#img', 'red'], ['#video', 'blue'], ['#inline-bg', 'maroon']]) {
        const at = await centre(light, id);
        swatches[id] = { got: picture.at(at?.x, at?.y), want: RGB[colour] };
      }
      const wrong = Object.entries(swatches).filter(([, s]) => !kept(s.got, s.want));
      check('pictures, a video\'s poster and an inline background keep their own colours on a darkened page',
        wrong.length === 0,
        Object.entries(swatches).map(([id, s]) => `${id} ${show(s.got)} (drawn ${show(s.want)})`).join(', '));

      const cssBg = await colourOf(light, '#css-bg');
      check('a background picture set in the page\'s style sheet keeps its colours on a darkened page',
        kept(cssBg, RGB.purple), `${show(cssBg)}, drawn ${show(RGB.purple)}, inverted would be light`);

      const pic = await colourOf(light, '#pic-img');
      check('a picture inside <picture> keeps its colours on a darkened page',
        kept(pic, RGB.navy), `${show(pic)}, drawn ${show(RGB.navy)}`);

      // Words: drawn dark on white, they should now be light on dark. The
      // paragraph's first letters are sampled against the blank beside them.
      const words = await js(light, `(() => {
        const r = document.getElementById('text').getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      })()`);
      let brightest = 0;
      if (words && typeof words === 'object') {
        for (let y = words.y; y < words.y + words.h; y++) {
          for (let x = words.x; x < words.x + Math.min(240, words.w); x++) brightest = Math.max(brightest, lum(picture.pixel(x, y)) || 0);
        }
      }
      check('a darkened page\'s words are drawn light', brightest > 0.5,
        `brightest sample in the text ${brightest.toFixed(2)}, at ${JSON.stringify(textAt)}`);

      const darkFilter = await settled(dark);
      const darkBg = (await shot(dark)).at(300, 200);
      check('a page that is dark already is left as its designers drew it',
        darkFilter === false && diff(darkBg, RGB.dark) <= 6 && dark.darkCssKey == null,
        `filter ${await filterOf(dark)}, background ${show(darkBg)} (drawn ${show(RGB.dark)})`);
      // Nothing is being done to it, so there is nothing to turn off there.
      const darkMenu = await rightClick(dark);
      check('on a page that is dark of its own accord the menu does not offer to turn off a dark mode it is not using',
        darkMenu && darkItem(darkMenu)?.label !== 'Turn off dark mode on this site', `menu ${describe(darkMenu)}`);

      const behindOn = await becomes(behind, true);
      const behindBg = (await shot(behind)).at(300, 200);
      check('a page with a white body on a transparent root, in a tab behind, is darkened too',
        behindOn && lum(behindBg) < 0.12, `filter ${await filterOf(behind)}, background ${show(behindBg)}`);

      await tabs.activate(sleeping.id);
      await loaded(sleeping, 'dark-websites-light.html');
      const wokeDark = await becomes(sleeping, true, 5000);
      check('a tab that had not loaded yet is darkened when it does', wokeDark, `filter ${await filterOf(sleeping)}`);
      await tabs.activate(light.id);
    }

    // ---------------------------------------------------------------
    // A fixed bar: the filter is on the root, which is the one element it
    // does not break position: fixed for. Scrolled, it should still be at the top.
    {
      await js(light, 'scrollTo(0, 0)');
      const before0 = (await shot(light)).at(600, 20);
      const top = await js(light, 'scrollTo(0, 1200), new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(document.getElementById("bar").getBoundingClientRect().top))))');
      const scrolled = await js(light, 'scrollY');
      const after = await shot(light);
      const barAfter = after.at(600, 20);
      const below = after.at(600, 200);
      check('a fixed bar on a darkened page stays at the top when the page is scrolled',
        top === 0 && scrolled >= 1000 && diff(barAfter, before0) <= 8 && diff(barAfter, below) > 20,
        `bar top ${top}, scrolled ${scrolled}, bar ${show(before0)} -> ${show(barAfter)}, page below ${show(below)}`);
      await js(light, 'scrollTo(0, 0)');
    }

    // ---------------------------------------------------------------
    // A frame: the page around it is darkened, and what is in the frame
    // keeps its own colours rather than being inverted twice.
    {
      const framed = await page('dark-websites-frame.html');
      await waitFor(async () => (await js(framed, 'document.getElementById("frame").contentDocument?.readyState')) === 'complete', { timeoutMs: 5000 });
      const outer = await becomes(framed, true);
      const picture = await shot(framed);
      const block = await centre(framed, '#block', '#frame');
      const blockColour = picture.at(block?.x, block?.y);
      const frameBg = await js(framed, `(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: Math.round(r.right - 20), y: Math.round(r.bottom - 10) }; })()`);
      const frameBgColour = picture.at(frameBg?.x, frameBg?.y);
      const pageBg = picture.at(500, 400);
      check('a page with a frame is darkened, and the frame\'s pictures are not inverted twice',
        outer && kept(blockColour, RGB.red) && lum(pageBg) < 0.12,
        `page ${show(pageBg)}, framed red block ${show(blockColour)}, framed page's background ${show(frameBgColour)} ` +
        '(frames are turned back with the pictures, so a light one stays light)');
      close(framed);
    }

    // ---------------------------------------------------------------
    // The menu, opened with a real right-click, and the per-site switch.
    const other = await page('dark-websites-light.html');
    const hostA = hostOf(light);
    const hostB = hostOf(other);
    {
      await becomes(other, true);
      const keyBefore = light.darkCssKey;
      const model = await rightClick(light, { keepOpen: true });
      const item = darkItem(model);
      // Picked in the menu as the user picks it: the sheet's own button.
      const sheetUp = await waitFor(() => shell.sheetPage === 'context' && shell.sheetView &&
        shell.sheetView.webContents.getURL().includes('context.html'), { timeoutMs: 5000 });
      await waitFor(async () => (await t.inTime(shell.sheetView?.webContents.executeJavaScript(
        '[...document.querySelectorAll("button.item")].some((b) => /dark mode/.test(b.textContent))'), 1000, false)) === true, { timeoutMs: 3000 });
      const picked = sheetUp ? await t.inTime(shell.sheetView.webContents.executeJavaScript(`(() => {
        const b = [...document.querySelectorAll('button.item')].find((x) => /dark mode/.test(x.textContent));
        if (!b) return null;
        const text = b.textContent.trim();
        b.click();
        return text;
      })()`), 2000, null) : null;
      const offHere = await becomes(light, false);
      const otherStill = await darkened(other);
      check('the page menu offers to turn dark mode off on a darkened site, and picking it turns it off there',
        item?.label === 'Turn off dark mode on this site' && /Turn off dark mode on this site/.test(picked || '') && !offHere,
        `menu ${describe(model)}, sheet ${sheetUp ? 'up' : 'never up'}, picked ${picked}, page ${await filterOf(light)}, ` +
        `sheet key ${keyBefore} -> ${light.darkCssKey}`);
      check('turning dark mode off on one site leaves other sites dark, and is remembered for that site',
        otherStill && sitePrefs.get(hostA, 'dark') === false && sitePrefs.get(hostB, 'dark') === undefined,
        `${hostB} ${otherStill ? 'dark' : 'not dark'}, kept for ${hostA}: ${sitePrefs.get(hostA, 'dark')}, for ${hostB}: ${sitePrefs.get(hostB, 'dark')}`);
      if (shell.sheetPage === 'context') shell.closeSheet();

      // The same site in another tab, and a new page loaded there.
      const sibling = await open(sameSite(light, 'dark-websites-transparent.html'));
      const siblingDark = await settled(sibling);
      const menuOff = await rightClick(sibling);
      // Kept in memory under the smoke test (no profile is written), so the
      // restart is a store on a directory of its own given the same choice.
      let restarted = 'not checked';
      if (sitePrefs.file) {
        sitePrefs.flush();
        restarted = new SitePrefs(path.dirname(sitePrefs.file)).get(hostA, 'dark');
      } else {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-dark-'));
        tmpDirs.push(dir);
        const store = new SitePrefs(dir);
        store.set(hostA, 'dark', sitePrefs.get(hostA, 'dark'));
        store.flush();
        restarted = new SitePrefs(dir).get(hostA, 'dark');
      }
      check('a site dark mode was turned off for stays light in its other pages, and after a restart',
        siblingDark === false && darkItem(menuOff)?.label === 'Use dark mode on this site' && restarted === false,
        `other page ${siblingDark ? 'dark' : 'light'}, menu ${describe(menuOff)}, after restart ${restarted}`);

      // And back on, from the same switch.
      await tabs.activate(light.id);
      runCommand('toggle-site-dark');
      const back = await becomes(light, true);
      const siblingBack = await becomes(sibling, true);
      check('turning dark mode back on for a site darkens its open pages again, and forgets the choice',
        back && siblingBack && sitePrefs.get(hostA, 'dark') === undefined,
        `page ${back}, other page ${siblingBack}, kept ${sitePrefs.get(hostA, 'dark')}`);
      close(sibling);
    }

    // ---------------------------------------------------------------
    // A new page in the same tab is decided afresh.
    {
      await go(light, t.pageUrl('dark-websites-dark.html'));
      const toDark = await settled(light);
      await go(light, t.pageUrl('dark-websites-light.html'));
      const toLight = await becomes(light, true);
      check('going to another page decides again: a dark page is left alone, the next light one darkened',
        toDark === false && toLight, `dark page ${toDark ? 'darkened' : 'left'}, light page ${toLight ? 'darkened' : 'left'}`);
    }

    // ---------------------------------------------------------------
    // The browser's own pages are never touched, and Settings has the switch.
    {
      const settings = await open(pages.SETTINGS_URL);
      await waitFor(async () => (await js(settings, 'Boolean(document.getElementById("pref-darkWebsites"))')) === true, { timeoutMs: 8000 });
      const settingsDark = await settled(settings);
      const menu = await rightClick(settings, { x: 30, y: 30 });
      const row = await js(settings, `(() => {
        const box = document.getElementById('pref-darkWebsites');
        if (!box) return null;
        const row = box.closest('.row');
        return { checked: box.checked, text: (row && row.textContent || '').replace(/\\s+/g, ' ').trim() };
      })()`);
      check('the browser\'s own pages are never darkened, and offer no dark switch in their menu',
        settingsDark === false && settings.darkCssKey == null && (!menu || !darkItem(menu)),
        `settings filter ${await filterOf(settings)}, menu ${describe(menu)}`);
      check('Settings shows Dark websites switched on, saying what it does and where to turn it off for a site',
        row && row.checked === true && /Dark websites/.test(row.text) && /Right-click a page to turn it off there/.test(row.text),
        JSON.stringify(row));

      // Clicked as the user clicks it: off, and every page with it.
      const clickBox = async () => {
        const at = await js(settings, `(() => {
          const box = document.getElementById('pref-darkWebsites');
          box.scrollIntoView({ block: 'center' });
          const r = box.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        await frames(settings);
        const zoom = settings.wc.getZoomFactor();
        const x = Math.round(at.x * zoom);
        const y = Math.round(at.y * zoom);
        settings.wc.sendInputEvent({ type: 'mouseMove', x, y });
        settings.wc.sendInputEvent({ type: 'mouseDown', button: 'left', x, y, clickCount: 1 });
        settings.wc.sendInputEvent({ type: 'mouseUp', button: 'left', x, y, clickCount: 1 });
      };
      await clickBox();
      await waitFor(() => prefs.get('darkWebsites') === false, { timeoutMs: 3000 });
      const allOff = await Promise.all([light, other, behind].map((tab) => becomes(tab, false, 1500)));
      check('switched off in Settings, dark websites come off every open page at once',
        prefs.get('darkWebsites') === false && allOff.every((d) => d === false),
        `pref ${prefs.get('darkWebsites')}, pages ${allOff.map((d) => (d ? 'dark' : 'light')).join(',')}`);
      const menuGone = await rightClick(light);
      check('with dark websites off again the page menu no longer offers it',
        menuGone && !darkItem(menuGone), `menu ${describe(menuGone)}`);
      // The per-site switch, sent while it is off (a stale menu, a shortcut).
      await tabs.activate(light.id);
      runCommand('toggle-site-dark');
      await sleep(300);
      const whileOff = sitePrefs.get(hostOf(light), 'dark');
      await tabs.activate(settings.id);
      await clickBox();
      await waitFor(() => prefs.get('darkWebsites') === true, { timeoutMs: 3000 });
      const allOn = await Promise.all([light, other, behind].map((tab) => becomes(tab, true, 3000)));
      check('switched back on in Settings, the light pages go dark again',
        prefs.get('darkWebsites') === true && allOn.every(Boolean), `pages ${allOn.map((d) => (d ? 'dark' : 'light')).join(',')}`);

      await tabs.activate(settings.id);
      const sitesBefore = JSON.stringify([...sitePrefs.sites]);
      runCommand('toggle-site-dark');
      await sleep(300);
      const onSettings = JSON.stringify([...sitePrefs.sites]) === sitesBefore && (await darkened(settings)) === false;
      check('the per-site switch does nothing while dark websites are off, or on one of the browser\'s own pages',
        whileOff === undefined && onSettings, `kept while off ${whileOff}, on Settings ${onSettings ? 'nothing changed' : 'something changed'}`);

      // Not a yes or no: refused, and nothing changes.
      for (const junk of ['yes', 1, null, { on: true }]) setPref('darkWebsites', junk);
      check('dark websites can only be switched with a yes or a no', prefs.get('darkWebsites') === true,
        `after junk values it is ${JSON.stringify(prefs.get('darkWebsites'))}`);
      close(settings);
    }

    // ---------------------------------------------------------------
    // Pages that are dark, or light, in ways the first look can miss.
    {
      const wrapper = await page('dark-websites-wrapper.html');
      const wrapperDark = await settled(wrapper);
      const wrapperBg = (await shot(wrapper)).at(400, 300);
      check('a page that is dark on the element its app renders into is left dark',
        wrapperDark === false && lum(wrapperBg) < 0.2, `filter ${await filterOf(wrapper)}, shows ${show(wrapperBg)} (drawn rgb(16,19,24))`);
      close(wrapper);

      const system = await page('dark-websites-system.html');
      const systemDark = await settled(system);
      const picture = await shot(system);
      const glyph = await centre(system, '#glyph');
      const glyphColour = picture.at(glyph?.x, glyph?.y);
      const systemBg = picture.at(600, 400);
      check('a page that declares itself dark and uses the browser\'s colours is left readable',
        systemDark === false && lum(glyphColour) - lum(systemBg) > 0.4,
        `filter ${await filterOf(system)}, text ${show(glyphColour)} on ${show(systemBg)}`);
      close(system);

      const oklch = await page('dark-websites-oklch.html');
      const oklchDark = await becomes(oklch, true, 1500);
      const oklchBg = (await shot(oklch)).at(400, 300);
      const declared = await js(oklch, 'getComputedStyle(document.documentElement).backgroundColor');
      check('a light page whose colours are written in oklch is darkened like any other',
        oklchDark && lum(oklchBg) < 0.12, `background ${declared}, shows ${show(oklchBg)}, filter ${await filterOf(oklch)}`);
      close(oklch);

      // Its style sheet held back a second by a server of this test's own,
      // as a slow one is; nothing on the page waits for it but the picture.
      slowServer = await new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          const name = path.basename((req.url || '/').split('?')[0]);
          if (name === 'dark-websites-late.css') {
            setTimeout(() => {
              res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' });
              res.end('html { background: #121212; color: #eee; }');
            }, 1200);
          } else if (name === 'dark-websites-late.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            fs.createReadStream(path.join(PAGES, name)).pipe(res);
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
      });
      const late = await open(`http://late.test:${slowServer.address().port}/dark-websites-late.html`);
      await waitFor(async () => (await js(late, 'Boolean(document.querySelector("link[rel=stylesheet]").sheet)')) === true, { timeoutMs: 5000 });
      await sleep(300);
      const lateDark = await darkened(late);
      const latePicture = await shot(late);
      const lateGlyph = await centre(late, '#glyph');
      const lateText = latePicture.at(lateGlyph?.x, lateGlyph?.y);
      const lateBg = latePicture.at(600, 400);
      check('a dark page whose style sheet is slow to arrive is not inverted',
        lateDark === false && lum(lateText) - lum(lateBg) > 0.4,
        `filter ${await filterOf(late)}, text ${show(lateText)} on ${show(lateBg)} (drawn rgb(238,238,238) on rgb(18,18,18))`);
      close(late);
    }

    // ---------------------------------------------------------------
    // A site with a dark theme of its own (prefers-color-scheme).
    {
      setPref('theme', 'dark');
      await sleep(300);
      const scheme = await page('dark-websites-scheme.html');
      const schemeDark = await settled(scheme);
      const schemeBg = (await shot(scheme)).at(400, 300);
      check('a site with a dark theme of its own shows it, untouched, when the browser prefers dark',
        schemeDark === false && diff(schemeBg, RGB.scheme) <= 6, `filter ${await filterOf(scheme)}, shows ${show(schemeBg)}`);

      // Loaded while the browser preferred light, and then the theme changes.
      setPref('theme', 'light');
      await go(scheme, t.pageUrl('dark-websites-scheme.html'));
      await settled(scheme);
      const lightBg = (await shot(scheme)).at(400, 300);
      // Pages are told the browser's theme, so under a light one the site
      // draws light and is darkened like any other: dark, if not its own.
      check('a site with a dark theme of its own is shown dark, whatever the browser\'s theme',
        lum(lightBg) < 0.2,
        `browser theme light: filter ${await filterOf(scheme)}, shows ${show(lightBg)} (its own dark is ${show(RGB.scheme)})`);
      setPref('theme', 'dark');
      await sleep(600);
      const afterSwitch = await shot(scheme);
      const glyph = await centre(scheme, '#glyph');
      const switchedText = afterSwitch.at(glyph?.x, glyph?.y);
      const switchedBg = afterSwitch.at(600, 400);
      check('a darkened site that turns dark itself when the browser\'s theme changes stays readable',
        lum(switchedText) - lum(switchedBg) > 0.4,
        `filter ${await filterOf(scheme)}, text ${show(switchedText)} on ${show(switchedBg)} (its own: rgb(230,230,230) on ${show(RGB.scheme)})`);
      setPref('theme', 'light');
      close(scheme);
    }

    // ---------------------------------------------------------------
    // A page that pushes back: what it can see, and what it can undo.
    {
      context.model = null;
      const hostile = await page('dark-websites-hostile.html');
      const still = await becomes(hostile, true);
      await sleep(500);
      const seen = await js(hostile, 'window.seen.filter((f) => /invert/.test(f)).length');
      const reached = await js(hostile, 'window.reached');
      const bg = (await shot(hostile)).at(400, 300);
      const hostileHost = hostOf(hostile);
      const otherDark = await darkened(other);
      // It can see it - the root's filter is in its computed style, which is
      // why a private window never has it - and what it does about it stays
      // on its own page: the switch, its site's choice and other sites are
      // the browser's.
      check('a page that pushes back reaches nothing of the browser\'s: not the switch, not its site\'s choice, not other sites',
        reached === false && (context.model === null || context.model.tabId !== hostile.id) &&
          prefs.get('darkWebsites') === true && sitePrefs.get(hostileHost, 'dark') === undefined && otherDark,
        `bridge ${reached}, menu ${context.model ? describe(context.model) : 'none'}, setting ${prefs.get('darkWebsites')}, ` +
        `its site ${sitePrefs.get(hostileHost, 'dark')}, other site ${otherDark ? 'dark' : 'light'}; ` +
        `it read the filter ${seen} times, and its important styles left it ${still ? 'dark' : 'light'} (${show(bg)})`);
      close(hostile);

      // Content-Security-Policy that allows no styles at all does not stop it.
      const csp = await page('dark-websites-csp.html');
      const cspDark = await becomes(csp, true);
      check('a page whose security policy forbids styles is darkened all the same', cspDark, `filter ${await filterOf(csp)}`);
      close(csp);
    }

    // ---------------------------------------------------------------
    // Wrong orders: switched on and straight off before the page has
    // answered whether it is light; switched on when it is on already; and a
    // page brought back by Back.
    {
      setPref('darkWebsites', false);
      // Loaded while off, so it has never been darkened.
      const flicked = await page('dark-websites-light.html');
      const wasLight = (await settled(flicked)) === false;
      setPref('darkWebsites', true);
      setPref('darkWebsites', false);
      const flick = await settled(flicked);
      check('switched on and straight off again, no page is left dark',
        wasLight && flick === false, `before ${wasLight ? 'light' : 'dark'}, after ${await filterOf(flicked)}, sheet ${flicked.darkCssKey}`);
      close(flicked);

      const twice = await page('dark-websites-light.html');
      setPref('darkWebsites', true);
      await becomes(twice, true);
      const first = twice.darkCssKey;
      setPref('darkWebsites', true);
      await sleep(700);
      // A second sheet, with only its key kept, is one that switching off
      // can never take away again.
      check('switched on again while already on, a page is not given a second copy of the dark style',
        first != null && twice.darkCssKey === first, `sheet ${first} -> ${twice.darkCssKey}`);
      close(twice);

      // Back to a page the browser kept as it was: the switch still reaches
      // it. Only meaningful where the back-forward cache keeps pages.
      const back = await page('dark-websites-light.html');
      await becomes(back, true);
      await js(back, 'window.__kept = true');
      await go(back, sameSite(back, 'dark-websites-transparent.html'));
      await becomes(back, true);
      back.wc.navigationHistory.goBack();
      await loaded(back, 'dark-websites-light.html');
      const restored = (await js(back, 'window.__kept === true')) === true;
      if (restored) {
        await becomes(back, true);
        setPref('darkWebsites', false);
        const afterBack = await settled(back);
        check('a page the back-forward cache brought back still comes out of dark mode when the setting is switched off',
          afterBack === false, `filter ${await filterOf(back)}`);
      } else {
        console.log('  (the back-forward cache did not keep the page, so Back reloaded it: nothing more to check there)');
      }
      close(back);
    }

    // ---------------------------------------------------------------
    // Private windows run in a process of their own, which this suite cannot
    // drive; what keeps them out is in main.js, so that is what is read.
    {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
      const onLoad = /case 'dom-ready':[\s\S]{0,200}?if \(!INCOGNITO\) darkPages\.apply\(/.test(source);
      const menu = /darkHere: !INCOGNITO &&/.test(source);
      const refused = /const INCOGNITO_REFUSED = new Set\(\[[\s\S]*?'toggle-site-dark'[\s\S]*?\]\);/.test(source);
      const branch = (source.match(/if \(payload\.key === 'darkWebsites'[^)]*\) \{[\s\S]*?\n {8}\}/) || [''])[0];
      const switched = branch.length > 0 && /INCOGNITO/.test(branch);
      check('a private window never darkens its pages: not on load, not from its menu, and not when switched on in its own Settings',
        onLoad && menu && refused && switched,
        `on load ${onLoad}, menu ${menu}, per-site switch refused ${refused}, set-pref branch guarded ${switched}`);
    }
  } finally {
    if (shell.sheetPage === 'context') shell.closeSheet();
    context.model = null;
    for (const tab of opened) close(tab);
    setPref('darkWebsites', before.dark);
    setPref('theme', before.theme);
    for (const host of touched) sitePrefs.set(host, 'dark', null);
    sitePrefs.flush();
    for (const dir of tmpDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
    if (slowServer) {
      slowServer.close();
      slowServer.closeAllConnections();
    }
  }

  const left = [...touched].filter((host) => sitePrefs.get(host, 'dark') !== undefined);
  check('the dark websites checks leave no tabs, settings or site choices behind',
    tabs.all().length === tabsBefore && prefs.get('darkWebsites') === before.dark && prefs.get('theme') === before.theme &&
      left.length === 0 && tmpDirs.every((dir) => !fs.existsSync(dir)),
    `tabs ${tabsBefore} -> ${tabs.all().length}, dark ${prefs.get('darkWebsites')}, theme ${prefs.get('theme')}, sites left ${left.join(',') || 'none'}`);
};
