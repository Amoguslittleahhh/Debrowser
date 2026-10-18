'use strict';

/**
 * An extension's own site settings (Settings → Extensions → Details), every
 * one of them: each set to Allow and Block and seen to take effect on the
 * extension's own page - the browser's permission answers, script, images,
 * sound, pop-ups, downloads - or shown as not changeable where Debrowser
 * cannot honour it. Then Reset permissions puts them all back.
 */

const path = require('path');
const { SITE_SETTINGS } = require('../../extensions');

const FIXTURE = path.join(__dirname, '..', '..', '..', '..', 'test', 'extensions', 'chrome-site-settings');

module.exports = async function extensionSiteSettingsFeature(t) {
  const { check, waitFor, sleep, tabs, prefs, runCommand } = t;
  const ext = t.getExtensions && t.getExtensions();
  if (!ext) { check('Site settings: extensions available', false, 'no extensions'); return; }
  const wasOn = prefs.get('extensions');
  runCommand('set-pref', { key: 'extensions', value: true });
  const added = ext.install(FIXTURE);
  await ext.loadEverywhere(added.id);
  let chromeId = null;
  for (const ses of ext.sessions) chromeId ||= (ses.__debrowserExt || new Map()).get(added.id) || null;
  check('Site settings: the test extension loaded', Boolean(chromeId), String(chromeId));
  if (!chromeId) return;
  const url = `chrome-extension://${chromeId}/page.html`;
  const set = (kind, value) => ext.setSitePermission(added.id, kind, value);
  const listed = () => ext.sitePermissions(added.id);
  const row = (kind) => listed().find((r) => r.kind === kind);

  // The list: Chrome's, in its order, with its defaults.
  check('Site settings: all 34 listed', listed().length === 34 && SITE_SETTINGS.length === 34, String(listed().length));

  // Every setting the browser asks about: Allow answers yes, Block no, and
  // its default leaves it to the browser.
  const asks = SITE_SETTINGS.filter(([, , , how]) => Array.isArray(how));
  const wrong = [];
  for (const [kind, , , perms] of asks) {
    for (const perm of perms) {
      const [permission, details] = perm.startsWith('media:') ? ['media', { mediaTypes: [perm.slice(6)] }] : [perm, {}];
      set(kind, 'allow');
      const a = ext.decidePermission(url, permission, details);
      set(kind, 'block');
      const b = ext.decidePermission(url, permission, details);
      set(kind, 'ask');
      const c = ext.decidePermission(url, permission, details);
      if (a !== true || b !== false || c !== null) wrong.push(`${kind}/${perm}: ${a},${b},${c}`);
    }
    set(kind, row(kind).def);
  }
  check(`Site settings: the ${asks.length} the browser asks about answer Allow, Block and Ask`, wrong.length === 0, wrong.join('; '));
  set('camera', 'allow'); set('microphone', 'block');
  check('Site settings: camera and microphone together: one blocked refuses both',
    ext.decidePermission(url, 'media', { mediaTypes: ['video', 'audio'] }) === false);
  set('camera', 'ask'); set('microphone', 'ask');
  check('Site settings: another extension\'s or a website\'s asks are left alone',
    ext.decidePermission('https://example.com/', 'geolocation') === null);

  // In the page itself, through the browser's own permission handlers.
  const page = tabs.create({ url, activate: true, realise: true });
  const load = async () => {
    // A change reaches an open page as soon as it is made; a person reloads
    // long after, the test straight away.
    await page.wc.__debrowserApplying;
    page.wc.reload();
    await sleep(150);
    await waitFor(() => !page.wc.isLoading(), { timeoutMs: 8000 }).catch(() => {});
    await sleep(200);
  };
  await waitFor(() => !page.wc.isLoading(), { timeoutMs: 8000 }).catch(() => {});
  const run = (code) => page.wc.executeJavaScript(code, true).catch((e) => `error: ${e.message}`);
  const query = (name) => run(`navigator.permissions.query({ name: '${name}' }).then((s) => s.state, (e) => 'error ' + e.name)`);
  set('location', 'allow');
  const geoAllow = await query('geolocation');
  set('location', 'block');
  const geoBlock = await query('geolocation');
  set('location', 'ask');
  check('Site settings: Location, as the page sees it', geoAllow === 'granted' && geoBlock === 'denied', `${geoAllow}/${geoBlock}`);
  set('notifications', 'block');
  const nBlock = await run('Notification.requestPermission()');
  set('notifications', 'allow');
  const nAllow = await run('Notification.requestPermission()');
  set('notifications', 'ask');
  check('Site settings: Notifications, when the page asks', nAllow === 'granted' && nBlock === 'denied', `${nAllow}/${nBlock}`);
  set('clipboard', 'block');
  const clip = await query('clipboard-read');
  set('clipboard', 'ask');
  check('Site settings: Clipboard blocked', clip === 'denied', String(clip));

  // The ones applied to the page as it loads.
  await load();
  check('Site settings: by default its script runs and its image shows',
    page.wc.getTitle() === 'js-ran' && (await run('document.getElementById("i").naturalWidth')) > 0, page.wc.getTitle());
  set('javascript', 'block');
  await load();
  const jsOff = page.wc.getTitle();
  set('javascript', 'allow');
  await load();
  check('Site settings: JavaScript blocked, and allowed again', jsOff === 'static' && page.wc.getTitle() === 'js-ran', `${jsOff}/${page.wc.getTitle()}`);
  set('images', 'block');
  await load();
  const imgOff = await run('document.getElementById("i").naturalWidth');
  set('images', 'allow');
  await load();
  const imgOn = await run('document.getElementById("i").naturalWidth');
  check('Site settings: Images blocked, and allowed again', imgOff === 0 && imgOn > 0, `${imgOff}/${imgOn}`);
  set('sound', 'block');
  await load();
  const muted = page.wc.isAudioMuted();
  set('sound', 'allow');
  await load();
  check('Site settings: Sound blocked mutes it, allowed unmutes it', muted && !page.wc.isAudioMuted());
  const opened = async (clicked = false) => {
    const before = tabs.all().length;
    await page.wc.executeJavaScript(`void window.open(${JSON.stringify(t.pageUrl('idle.html'))})`, clicked).catch(() => {});
    await sleep(600);
    const extra = tabs.all().filter((x) => x.id !== page.id && /idle\.html/.test(String(x.url)));
    const n = tabs.all().length - before;
    for (const x of extra) tabs.close(x.id);
    return n > 0;
  };
  await load();
  const popDefault = await opened();
  set('popups', 'allow');
  await load();
  const popAllow = await opened();
  set('popups', 'block');
  await load();
  const popBlock = await opened();
  const popClicked = await opened(true);
  check('Site settings: Pop-ups blocked by default, allowed, and blocked again', !popDefault && popAllow && !popBlock, `${popDefault}/${popAllow}/${popBlock}`);
  check('Site settings: a pop-up the user clicked for still opens', popClicked);

  const download = async () => {
    let state = 'none';
    const ses = page.wc.session;
    const seen = (event, item) => {
      setTimeout(() => { state = event.defaultPrevented ? 'blocked' : item.getState(); try { item.cancel(); } catch { /* done */ } }, 50);
    };
    ses.prependListener('will-download', seen);
    await run(`(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['x'])); a.download = 'x.txt'; document.body.append(a); a.click(); })()`);
    await waitFor(() => state !== 'none', { timeoutMs: 3000 }).catch(() => {});
    await sleep(100);
    ses.removeListener('will-download', seen);
    return state;
  };
  set('downloads', 'block');
  const dBlock = await download();
  check('Site settings: Automatic downloads blocked', dBlock === 'blocked' || dBlock === 'cancelled', dBlock);
  set('downloads', 'ask');

  // Read by the browser where it acts for the page.
  for (const kind of ['ads', 'autoPip', 'webApps']) {
    set(kind, 'allow');
    const a = ext.siteChoice(url, kind);
    set(kind, 'block');
    const b = ext.siteChoice(url, kind);
    set(kind, row(kind).def);
    check(`Site settings: ${row(kind).label} read back as chosen`, a === 'allow' && (b || row(kind).def) === 'block', `${a}/${b}`);
  }

  // What Debrowser cannot change: shown, not changeable.
  const fixed = SITE_SETTINGS.filter(([, , , how]) => !Array.isArray(how) && !['page', 'blocker'].includes(how));
  const moved = [];
  for (const [kind] of fixed) {
    const before = row(kind);
    set(kind, before.value === 'allow' ? 'block' : 'allow');
    const after = row(kind);
    if (before.applies || !before.note || after.value !== before.value) moved.push(kind);
  }
  check(`Site settings: the ${fixed.length} Debrowser cannot honour are shown as such, unchangeable`, moved.length === 0, moved.join(', '));

  // Kept, and Reset permissions.
  set('camera', 'allow'); set('sound', 'block');
  ext.settingCache?.clear();
  check('Site settings: kept after being read again from disk', row('camera').value === 'allow' && row('sound').value === 'block');
  set(null, null);
  const changed = listed().filter((r) => r.value !== r.def).map((r) => r.kind);
  check('Site settings: Reset permissions puts every one back', changed.length === 0, changed.join(', '));

  if (!page.wc.isDestroyed()) tabs.close(page.id);
  ext.remove ? await ext.remove(added.id) : null;
  runCommand('set-pref', { key: 'extensions', value: wasOn });
};
