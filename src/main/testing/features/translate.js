'use strict';

/**
 * Translating a page, or the words selected on it, through Google.
 *
 * The pure parts first (translate.js): which addresses may go to Google's
 * proxy, what they become there and what "Show original" makes of them again,
 * and which language a system or a setting means. Then end to end: real
 * right-clicks on real pages, the menu's items run through the command
 * dispatcher as the sheet runs them, and where the tab went.
 *
 * Google is out of reach here, and the fixtures are on names it could not
 * fetch anyway. So for the public half, the browsing session's https (and,
 * briefly, its http) is answered by this file: a few stand-in sites, Google's
 * proxy and Google Translate's page. That is also how it sees exactly what
 * was asked of Google.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const pages = require('../../pages');
const translate = require('../../translate');
const { SCHEMA, Prefs } = require('../../prefs');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'test', 'pages', 'translate-page.html'), 'utf8');

/** Sites standing in for the public web, all serving translate-page.html. */
const STAND_INS = new Set(['www.example.com', 'news.example.org', 'plain.example.net', 'down.example.com',
  'xn--mnchen-3ya.de']);

/** Google Translate's page, reduced to showing what it was given. */
const ECHO = `<!doctype html><meta charset="utf-8"><title>Google Translate</title>
<pre id="text"></pre><script>
  const q = new URL(location.href).searchParams;
  document.getElementById('text').textContent = q.get('text');
  document.title = 'tl=' + q.get('tl') + ' sl=' + q.get('sl');
</script>`;

/** Google's proxy, reduced to a page that says it is translated. */
const TRANSLATED = `<!doctype html><meta charset="utf-8"><title>Traduit</title>
<div id="blank" style="height: 300px"></div><p id="words">Une page traduite.</p>`;

const attempt = (fn) => { try { return fn(); } catch (err) { return `threw ${err.message}`; } };
/** Rows of [input, wanted]: the ones that came out otherwise, said plainly. */
const mismatches = (rows, run) => rows
  .map(([input, want]) => ({ input, want, got: attempt(() => run(input)) }))
  .filter((r) => r.got !== r.want)
  .map((r) => `${JSON.stringify(r.input)} gave ${JSON.stringify(r.got)}, wanted ${JSON.stringify(r.want)}`);
const report = (list) => (list.length ? list.slice(0, 8).join('; ') : 'all as expected');

module.exports = async function translateFeature(t) {
  const { check, waitFor, sleep, tabs, shell, context, prefs, runCommand, contextMenu, app, history } = t;

  /* -------------------------------------------------------------- */
  // What a page's address becomes at Google's proxy.
  {
    const q = (tl) => `_x_tr_sl=auto&_x_tr_tl=${tl}&_x_tr_hl=${tl}`;
    const rows = [
      ['https://www.example.com/', `https://www-example-com.translate.goog/?${q('fr')}`],
      ['https://my-site.co.uk/a/b', `https://my--site-co-uk.translate.goog/a/b?${q('fr')}`],
      ['https://a--b.example.com/', `https://a----b-example-com.translate.goog/?${q('fr')}`],
      ['HTTPS://WWW.EXAMPLE.COM/Some/Path', `https://www-example-com.translate.goog/Some/Path?${q('fr')}`],
      ['https://example.com:443/', `https://example-com.translate.goog/?${q('fr')}`],
      ['https://en.wikipedia.org/wiki/Caf%C3%A9#History',
        `https://en-wikipedia-org.translate.goog/wiki/Caf%C3%A9?${q('fr')}#History`],
      ['https://example.com/?page=2#:~:text=hello', `https://example-com.translate.goog/?page=2&${q('fr')}#:~:text=hello`]
    ];
    const wrong = mismatches(rows, (url) => translate.pageUrl(url, 'fr'));
    check('a public page\'s address becomes Google\'s proxy address for it, a hyphen doubled and each dot a hyphen',
      wrong.length === 0, report(wrong));

    // Google's own parameters already in the address: the chosen language
    // wins, once, and the page's own parameters go along.
    const carried = new URL(translate.pageUrl('https://example.com/?_x_tr_tl=xx&_x_tr_sl=yy&keep=1', 'de'));
    check('an address that already carries Google\'s parameters is translated into the chosen language, once',
      carried.searchParams.getAll('_x_tr_tl').join() === 'de' && carried.searchParams.getAll('_x_tr_sl').join() === 'auto' &&
        carried.searchParams.get('keep') === '1',
      carried.search);
  }

  {
    // International names. The proxy's label for münchen.de starts "xn--",
    // which makes it a punycode label that is not valid punycode.
    const names = ['https://münchen.de/', 'https://xn--mnchen-3ya.de/', 'https://bücher.example.com/', 'https://日本.jp/',
      'https://www.xn--mnchen-3ya.de/'];
    const results = names.map((url) => [url, attempt(() => translate.pageUrl(url, 'fr'))]);
    const threw = results.filter(([, got]) => typeof got === 'string' && got.startsWith('threw'));
    check('an international name gives Google\'s address for it or none, never an error',
      threw.length === 0, results.map(([url, got]) => `${url} -> ${got}`).join('; '));
  }

  {
    const none = ['https://example.com:8443/', 'http://example.com:8080/x', 'https://user:pw@example.com/',
      'https://user@example.com/', 'http://localhost/', 'http://LOCALHOST/', 'http://app.localhost/', 'http://127.0.0.1/',
      'http://10.0.0.8/', 'http://192.168.1.1/', 'http://8.8.8.8/', 'http://0x7f.1/', 'http://127.0.0.1./', 'http://[::1]/',
      'http://[2001:db8::1]/', 'http://printer/', 'http://nas.local/', 'http://svc.internal/', 'data:text/html,<p>hi',
      'file:///etc/hosts', 'debrowser://settings', 'about:blank', 'javascript:alert(1)', 'blob:https://example.com/0f7a',
      'ftp://example.com/', 'view-source:https://example.com/', 'chrome://gpu', 'not a url', '', null, undefined,
      'https://www-example-com.translate.goog/?_x_tr_tl=de', 'https://WWW-EXAMPLE-COM.TRANSLATE.GOOG/'];
    const wrong = mismatches(none.map((url) => [url, null]), (url) => translate.pageUrl(url, 'fr'));
    check('Google is not asked for a port, a password, this machine, the local network, a bare address or the browser\'s own pages',
      wrong.length === 0, report(wrong));

    // Names that cannot be on the public internet, by the same reckoning as
    // HTTPS-first (https-first.js, RESERVED): sending them to Google tells it
    // a private name and gets back its error page.
    const unreachable = ['http://localhost./', 'http://printer./', 'http://nas.local./', 'http://svc.internal./',
      'http://site.test/', 'https://www.example/', 'https://x.invalid/', 'http://router.home.arpa/', 'http://box.lan/',
      'http://intranet.corp/'];
    const sent = mismatches(unreachable.map((url) => [url, null]), (url) => translate.pageUrl(url, 'fr'));
    check('a name that cannot be on the public internet - reserved for tests, a home network, or this machine with its final dot - is never sent to Google',
      sent.length === 0, report(sent));

    const dotted = attempt(() => translate.pageUrl('https://www.example.com./', 'fr'));
    check('a site\'s name written with its final dot is translated as the same site',
      dotted === translate.pageUrl('https://www.example.com/', 'fr'), String(dotted));

    // One DNS label holds 63 characters; Google's proxy name is one label.
    const longHost = `${'a'.repeat(30)}.${'b'.repeat(30)}.example.com`;
    const long = attempt(() => translate.pageUrl(`https://${longHost}/`, 'fr'));
    const label = typeof long === 'string' && long.startsWith('https://') ? new URL(long).hostname.split('.')[0] : '';
    check('a name too long for one label of Google\'s address is not sent to an address that cannot exist',
      long === null || label.length <= 63, `${long} (label of ${label.length} characters)`);
  }

  /* -------------------------------------------------------------- */
  // "Show original": back to exactly the page that was translated.
  {
    const plain = ['https://www.example.com/', 'https://my-site.example.com/a/b?c=1&d=2#frag', 'https://a--b.com/',
      'https://x-y--z.co.uk/p', 'https://en.wikipedia.org/wiki/Caf%C3%A9?action=view#History',
      'https://example.com/?a=1&a=2', 'https://sub.domain-name.example.org/index.html',
      'https://example.com/#:~:text=hello', 'https://xn--bcher-kva.example.com/', 'https://1-2-3.example.com/'];
    const wrong = mismatches(plain.map((url) => [url, new URL(url).href]),
      (url) => translate.originalUrl(translate.pageUrl(url, 'ja')));
    check('Show original comes back to the very page that was translated', wrong.length === 0, report(wrong));

    // The query is the page's, and goes to the site as it was written.
    const queries = ['https://example.com/search?q=a%20b', 'https://example.com/?flag', 'https://example.com/?path=/x/y',
      'https://example.com/?q=~tilde', 'https://example.com/?q=caf%C3%A9%20au%20lait&lang=fr'];
    const changed = mismatches(queries.map((url) => [url, new URL(url).href]),
      (url) => translate.originalUrl(translate.pageUrl(url, 'ja')));
    const sentAs = attempt(() => new URL(translate.pageUrl('https://example.com/search?q=a%20b&flag', 'ja')).search);
    check('a page\'s query reaches Google and comes back from Show original exactly as it was written',
      changed.length === 0 && String(sentAs).startsWith('?q=a%20b&flag&'), `${report(changed)}; sent as ${sentAs}`);

    // A plain-HTTP site: Google is told so (`_x_tr_sch=http`), and Show
    // original goes back to it rather than to an https site that may not exist.
    const plainHttp = attempt(() => translate.pageUrl('http://example.com/news', 'fr'));
    const back = attempt(() => translate.originalUrl(plainHttp));
    const fromGoogle = attempt(() => translate.originalUrl(
      'https://example-com.translate.goog/news?_x_tr_sch=http&_x_tr_sl=auto&_x_tr_tl=fr&_x_tr_hl=en&_x_tr_pto=wapp'));
    check('a plain-HTTP page is fetched by Google over HTTP, and Show original goes back to it over HTTP',
      typeof plainHttp === 'string' && plainHttp.includes('_x_tr_sch=http') && back === 'http://example.com/news' &&
        fromGoogle === 'http://example.com/news',
      `sent ${plainHttp}; back ${back}; Google's own address back ${fromGoogle}`);

    const googles = attempt(() => translate.originalUrl(
      'https://www-example-com.translate.goog/a?b=1&_x_tr_sl=auto&_x_tr_tl=fr&_x_tr_hl=fr&_x_tr_pto=wapp&_x_tr_hist=true#h'));
    const notProxy = ['https://example.com/', 'https://translate.goog/', 'https://example-com.translate.goog.evil.com/',
      'not a url', '', null].map((url) => attempt(() => translate.originalUrl(url)));
    check('Show original drops every parameter of Google\'s and nothing else, and finds nothing outside the proxy',
      googles === 'https://www.example.com/a?b=1#h' && notProxy.every((x) => x === null),
      `${googles}; outside: ${JSON.stringify(notProxy)}`);

    const translatedRows = [['https://www-example-com.translate.goog/', true], ['https://EXAMPLE-COM.TRANSLATE.GOOG/x', true],
      ['https://translate.goog/', false], ['https://example-com.translate.goog.evil.com/', false],
      ['https://translate.goog.example.com/', false], ['https://example.com/?u=x.translate.goog', false],
      ['not a url', false], ['', false], [null, false], [undefined, false]];
    const wrong2 = mismatches(translatedRows, (url) => translate.isTranslated(url));
    check('a page counts as translated only on Google\'s proxy itself, not on a name that ends like it',
      wrong2.length === 0, report(wrong2));
  }

  /* -------------------------------------------------------------- */
  // The language to translate into.
  {
    const rows = [
      [[undefined, 'en-US'], 'en'], [['auto', 'fr-FR'], 'fr'], [['auto', 'pt-BR'], 'pt'], [['auto', 'pt-PT'], 'pt'],
      [['auto', 'zh-HK'], 'zh-TW'], [['auto', 'zh-TW'], 'zh-TW'], [['auto', 'zh-MO'], 'zh-TW'],
      [['auto', 'zh-Hant'], 'zh-TW'], [['auto', 'zh-Hant-HK'], 'zh-TW'], [['auto', 'zh-Hans-CN'], 'zh-CN'],
      [['auto', 'zh-Hans-HK'], 'zh-CN'], [['auto', 'zh-CN'], 'zh-CN'], [['auto', 'zh'], 'zh-CN'], [['auto', 'zh_TW'], 'zh-TW'],
      [['auto', 'nb-NO'], 'no'], [['auto', 'nn-NO'], 'no'], [['auto', 'nb'], 'no'], [['auto', 'fil-PH'], 'tl'],
      [['auto', 'fil'], 'tl'], [['auto', 'iw'], 'he'], [['auto', 'iw-IL'], 'he'], [['auto', 'he'], 'he'],
      [['auto', 'EN-gb'], 'en'], [['auto', 'es-419'], 'es'], [['auto', 'de_DE'], 'de'], [['auto', 'sw-KE'], 'sw'],
      [['auto', 'unknown'], 'en'], [['auto', ''], 'en'], [['auto', undefined], 'en'], [['auto', null], 'en'],
      [['auto', 'xx-YY'], 'en'], [['de', 'ja-JP'], 'de'], [['zh-TW', 'en'], 'zh-TW'], [['xx', 'ja-JP'], 'ja'],
      [['zh-cn', 'ja'], 'ja'], [['ZH-TW', 'fr'], 'fr'], [[['de'], 'fr'], 'fr'], [['__proto__', 'fr'], 'fr'],
      [['toString', 'fr'], 'fr'], [[42, 'ko'], 'ko']];
    const wrong = mismatches(rows, ([pref, locale]) => translate.targetLanguage(pref, locale));
    check('the language is the one chosen in Settings, else the system\'s, as the code Google knows it',
      wrong.length === 0, report(wrong));

    // System languages Chromium has a UI in and Google translates into, but
    // the list leaves out: their speakers are offered English.
    const left = [['ca-ES', 'ca'], ['hr-HR', 'hr'], ['sk-SK', 'sk'], ['bg-BG', 'bg'], ['lt-LT', 'lt'], ['ta-IN', 'ta']];
    const swapped = mismatches(left.map(([locale, code]) => [locale, code]), (locale) => translate.targetLanguage('auto', locale));
    check('a system language Google translates into is not swapped for English',
      swapped.length === 0, report(swapped));

    const names = [[['fr'], 'French'], [['de'], 'German'], [['ja'], 'Japanese'], [['no'], 'Norwegian'],
      [['fr', 'fr'], 'français'], [['xx'], 'xx'], [['fr', 'not a locale!!'], 'fr'], [[''], ''], [['zh-CN'], 'Chinese (China)']];
    const wrongNames = mismatches(names, ([code, displayIn]) => translate.languageName(code, displayIn));
    const unnamed = translate.LANGUAGES.filter((code) => translate.languageName(code) === code);
    check('each language has a name for the menu, and a code Intl cannot name falls back to the code rather than failing',
      wrongNames.length === 0 && unnamed.length === 0, `${report(wrongNames)}; unnamed: ${unnamed.join(',') || 'none'}`);
  }

  /* -------------------------------------------------------------- */
  // Selected words, to Google Translate's page.
  {
    const words = 'He said “bonjour”\nand "au revoir" & left #3 at 50% + tax';
    const url = translate.textUrl(`  ${words}  `, 'fr');
    const u = url ? new URL(url) : null;
    const long = 'x'.repeat(6200);
    const longUrl = new URL(translate.textUrl(long, 'fr'));
    const empties = ['', '   ', '\n\t', null, undefined].map((x) => translate.textUrl(x, 'fr'));
    check('selected words reach Google Translate exactly, trimmed, at most 5,000 characters, and nothing is opened for none',
      u && u.origin === 'https://translate.google.com' && u.searchParams.get('text') === words &&
        u.searchParams.get('tl') === 'fr' && u.searchParams.get('sl') === 'auto' && !u.hash &&
        longUrl.searchParams.get('text').length === 5000 && empties.every((x) => x === null),
      `${url}; long gives ${longUrl.searchParams.get('text').length}; empty gives ${JSON.stringify(empties)}`);

    // Cut at 5,000 UTF-16 units, an emoji across the cut becomes half of one.
    const emoji = `${'a'.repeat(4999)}😀 and more`;
    const cut = new URL(translate.textUrl(emoji, 'fr')).searchParams.get('text');
    check('a long selection is cut between characters, not through one',
      !cut.includes('�') && !/[\uD800-\uDBFF]$/.test(cut), `ends ${JSON.stringify(cut.slice(-3))}`);
  }

  /* -------------------------------------------------------------- */
  // The setting, its list, and a hand-edited file.
  {
    const ok = ['auto', ...translate.LANGUAGES].filter((v) => !SCHEMA.translateTo.ok(v));
    const bad = ['xx', '', ' fr', 'fr ', 'ZH-CN', 'zh-cn', 'zh', 'Auto', null, undefined, 42, ['fr'], { toString: () => 'fr' },
      'toString', '__proto__', 'constructor'].filter((v) => SCHEMA.translateTo.ok(v));
    check('the translation language setting takes "auto" or a listed language and nothing else',
      ok.length === 0 && bad.length === 0, `refused good ${JSON.stringify(ok)}, took bad ${JSON.stringify(bad.map(String))}`);

    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.js'), 'utf8');
    const list = /const TRANSLATE_LANGUAGES = \[([^\]]*)\]/.exec(src);
    const offered = list ? [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
    check('Settings offers exactly the languages translation knows',
      offered.join() === translate.LANGUAGES.join(), `settings.js ${offered.join(',')}`);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-translate-'));
    try {
      const file = path.join(dir, 'preferences.json');
      const loaded = (value) => {
        fs.writeFileSync(file, JSON.stringify({ translateTo: value }));
        return new Prefs(() => {}, { file, readOnly: true }).get('translateTo');
      };
      const after = { de: loaded('de'), 'zh-TW': loaded('zh-TW'), klingon: loaded('klingon'), 'ZH-CN': loaded('ZH-CN'),
        42: loaded(42), null: loaded(null) };
      check('after a restart the chosen language is kept, and a hand-edited one that is not offered is the system\'s again',
        after.de === 'de' && after['zh-TW'] === 'zh-TW' && after.klingon === 'auto' && after['ZH-CN'] === 'auto' &&
          after[42] === 'auto' && after.null === 'auto',
        JSON.stringify(after));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* -------------------------------------------------------------- */
  // The menu itself, from the browser's state.
  {
    const ids = (items) => items.filter((i) => i.id).map((i) => i.id);
    const offer = { target: 'fr', name: 'French', translated: false, possible: true };
    const page = contextMenu.buildModel({}, { translate: offer });
    const item = page.find((i) => i.id === 'translate-page');
    const cannot = contextMenu.buildModel({}, { translate: { ...offer, possible: false } }).find((i) => i.id === 'translate-page');
    const translated = ids(contextMenu.buildModel({}, { translate: { ...offer, translated: true } }));
    const internal = ids(contextMenu.buildModel({}, { translate: offer, internal: true }));
    const privately = ids(contextMenu.buildModel({ selectionText: 'bonjour' }, { translate: null }));
    const words = 'He said “hi”\n   and "bye"';
    const selection = contextMenu.buildModel({ selectionText: `  ${words} ` }, { translate: offer })
      .find((i) => i.id === 'translate-selection');
    const field = ids(contextMenu.buildModel({ selectionText: 'bonjour', isEditable: true, editFlags: {} }, { translate: offer }));
    check('the menu offers Translate page in the chosen language, Show original once translated, and neither on the browser\'s own pages',
      item?.label === 'Translate page to French with Google' && item.enabled === true && cannot?.enabled === false &&
        translated.includes('translate-original') && !translated.includes('translate-page') &&
        !internal.some((id) => id.startsWith('translate')) && !privately.some((id) => id.startsWith('translate')),
      `page ${item?.label}/${item?.enabled}, cannot ${cannot?.enabled}, translated ${translated.join(',')}, ` +
      `internal ${internal.join(',')}, no offer ${privately.join(',')}`);
    check('selected words get Translate “…”, carrying the whole selection, but not in a field',
      selection?.label === `Translate “${contextMenu.ellipsis(words)}”` && selection.payload?.text === words &&
        !selection.label.includes('\n') && !field.includes('translate-selection'),
      `${JSON.stringify(selection)}; field ${field.join(',')}`);
  }

  /* -------------------------------------------------------------- */
  // End to end, in the browser.
  const opened = [];
  const visited = new Set();
  const prefsBefore = { translateTo: prefs.get('translateTo'), httpsMode: prefs.get('httpsMode') };
  const uncaught = [];
  const rejected = [];
  const onUncaught = (err) => uncaught.push(String((err && err.message) || err).slice(0, 160));
  const onRejected = (err) => rejected.push(String((err && err.message) || err).slice(0, 160));
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejected);
  let ses = null;
  let httpsHandled = false;
  let httpHandled = false;
  const asked = [];
  const everAsked = new Set();

  const js = (tab, code) => tab.wc.executeJavaScript(code).catch((err) => `threw ${err.message}`);
  const loaded = (tab, part) => waitFor(() => tab.isLive && !tab.loading && tab.wc.getURL().includes(part), { timeoutMs: 10_000 });
  const open = async (url, part = url.split('/').pop()) => {
    const tab = tabs.create({ url, activate: true, realise: true });
    opened.push(tab);
    visited.add(url);
    await loaded(tab, part);
    await tabs.activate(tab.id);
    return tab;
  };
  const close = (tab) => { if (tab && tabs.all().includes(tab)) tabs.close(tab.id); };
  const items = (model) => (model?.items || []).filter((i) => i.id);
  const describe = (model) => (model ? items(model).map((i) => i.id).join(',') : 'no menu');
  const find = (model, id) => items(model).find((i) => i.id === id);

  /**
   * A real right-click on an element, as the mouse sends it - on its first
   * line, so a block taller than the window is still under the pointer. With
   * `select`, its words are selected first, as a drag would; with 'keep',
   * whatever is selected stays so.
   */
  async function rightClick(tab, selector, { select = false } = {}) {
    const at = await js(tab, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'start' });
      const selection = getSelection();
      if (${select !== 'keep'}) selection.removeAllRanges();
      if (${select === true}) {
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.addRange(range);
      }
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + Math.min(12, r.width / 2)), y: Math.round(Math.max(r.top, 0) + Math.min(10, r.height / 2)) };
    })()`);
    if (!at || typeof at !== 'object') return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await t.inTime(js(tab, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'), 500);
      context.model = null;
      tab.wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
      tab.wc.sendInputEvent({ type: 'mouseDown', button: 'right', x: at.x, y: at.y, clickCount: 1 });
      tab.wc.sendInputEvent({ type: 'mouseUp', button: 'right', x: at.x, y: at.y, clickCount: 1 });
      if (await waitFor(() => context.model && context.model.tabId === tab.id, { timeoutMs: 2000, pollMs: 50 })) break;
    }
    const model = context.model && context.model.tabId === tab.id ? context.model : null;
    if (shell.sheetPage === 'context') shell.closeSheet();
    return model;
  }

  /** Run a command as the sheet would, and say whether it threw. */
  const run = (command, payload = null) => {
    try { runCommand(command, payload); return 'ran'; } catch (err) { return `threw ${err.message}`; }
  };
  /** Wait for a navigation that should not happen, then say where the tab is. */
  const stays = async (tab) => { await sleep(800); return tab.wc.getURL(); };

  try {
    const expected = translate.targetLanguage(prefs.get('translateTo'), app.getLocale());
    const language = translate.languageName(expected);

    /* -------------------------------------------------------------- */
    // A fixture page: served from this machine, on a port.
    const fixtureUrl = t.pageUrl('translate-page.html');
    const fixture = await open(fixtureUrl);
    ses = fixture.wc.session;

    // The stand-ins for the public web, Google's proxy and Google Translate.
    if (ses.protocol.isProtocolHandled('https')) {
      check('the public web can be stood in for, to see what is asked of Google', false, 'https is already handled in this session');
    } else {
      ses.protocol.handle('https', (request) => {
        asked.push(request.url);
        everAsked.add(request.url);
        const u = new URL(request.url);
        const html = (body) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (u.hostname === 'translate.google.com') return html(ECHO);
        if (u.hostname === 'down-example-com.translate.goog') return Response.error();
        if (u.hostname.endsWith('.translate.goog')) return html(TRANSLATED);
        if (STAND_INS.has(u.hostname) && u.pathname === '/translate-page.html') return html(FIXTURE);
        return new Response('not here', { status: 404 });
      });
      httpsHandled = true;
    }

    {
      const model = await rightClick(fixture, '#blank');
      const item = find(model, 'translate-page');
      const tabsBefore = tabs.all().length;
      const before = fixture.wc.getURL();
      const ran = run('translate-page');
      const after = await stays(fixture);
      // Google could not fetch it, so the item is shown but cannot be picked,
      // and picking it anyway (a keystroke, a stale menu) goes nowhere. It is
      // the port that refuses it: the .test name alone would not (see the
      // reserved names above).
      const portless = new URL(fixtureUrl);
      portless.port = '';
      check('on a page served from this machine, Translate page is shown but cannot be picked, and goes nowhere if run',
        item?.label === `Translate page to ${language} with Google` && item.enabled === false && ran === 'ran' &&
          after === before && tabs.all().length === tabsBefore && !asked.some((u) => u.includes('.translate.goog')),
        `${describe(model)}; item ${JSON.stringify(item)}; ${ran}; now at ${after}; ` +
        `the same page without its port would go to ${translate.pageUrl(portless.href, expected)}`);
    }

    {
      const quotes = await js(fixture, 'document.getElementById("quotes").innerText.trim()');
      const lines = await js(fixture, 'document.getElementById("lines").innerText.trim()');
      const longText = await js(fixture, 'document.getElementById("long").innerText.trim()');
      const q = await rightClick(fixture, '#quotes', { select: true });
      const l = await rightClick(fixture, '#lines', { select: true });
      const g = await rightClick(fixture, '#long', { select: true });
      const qi = find(q, 'translate-selection');
      const li = find(l, 'translate-selection');
      const gi = find(g, 'translate-selection');
      check('selected words on a page get Translate “…”, carrying them as selected - quotes, line breaks and 6,000 characters',
        qi?.label === `Translate “${contextMenu.ellipsis(quotes)}”` && qi.payload?.text === quotes &&
          li?.payload?.text === lines && lines.includes('\n') && !li.label.includes('\n') &&
          gi?.payload?.text === longText && longText.length > 6000 && !find(q, 'translate-page'),
        `quotes ${JSON.stringify(qi)}; lines ${JSON.stringify(li?.payload)}; long ${gi?.payload?.text?.length} of ${longText.length}`);

      const field = await rightClick(fixture, '#field', { select: false });
      await js(fixture, '(() => { const f = document.getElementById("field"); f.focus(); f.select(); })()');
      const fieldSelected = await rightClick(fixture, '#field', { select: 'keep' });
      check('words selected in a field are not offered for translation', Boolean(field) && Boolean(fieldSelected) &&
        !find(fieldSelected, 'translate-selection') && Boolean(find(fieldSelected, 'edit-paste')), describe(fieldSelected));

      // Picked, each opens Google Translate in a tab of its own, with the words.
      const results = [];
      for (const [name, it] of [['quotes', qi], ['lines', li], ['long', gi]]) {
        if (!it) { results.push({ name, missing: true }); continue; }
        const before = new Set(tabs.all());
        const ran = run(it.id, it.payload);
        await waitFor(() => tabs.all().some((x) => !before.has(x)), { timeoutMs: 3000 });
        const made = tabs.all().find((x) => !before.has(x));
        if (made) opened.push(made);
        const shown = made && (await loaded(made, 'translate.google.com'))
          ? await js(made, 'document.getElementById("text").textContent') : null;
        const u = made ? new URL(made.wc.getURL()) : null;
        if (u) visited.add(u.href);
        results.push({ name, ran, url: u && `${u.origin}${u.pathname}`, tl: u?.searchParams.get('tl'), front: tabs.activeTab() === made,
          shown: shown === it.payload.text.slice(0, 5000) ? 'same' : shown?.length });
        close(made);
        await tabs.activate(fixture.id);
      }
      check('Translate “…” opens Google Translate in a new tab, in front, with the words in it - the first 5,000 of a long one',
        results.every((r) => r.ran === 'ran' && r.url === 'https://translate.google.com/' && r.tl === expected && r.front &&
          r.shown === 'same'),
        JSON.stringify(results));
    }

    /* -------------------------------------------------------------- */
    // A page that tries to put the menu up itself.
    {
      context.model = null;
      const hostile = await open(t.pageUrl('translate-hostile.html'));
      await sleep(1200);
      const hasBridge = await js(hostile, 'typeof window.debrowser');
      check('a page that selects its own words and fires right-clicks at itself gets no translate menu, and no way to ask for one',
        context.model === null && hasBridge === 'undefined', `menu ${describe(context.model)}, bridge ${hasBridge}`);
      close(hostile);
    }

    /* -------------------------------------------------------------- */
    // The browser's own pages: nothing to send anywhere.
    {
      const existing = tabs.all().find((x) => x.internal && pages.pageName(x.url) === 'settings');
      const settings = existing || tabs.create({ url: pages.SETTINGS_URL, activate: true, realise: true });
      if (!existing) opened.push(settings);
      await tabs.activate(settings.id);
      await waitFor(() => settings.isLive && !settings.loading, { timeoutMs: 10_000 });
      await waitFor(async () => (await js(settings, 'document.querySelectorAll("#pref-translateTo option").length')) > 1,
        { timeoutMs: 5000 });
      const pageModel = await rightClick(settings, 'h1');
      const wordsModel = await rightClick(settings, 'h1', { select: true });
      check('the browser\'s own pages offer no translation, of the page or of words on it',
        Boolean(pageModel) && Boolean(wordsModel) && ![...items(pageModel), ...items(wordsModel)].some((i) => i.id.startsWith('translate')),
        `page ${describe(pageModel)}; words ${describe(wordsModel)}`);

      const before = settings.wc.getURL();
      const ran = [run('translate-page'), run('translate-original')];
      const after = await stays(settings);
      check('Translate page and Show original do nothing on the browser\'s own pages, whatever sends them',
        ran.every((r) => r === 'ran') && after === before, `${ran.join(',')}; at ${after}`);

      // The list as the page draws it, and a choice made in it.
      const options = await js(settings,
        '[...document.querySelectorAll("#pref-translateTo option")].map((o) => [o.value, o.textContent])');
      const values = Array.isArray(options) ? options.map(([v]) => v) : [];
      const bare = Array.isArray(options) ? options.filter(([v, name]) => !name || name === v).map(([v]) => v) : [];
      check('Settings lists the system\'s language and then each language by its name',
        values.join() === ['auto', ...translate.LANGUAGES].join() && bare.length === 0,
        `${values.length} options; unnamed ${bare.join(',') || 'none'}`);

      await js(settings, `(() => { const s = document.getElementById('pref-translateTo'); s.value = 'ja';
        s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      const picked = await waitFor(() => prefs.get('translateTo') === 'ja', { timeoutMs: 3000 });
      // A value Settings does not offer, sent as the page would send it.
      await js(settings, 'window.debrowser.send("set-pref", { key: "translateTo", value: "xx-evil" })');
      await js(settings, `(() => { const s = document.getElementById('pref-translateTo'); const o = document.createElement('option');
        o.value = 'tlh'; s.append(o); s.value = 'tlh'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(500);
      const kept = prefs.get('translateTo');
      const live = { set: prefs.set('translateTo', 'Klingon'), empty: prefs.set('translateTo', ''), nil: prefs.set('translateTo', null) };
      check('a language picked in Settings is saved, and one it does not offer is refused',
        picked && kept === 'ja' && prefs.get('translateTo') === 'ja' && Object.values(live).every((x) => x === false),
        `picked ${picked}, then ${kept}, direct sets ${JSON.stringify(live)}`);
      prefs.set('translateTo', prefsBefore.translateTo);
      if (!existing) close(settings);
    }

    /* -------------------------------------------------------------- */
    // The public web, stood in for: the page goes to Google's proxy and back.
    if (httpsHandled) {
      const original = 'https://www.example.com/translate-page.html?page=2#part';
      const site = await open(original, 'www.example.com');
      const model = await rightClick(site, '#blank');
      const item = find(model, 'translate-page');
      const starts = [];
      const onStart = (event, url, _inPlace, isMainFrame) => {
        const u = event?.url || url;
        const main = event?.isMainFrame ?? isMainFrame;
        if (main) starts.push(u);
      };
      site.wc.on('did-start-navigation', onStart);
      asked.length = 0;
      const ran = item ? run(item.id, item.payload) : 'no item';
      await waitFor(() => site.wc.getURL().includes('.translate.goog') && !site.loading, { timeoutMs: 8000 });
      const proxied = site.wc.getURL();
      const fetched = asked.find((u) => u.includes('.translate.goog')) || '';
      const want = translate.pageUrl(original, expected);
      check('Translate page loads the page through Google\'s proxy in the same tab, in the chosen language',
        item?.enabled === true && item.label === `Translate page to ${language} with Google` && ran === 'ran' &&
          proxied === want && starts[0] === want && fetched.split('#')[0] === want.split('#')[0] &&
          new URL(fetched).searchParams.get('_x_tr_tl') === expected,
        `item ${JSON.stringify(item)}; ${ran}; tab at ${proxied}; navigation started ${starts[0]}; Google asked for ${fetched}`);

      const translatedModel = await rightClick(site, '#blank');
      const again = run('translate-page');
      const stayed = await stays(site);
      check('a translated page offers Show original instead, and is not translated twice',
        Boolean(find(translatedModel, 'translate-original')) && !find(translatedModel, 'translate-page') &&
          again === 'ran' && stayed === proxied,
        `${describe(translatedModel)}; translating again left it at ${stayed}`);

      const back = find(translatedModel, 'translate-original');
      const ranBack = back ? run(back.id, back.payload) : 'no item';
      await waitFor(() => site.wc.getURL().startsWith('https://www.example.com/') && !site.loading, { timeoutMs: 8000 });
      check('Show original goes back to the page that was translated, its query and place on the page with it',
        ranBack === 'ran' && site.wc.getURL() === original, `${ranBack}; at ${site.wc.getURL()}`);

      // Show original on a page that was never translated goes nowhere.
      const notTranslated = run('translate-original');
      check('Show original on a page that is not translated goes nowhere',
        notTranslated === 'ran' && (await stays(site)) === original, site.wc.getURL());
      site.wc.off('did-start-navigation', onStart);

      // A page that has changed its own address since it loaded (pushState):
      // the address it is at now is the one translated.
      const moved = 'https://www.example.com/translate-page.html?after=1#moved';
      await js(site, 'history.pushState({}, "", "/translate-page.html?after=1#moved")');
      await waitFor(() => site.url === moved, { timeoutMs: 2000 });
      run('translate-page');
      await waitFor(() => site.wc.getURL().includes('.translate.goog') && !site.loading, { timeoutMs: 8000 });
      const movedTo = site.wc.getURL();
      run('translate-original');
      await waitFor(() => site.wc.getURL().startsWith('https://www.example.com/') && !site.loading, { timeoutMs: 8000 });
      check('a page that changed its own address is translated at the address it shows now, and comes back to it',
        movedTo === translate.pageUrl(moved, expected) && site.wc.getURL() === moved, `${movedTo}; back at ${site.wc.getURL()}`);

      // In another language, chosen in Settings: the menu says so and Google is told.
      prefs.set('translateTo', 'de');
      const german = await rightClick(site, '#blank');
      const germanWords = await rightClick(site, '#quotes', { select: true });
      asked.length = 0;
      run('translate-page');
      await waitFor(() => site.wc.getURL().includes('.translate.goog') && !site.loading, { timeoutMs: 8000 });
      const deUrl = new URL(site.wc.getURL());
      const beforeTabs = new Set(tabs.all());
      const wordsItem = find(germanWords, 'translate-selection');
      if (wordsItem) run(wordsItem.id, wordsItem.payload);
      await waitFor(() => tabs.all().some((x) => !beforeTabs.has(x)), { timeoutMs: 3000 });
      const wordsTab = tabs.all().find((x) => !beforeTabs.has(x));
      if (wordsTab) { opened.push(wordsTab); await loaded(wordsTab, 'translate.google.com'); }
      const wordsTl = wordsTab ? new URL(wordsTab.wc.getURL()).searchParams.get('tl') : null;
      check('a language chosen in Settings names the menu item and is the one Google is asked for',
        find(german, 'translate-page')?.label === 'Translate page to German with Google' &&
          deUrl.searchParams.get('_x_tr_tl') === 'de' && wordsTl === 'de',
        `${find(german, 'translate-page')?.label}; page tl ${deUrl.searchParams.get('_x_tr_tl')}; words tl ${wordsTl}`);
      close(wordsTab);
      prefs.set('translateTo', prefsBefore.translateTo);
      close(site);

      // A query written the site's way.
      const queried = 'https://news.example.org/translate-page.html?q=caf%C3%A9%20au%20lait&flag';
      const news = await open(queried, 'news.example.org');
      asked.length = 0;
      run('translate-page');
      await waitFor(() => news.wc.getURL().includes('.translate.goog') && !news.loading, { timeoutMs: 8000 });
      const sentQuery = new URL(asked.find((u) => u.includes('.translate.goog')) || 'https://none/').search;
      run('translate-original');
      await waitFor(() => news.wc.getURL().startsWith('https://news.example.org/') && !news.loading, { timeoutMs: 8000 });
      check('a page\'s query goes to Google, and back from Show original, as the site wrote it',
        sentQuery.startsWith('?q=caf%C3%A9%20au%20lait&flag&') && news.wc.getURL() === queried,
        `Google asked for ${sentQuery}; back at ${news.wc.getURL()}`);
      close(news);

      // An international name: right-click must still give a menu.
      uncaught.length = 0;
      const idnUrl = 'https://xn--mnchen-3ya.de/translate-page.html';
      const idn = await open(idnUrl, 'xn--mnchen-3ya.de');
      const idnModel = await rightClick(idn, '#blank');
      const idnItem = find(idnModel, 'translate-page');
      asked.length = 0;
      const idnRun = run('translate-page');
      await waitFor(() => idn.wc.getURL().includes('.translate.goog') && !idn.loading, { timeoutMs: 5000 });
      const idnAsked = asked.find((u) => u.includes('.translate.goog')) || 'nothing';
      check('right-click on a site with an international name (münchen.de) still opens the menu',
        Boolean(idnModel) && Boolean(find(idnModel, 'reload')) && idnRun === 'ran' && uncaught.length === 0,
        `menu ${describe(idnModel)}; translate-page ${idnRun}; uncaught ${JSON.stringify(uncaught.slice(0, 2))}`);
      // Offered and picked, it reaches Google - or it was not offered.
      check('Translate page on a site with an international name reaches Google\'s proxy, or is not offered',
        idnItem?.enabled === false || (idnAsked !== 'nothing' && idn.wc.getURL().includes('.translate.goog')),
        `item enabled ${idnItem?.enabled}; Google asked for ${idnAsked}; tab at ${idn.wc.getURL()}`);
      close(idn);

      // Google's proxy failing, as it does offline: the tab shows the failure,
      // and the browser is left with no error that nothing caught.
      rejected.length = 0;
      const down = await open('https://down.example.com/translate-page.html', 'down.example.com');
      run('translate-page');
      await sleep(1500);
      const downAt = down.wc.getURL();
      check('when Google\'s proxy cannot be reached, the failed load leaves no error nothing caught',
        rejected.length === 0, `tab at ${downAt}; unhandled ${JSON.stringify(rejected.slice(0, 2))}`);
      close(down);

      // A plain-HTTP site, with HTTPS-first off so it stays plain.
      prefs.set('httpsMode', 'off');
      if (!ses.protocol.isProtocolHandled('http')) {
        ses.protocol.handle('http', (request) => {
          const u = new URL(request.url);
          if (u.hostname === 'plain.example.net' && u.pathname === '/translate-page.html') {
            return new Response(FIXTURE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
          }
          return ses.fetch(request, { bypassCustomProtocolHandlers: true });
        });
        httpHandled = true;
        const plainUrl = 'http://plain.example.net/translate-page.html';
        const plain = await open(plainUrl, 'plain.example.net');
        const plainModel = await rightClick(plain, '#blank');
        asked.length = 0;
        run('translate-page');
        await waitFor(() => plain.wc.getURL().includes('.translate.goog') && !plain.loading, { timeoutMs: 8000 });
        const sent = asked.find((u) => u.includes('.translate.goog')) || '';
        run('translate-original');
        await waitFor(() => !plain.wc.getURL().includes('.translate.goog') && !plain.loading, { timeoutMs: 8000 });
        check('a plain-HTTP page is translated as one, and Show original goes back to it over HTTP',
          find(plainModel, 'translate-page')?.enabled === true && sent.includes('_x_tr_sch=http') &&
            plain.wc.getURL() === plainUrl,
          `Google asked for ${sent}; back at ${plain.wc.getURL()}`);
        close(plain);
        ses.protocol.unhandle('http');
        httpHandled = false;
      }
      prefs.set('httpsMode', prefsBefore.httpsMode);
    }

    // Selected words with nothing in them, or not words at all, open nothing.
    {
      const before = tabs.all().length;
      const ran = [null, {}, { text: '' }, { text: '   \n ' }].map((payload) => run('translate-selection', payload));
      await sleep(500);
      check('Translate “…” with no words opens nothing', ran.every((r) => r === 'ran') && tabs.all().length === before,
        `${ran.join(',')}; ${tabs.all().length - before} tab(s) opened`);
      for (const tab of tabs.all().slice(before)) { opened.push(tab); close(tab); }
    }

    check('nothing translation did left an error that nothing caught',
      uncaught.length === 0 && rejected.length === 0,
      `uncaught ${JSON.stringify(uncaught.slice(0, 3))}; unhandled ${JSON.stringify(rejected.slice(0, 3))}`);
  } finally {
    if (shell.sheetPage === 'context') shell.closeSheet();
    context.model = null;
    for (const tab of opened) close(tab);
    if (ses && httpHandled) ses.protocol.unhandle('http');
    if (ses && httpsHandled) ses.protocol.unhandle('https');
    if (prefs.get('translateTo') !== prefsBefore.translateTo) prefs.set('translateTo', prefsBefore.translateTo);
    if (prefs.get('httpsMode') !== prefsBefore.httpsMode) prefs.set('httpsMode', prefsBefore.httpsMode);
    if (history) {
      for (const url of [...visited, ...everAsked]) history.forgetSite(url);
    }
    // Late rejections from loads this closed, before the listeners go.
    await sleep(300);
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejected);
  }
};
