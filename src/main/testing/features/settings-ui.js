'use strict';

/**
 * The new controls in the browser's own pages, driven as a person drives them.
 *
 * Settings: the Sync section and its rail entry, "Translate pages into",
 * "Dark websites" and the Bookmarks import offer. The passwords page: the
 * address form, its rows, Fill, Delete and search. Pages are clicked and typed
 * into with real input events, and what they show is read back from the DOM.
 *
 * Then who may ask for what (main.js PAGE_POLICY, INCOGNITO_REFUSED and the
 * bridge's own list in chrome-preload.js): each new command and request sent
 * from the page that uses it, and from the pages that must not, including a
 * website - which has no bridge at all, and is refused at the browser when it
 * reaches the channel anyway.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const pages = require('../../pages');
const translate = require('../../translate');
const { isStopped } = require('../../config');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const read = (file) => { try { return fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { return ''; } };

const PASSCODE = 'settings-ui-smoke-passcode';
const HOME = {
  label: 'Home', name: 'Ada King Lovelace', organization: 'Analytical Engines', street: '12 Marylebone Road\nFlat 3',
  city: 'London', region: '', postal: 'NW1 5LR', country: 'United Kingdom', email: 'ada@example.test', tel: '+44 20 7946 0000'
};
const WORK = { label: 'Work', name: 'Charles Babbage', street: '1 Difference Way', city: 'Palo Alto', email: 'charles@example.test' };
// A name that would run if any row drew it as markup.
const HOSTILE_LABEL = '<img src=x onerror="document.title=\'owned\'">';

/** The new names, and the page each belongs to. */
const NEW_SETTINGS_REQUESTS = ['sync-status', 'sync-start', 'sync-now', 'sync-stop'];
const NEW_PASSWORDS_REQUESTS = ['save-address', 'fill-address'];
const NEW_SHEET_COMMANDS = ['translate-page', 'translate-original', 'translate-selection', 'toggle-site-dark',
  'fill-card-here', 'fill-address-here'];
const ALL_NEW = [...NEW_SETTINGS_REQUESTS, ...NEW_PASSWORDS_REQUESTS, ...NEW_SHEET_COMMANDS];

/** The quoted names in `new Set([...])` called `name` in `source`, comments left out. */
function setLiterals(source, name) {
  const start = source.indexOf(`const ${name} = new Set([`);
  if (start < 0) return null;
  const body = source.slice(start, source.indexOf(']);', start)).replace(/\/\/.*$/gm, '');
  return new Set([...body.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]));
}

/**
 * Every name a page script sends: the quoted names in the first argument of
 * each `api.send(`, `api.request(` and `ask(`, leaving out the ones only
 * compared against (`kind === 'payment' ? 'fill-payment' : ...`).
 */
function sentNames(source) {
  const names = new Set();
  const call = /\b(?:api\.send|api\.request|ask)\(/g;
  while (call.exec(source)) {
    let depth = 0;
    let quote = null;
    let arg = '';
    for (let i = call.lastIndex; i < source.length; i++) {
      const c = source[i];
      if (quote) { arg += c; if (c === quote && source[i - 1] !== '\\') quote = null; continue; }
      if (c === '\'' || c === '"' || c === '`') { quote = c; arg += c; continue; }
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
      if (c === ',' && depth === 0) break;
      arg += c;
    }
    for (const lit of arg.matchAll(/(?<![=!]==\s*)'([a-z][a-z0-9-]*)'/g)) names.add(lit[1]);
  }
  return names;
}

module.exports = async function settingsUi(t) {
  const { check, waitFor, sleep, tabs, shell, prefs, credentials, vault, runCommand, context, sitePrefs, app } = t;

  const kept = {
    darkWebsites: prefs.get('darkWebsites'),
    translateTo: prefs.get('translateTo'),
    key: credentials && credentials.key,
    loaded: credentials && credentials.loaded,
    unavailable: credentials && credentials.unavailable,
    records: credentials && credentials.records,
    capability: credentials && Object.prototype.hasOwnProperty.call(credentials, 'capability') ? credentials.capability : null,
    vaultRecord: vault && vault.record,
    unlockedUntil: vault && vault.unlockedUntil,
    failures: vault && vault.failures,
    blockedUntil: vault && vault.blockedUntil
  };
  const tabsBefore = tabs.all().length;
  const opened = [];
  const hosts = new Set();

  // Every console line from the browser's own pages while these run, so an
  // uncaught error or a refused name anywhere in them is seen.
  const lines = [];
  const watched = new Set();
  const watch = (wc) => {
    if (!wc || watched.has(wc.id)) return;
    watched.add(wc.id);
    wc.on('console-message', (event) => {
      lines.push({ level: event.level, message: String(event.message || ''), source: String(event.sourceId || ''),
        line: event.lineNumber, url: wc.isDestroyed() ? '' : wc.getURL() });
    });
  };
  const onCreated = (_event, wc) => watch(wc);
  app.on('web-contents-created', onCreated);
  const uncaught = () => lines.filter((l) => l.level === 'error' && l.message.startsWith('Uncaught') &&
    /\/src\/renderer\/|^debrowser:/.test(l.source));
  const refusals = () => lines.filter((l) => /refusing unknown (command|request)/.test(l.message));

  // Bounded: a page the browser has frozen in the background never answers,
  // and an unbounded wait hung the whole suite on a slow Windows runner.
  const js = (tab, code) => t.inTime(tab.wc.executeJavaScript(code).catch((err) => `threw ${err.message}`), 15_000, 'timed out');
  const ask = (tab, command, payload) => js(tab,
    `window.debrowser.request(${JSON.stringify(command)}, ${JSON.stringify(payload ?? null)})`);
  const tell = (tab, command, payload) => js(tab,
    `(window.debrowser.send(${JSON.stringify(command)}, ${JSON.stringify(payload ?? null)}), true)`);
  const loaded = (tab, part) => waitFor(() => tab.isLive && !tab.loading && tab.wc.getURL().includes(part), { timeoutMs: 10_000 });
  const open = async (url, { activate = true } = {}) => {
    const tab = tabs.create({ url, activate, realise: true });
    opened.push(tab);
    watch(tab.wc);
    await loaded(tab, url.split('/').pop().split('#')[0]);
    if (activate) await tabs.activate(tab.id);
    return tab;
  };
  /** Brings a page to the front, so it is awake to answer, as a user would by switching to it. */
  const wake = async (tab) => {
    if (!tab.isLive) tab.realise();
    await tabs.activate(tab.id);
    await waitFor(() => tab.isLive && !tab.loading, { timeoutMs: 10_000 }).catch(() => {});
  };
  const close = (tab) => { if (tab && tabs.all().includes(tab)) tabs.close(tab.id); };
  const frames = (tab) => t.inTime(js(tab, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'), 500);

  /**
   * Press the element `expr` finds with the mouse, at its middle, once it is
   * on screen and nothing covers it. Says what happened instead when it can't.
   */
  async function click(tab, expr, { button = 'left' } = {}) {
    const at = await js(tab, `(() => {
      const el = ${expr};
      if (!el) return 'not there';
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return 'not on screen';
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const top = document.elementFromPoint(x, y);
      if (!top || !(top === el || el.contains(top) || top.control === el)) return 'covered by ' + (top ? top.tagName + '.' + top.className : 'nothing');
      return { x, y };
    })()`);
    if (!at || typeof at !== 'object') return String(at);
    await frames(tab);
    // The page's points are CSS pixels; the mouse moves in the view's, which
    // differ by the page's zoom (Settings opens a step up).
    const zoom = tab.wc.getZoomFactor() || 1;
    const x = Math.round(at.x * zoom);
    const y = Math.round(at.y * zoom);
    tab.wc.sendInputEvent({ type: 'mouseMove', x, y });
    tab.wc.sendInputEvent({ type: 'mouseDown', button, x, y, clickCount: 1 });
    tab.wc.sendInputEvent({ type: 'mouseUp', button, x, y, clickCount: 1 });
    await frames(tab);
    return 'clicked';
  }

  /** Click into a field, select what it holds, and type over it. */
  async function type(tab, expr, text) {
    const clicked = await click(tab, expr);
    if (clicked !== 'clicked') return clicked;
    await js(tab, `(() => { const el = ${expr}; el.focus(); if (el.select) el.select(); return true; })()`);
    if (text) await tab.wc.insertText(text);
    else {
      tab.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      tab.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    }
    await frames(tab);
    return 'typed';
  }

  const byId = (id) => `document.getElementById(${JSON.stringify(id)})`;
  /** A button by its words, inside `scope`. */
  const buttonIn = (scope, text) =>
    `[...((${scope})?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;

  try {
    sourceChecks(t);
    const settingsTab = await settingsChecks();
    const pwTab = await passwordsChecks(settingsTab);
    await permissionChecks(settingsTab, pwTab);
    await websiteChecks(pwTab);
    await sheetChecks(settingsTab);

    const errors = uncaught();
    check('the browser\'s own pages raise no uncaught errors while their new controls are used',
      errors.length === 0, errors.slice(0, 5).map((e) => `${e.source.split('/').pop()}:${e.line} ${e.message.slice(0, 140)}`).join('; ') ||
        `${watched.size} pages watched`);
  } finally {
    if (shell.sheetPage === 'context') shell.closeSheet();
    context.model = null;
    app.removeListener('web-contents-created', onCreated);
    for (const tab of opened) close(tab);
    for (const host of hosts) if (sitePrefs && sitePrefs.get(host, 'dark') !== undefined) sitePrefs.set(host, 'dark', null);
    for (const key of ['darkWebsites', 'translateTo']) {
      if (prefs.get(key) !== kept[key]) runCommand('set-pref', { key, value: kept[key] });
    }
    if (credentials && vault) {
      try { credentials.clear(); } catch { /* nothing saved */ }
      credentials.key = kept.key;
      credentials.loaded = kept.loaded;
      credentials.unavailable = kept.unavailable;
      credentials.records = kept.records;
      if (kept.capability) credentials.capability = kept.capability;
      else delete credentials.capability;
      if (credentials.key) {
        for (const [kind, list] of Object.entries(kept.records || {})) if (list?.length) credentials.save(kind);
      }
      try { vault.write(kept.vaultRecord ?? null); } catch { /* memory only */ }
      vault.unlockedUntil = kept.unlockedUntil;
      vault.failures = kept.failures;
      vault.blockedUntil = kept.blockedUntil;
    }
  }

  await waitFor(() => tabs.all().length === tabsBefore, { timeoutMs: 3000 });
  check('the settings and passwords checks leave no tabs, settings, saved addresses or passcode behind',
    tabs.all().length === tabsBefore && prefs.get('darkWebsites') === kept.darkWebsites &&
      prefs.get('translateTo') === kept.translateTo && (!vault || vault.configured() === Boolean(kept.vaultRecord)) &&
      (!credentials || credentials.key === kept.key) &&
      [...hosts].every((h) => !sitePrefs || sitePrefs.get(h, 'dark') === undefined),
    `tabs ${tabsBefore} -> ${tabs.all().length}, dark websites ${prefs.get('darkWebsites')}, translate to ${prefs.get('translateTo')}, ` +
    `passcode ${vault && vault.configured()}`);

  /* ================================================================ */
  /* What the code says each page sends, against what the bridge passes */
  /* ================================================================ */

  function sourceChecks() {
    const preload = read('src/preload/chrome-preload.js');
    const main = read('src/main/main.js');
    const allowed = setLiterals(preload, 'COMMANDS') || new Set();
    const refusedPrivately = setLiterals(main, 'INCOGNITO_REFUSED') || new Set();

    const used = {
      'settings.js': sentNames(read('src/renderer/settings.js')),
      'passwords.js': sentNames(read('src/renderer/passwords.js')),
      'theme.js': sentNames(read('src/renderer/theme.js')),
      // The page menu's items, which the sheet sends back by their id.
      'context-menu.js': new Set([...read('src/main/context-menu.js').matchAll(/\bid: '([a-z][a-z0-9-]*)'/g)].map((m) => m[1]))
    };
    const missing = Object.entries(used).flatMap(([file, names]) =>
      [...names].filter((n) => !allowed.has(n)).map((n) => `${n} (${file})`));
    check('every command and request Settings, the passwords page and the page menu send is one the page bridge lets through',
      allowed.size > 100 && used['settings.js'].has('sync-start') && used['passwords.js'].has('save-address') &&
        used['passwords.js'].has('fill-address') && used['context-menu.js'].has('toggle-site-dark') && missing.length === 0,
      missing.length ? `not in chrome-preload.js COMMANDS: ${missing.join(', ')}` :
        `${allowed.size} allowed; ${Object.entries(used).map(([f, s]) => `${f} ${s.size}`).join(', ')}`);

    const unhandled = ALL_NEW.filter((n) => !main.includes(`case '${n}'`));
    check('each new command and request has a handler in the browser, so none is passed through to nothing',
      unhandled.length === 0, unhandled.join(', ') || ALL_NEW.join(', '));

    // Everything new that writes to the profile or reaches out on its own.
    // Showing the original of a translated page does neither.
    const privateOff = ALL_NEW.filter((n) => n !== 'translate-original' && !refusedPrivately.has(n));
    check('a private window refuses every new command that saves, fills, syncs or sends a page to Google',
      refusedPrivately.size > 20 && privateOff.length === 0, privateOff.join(', ') || `${refusedPrivately.size} refused`);

    // The two lists of languages: Settings draws its own, and the browser
    // accepts only its own.
    const settingsList = (read('src/renderer/settings.js').match(/const TRANSLATE_LANGUAGES = \[([\s\S]*?)\];/) || [])[1] || '';
    const listed = [...settingsList.matchAll(/'([A-Za-z-]+)'/g)].map((m) => m[1]);
    check('Settings offers exactly the languages the browser translates into',
      listed.length > 50 && listed.join(',') === translate.LANGUAGES.join(','),
      `${listed.length} in settings.js, ${translate.LANGUAGES.length} in translate.js; ` +
      `only in Settings: ${listed.filter((c) => !translate.LANGUAGES.includes(c)).join(',') || 'none'}, ` +
      `only in the browser: ${translate.LANGUAGES.filter((c) => !listed.includes(c)).join(',') || 'none'}`);

    // The extractor itself, on the shapes these pages use.
    const sample = sentNames(`api.send('a-b', x); ask(kind === 'payment' ? 'fill-payment' : 'fill-address', { id });
      api.request('sync-status'); api.send(item.id, item.payload || null); ask('delete-credential', { kind, id })`);
    check('the name reader finds sent names and skips compared ones',
      [...sample].sort().join(',') === 'a-b,delete-credential,fill-address,fill-payment,sync-status', [...sample].join(','));
  }

  /* ================================================================ */
  /* Settings                                                          */
  /* ================================================================ */

  /** Show a section by pressing its entry in the rail, opening the drawer first in a narrow window. */
  async function railTo(tab, name) {
    const item = `[...document.querySelectorAll('.rail-item')].find((b) => b.textContent.trim() === ${JSON.stringify(name)})`;
    let pressed = await click(tab, item);
    if (pressed !== 'clicked') {
      await click(tab, byId('rail-toggle'));
      pressed = await click(tab, item);
    }
    return pressed;
  }
  function sectionShown(tab, section) {
    return js(tab, `(() => {
      const s = document.querySelector('section[data-section=${JSON.stringify(section)}]');
      return Boolean(s && !s.hidden && s.getBoundingClientRect().height > 0);
    })()`);
  }

  async function settingsChecks() {
    const settings = await open(pages.SETTINGS_URL);
    const built = await waitFor(async () => (await js(settings,
      'document.querySelectorAll(".rail-item").length > 5 && Boolean(document.querySelector("#sync-rows .row"))')) === true,
    { timeoutMs: 8000 });

    // The rail, built from the sections: Sync among them, in the page's order.
    const rail = await js(settings, '[...document.querySelectorAll(".rail-item")].map((b) => b.textContent.trim())');
    const headings = await js(settings, '[...document.querySelectorAll("main > section h2")].map((h) => h.textContent.trim())');
    const pressed = await railTo(settings, 'Sync');
    const shown = await waitFor(() => sectionShown(settings, 'sync'), { timeoutMs: 2000 });
    const row = await js(settings, `(() => {
      const row = document.querySelector('#sync-rows .row');
      const pass = row && row.querySelector('input');
      const button = row && row.querySelector('button');
      return row && {
        label: row.querySelector('.row-label')?.textContent, hint: row.querySelector('.row-hint')?.textContent,
        type: pass?.type, auto: pass?.autocomplete, name: pass?.getAttribute('aria-label'), button: button?.textContent,
        disabled: button?.disabled, note: document.getElementById('sync-state').textContent,
        onScreen: pass ? pass.getBoundingClientRect().width > 0 : false
      };
    })()`);
    check('Settings lists Sync in its rail, and pressing it shows "Turn on sync" with a passphrase field',
      built && Array.isArray(rail) && rail.includes('Sync') && JSON.stringify(rail) === JSON.stringify(headings) &&
        pressed === 'clicked' && shown && row && row.label === 'Turn on sync' && row.type === 'password' &&
        row.auto === 'new-password' && row.name === 'Sync passphrase' && row.button === 'Choose folder…' && row.onScreen,
      `rail ${JSON.stringify(rail)}, pressed ${pressed}, shown ${shown}, row ${JSON.stringify(row)}`);

    // No Sync under the test (OFFLINE_MODE): the browser still answers, and
    // the page says why instead of offering a button that does nothing.
    const status = await ask(settings, 'sync-status');
    check('Settings is told sync is off and why, even where this browser has no sync, and its button is not offered',
      status && status.on === false && status.available === false && typeof status.reason === 'string' &&
        row && row.disabled === true && /isn’t available/.test(row.note),
      `sync-status ${JSON.stringify(status)}, button disabled ${row && row.disabled}, note "${row && row.note}"`);

    // A passphrase typed into it stays typed: nothing redraws the row under the user.
    const typed = await type(settings, 'document.querySelector("#sync-rows input")', 'a long sync passphrase');
    await sleep(1200);
    const held = await js(settings, 'document.querySelector("#sync-rows input").value');
    check('a passphrase typed into the sync field is still there after the page\'s state updates',
      typed === 'typed' && held === 'a long sync passphrase', `typed ${typed}, field holds "${held}"`);
    await js(settings, 'document.querySelector("#sync-rows input").value = ""');

    // A section asked for by address, as the menu and other pages ask: the
    // open Settings tab turns to it, and no second one opens.
    await railTo(settings, 'Appearance');
    const settingsTabs = () => tabs.all().filter((x) => x.internal && pages.pageName(x.url) === 'settings').length;
    const before = settingsTabs();
    t.openInternalPage(tabs, `${pages.SETTINGS_URL}#sync`);
    const turned = await waitFor(() => sectionShown(settings, 'sync'), { timeoutMs: 3000 });
    check('asking for settings#sync turns the open Settings tab to Sync instead of opening another',
      turned && settingsTabs() === before, `shown ${turned}, Settings tabs ${before} -> ${settingsTabs()}`);

    /* -------------------------------------------------------------- */
    // Translate pages into: the system's language, then every language by name.
    const translateRow = await railTo(settings, 'Search and startup');
    const options = await js(settings, `[...document.querySelectorAll('#pref-translateTo option')].map((o) => [o.value, o.textContent])`);
    const list = Array.isArray(options) ? options : [];
    const codes = list.slice(1).map(([v]) => v);
    const names = list.slice(1).map(([, n]) => n);
    const unreadable = list.slice(1).filter(([v, n]) => !n || n === v || /^[a-z]{2,3}(-[A-Z]{2})?$/.test(n));
    const repeated = names.filter((n, i) => names.indexOf(n) !== i);
    check('"Translate pages into" offers your system\'s language first, then every language by its name',
      translateRow === 'clicked' && list.length === translate.LANGUAGES.length + 1 && list[0][0] === 'auto' &&
        /system/i.test(list[0][1]) && codes.join(',') === translate.LANGUAGES.join(',') &&
        unreadable.length === 0 && repeated.length === 0 && names.includes('French') && names.includes('Japanese'),
      `${list.length} options, first ${JSON.stringify(list[0])}, unreadable ${JSON.stringify(unreadable.slice(0, 5))}, ` +
      `repeated ${repeated.join(',') || 'none'}`);

    // Picked as a person picks it: the list opened from the keyboard, French
    // chosen, the choice committed.
    const picked = await js(settings, `(() => {
      const s = document.getElementById('pref-translateTo');
      s.focus();
      s.value = 'fr';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return s.value;
    })()`);
    const took = await waitFor(() => prefs.get('translateTo') === 'fr', { timeoutMs: 2000 });
    // And from elsewhere: the list follows a change it did not make.
    runCommand('set-pref', { key: 'translateTo', value: 'de' });
    const follows = await waitFor(async () => (await js(settings, 'document.getElementById("pref-translateTo").value')) === 'de',
      { timeoutMs: 3000 });
    runCommand('set-pref', { key: 'translateTo', value: 'fr' });
    check('choosing a language in Settings keeps it, and the list shows a choice made elsewhere',
      picked === 'fr' && took && follows, `picked ${picked}, saved ${prefs.get('translateTo')}, follows ${follows}`);

    // Not a language the browser has: refused, and the list keeps its choice.
    runCommand('set-pref', { key: 'translateTo', value: 'xx-EVIL' });
    runCommand('set-pref', { key: 'translateTo', value: '<b>' });
    await sleep(600);
    const after = await js(settings, 'document.getElementById("pref-translateTo").value');
    check('a language that is not in the list is refused, and the setting keeps the one chosen',
      prefs.get('translateTo') === 'fr' && after === 'fr', `saved ${prefs.get('translateTo')}, list shows ${after}`);

    /* -------------------------------------------------------------- */
    // Dark websites: ticked with the mouse.
    await railTo(settings, 'Appearance');
    const wasOn = prefs.get('darkWebsites') === true;
    if (wasOn) runCommand('set-pref', { key: 'darkWebsites', value: false });
    await waitFor(async () => (await js(settings, 'document.getElementById("pref-darkWebsites").checked')) === false, { timeoutMs: 3000 });
    const ticked = await click(settings, byId('pref-darkWebsites'));
    const on = await waitFor(() => prefs.get('darkWebsites') === true, { timeoutMs: 2000 });
    const box = await js(settings, 'document.getElementById("pref-darkWebsites").checked');
    const hint = await js(settings, 'document.getElementById("pref-darkWebsites").closest(".row").querySelector(".row-hint")?.textContent');
    check('ticking "Dark websites" in Settings turns it on',
      ticked === 'clicked' && on && box === true && /Right-click a page/.test(hint || ''),
      `click ${ticked}, setting ${prefs.get('darkWebsites')}, box ${box}, hint "${hint}"`);
    // Its label is a label: pressing the words ticks it too.
    const byLabel = await click(settings, `document.querySelector('label[for="pref-darkWebsites"]')`);
    const off = await waitFor(() => prefs.get('darkWebsites') === false, { timeoutMs: 2000 });
    await click(settings, byId('pref-darkWebsites'));
    const backOn = await waitFor(() => prefs.get('darkWebsites') === true, { timeoutMs: 2000 });
    check('pressing the words "Dark websites" switches it as the box does',
      byLabel === 'clicked' && off && backOn, `label ${byLabel}, off ${off}, on again ${backOn}`);

    // Kept across a restart: read back from the file by a fresh store, and
    // shown by Settings opened again.
    const { Prefs } = require('../../prefs');
    const onDisk = await waitFor(() => {
      const again = new Prefs(() => {}, { file: prefs.file, readOnly: true });
      return again.get('darkWebsites') === true && again.get('translateTo') === 'fr';
    }, { timeoutMs: 4000 });
    settings.wc.reload();
    await waitFor(async () => (await js(settings, 'document.querySelectorAll(".rail-item").length > 5')) === true, { timeoutMs: 8000 });
    const reopened = await js(settings, `[document.getElementById('pref-darkWebsites')?.checked, document.getElementById('pref-translateTo')?.value]`);
    check('Dark websites and the translation language are kept on disk, and Settings opened again shows them',
      onDisk && Array.isArray(reopened) && reopened[0] === true && reopened[1] === 'fr', `on disk ${onDisk}, reopened ${JSON.stringify(reopened)}`);

    /* -------------------------------------------------------------- */
    // Bookmarks: importing names Safari, and a Safari profile is shown as one.
    await railTo(settings, 'Bookmarks');
    const offer = await js(settings, `(() => {
      const row = [...document.querySelectorAll('#bookmark-actions .row')]
        .find((r) => r.querySelector('.row-label')?.textContent === 'Import from a browser on this machine');
      return row ? row.querySelector('.row-hint').textContent : null;
    })()`);
    check('the Bookmarks import offer says it looks for Safari as well as the others',
      typeof offer === 'string' && /Safari/.test(offer) && /Chrome/.test(offer) && /Firefox/.test(offer), String(offer));

    // "Find browsers", pressed: whatever this machine has, it answers.
    const find = await click(settings, buttonIn(byId('bookmark-actions'), 'Find browsers'));
    const answered = await waitFor(async () => Boolean(await js(settings, 'document.getElementById("bookmark-state").textContent.trim()')),
      { timeoutMs: 5000 });
    const said = await js(settings, 'document.getElementById("bookmark-state").textContent');
    check('pressing "Find browsers" says what it found on this computer',
      find === 'clicked' && answered && /(No other browsers found|Found \d+ profile)/.test(said || ''), `${find}: "${said}"`);

    // The list as it is drawn for a Mac with Safari, a Firefox fork and a
    // browser whose name is markup; then Import on one that has since gone.
    const drawn = await js(settings, `(() => {
      renderProfiles([
        { browser: 'Safari', kind: 'safari', path: '/nowhere/Safari' },
        { browser: 'Zen', kind: 'firefox', path: '/nowhere/zen' },
        { browser: ${JSON.stringify(HOSTILE_LABEL)}, kind: 'chromium', path: '/nowhere/evil' }
      ], document.getElementById('bookmark-state'), document.getElementById('bookmark-list'));
      return [...document.querySelectorAll('#bookmark-list .row')].map((r) => [r.querySelector('.row-label').textContent, r.querySelector('.row-hint').textContent]);
    })()`);
    const markup = await js(settings, 'document.querySelectorAll("#bookmark-list img").length');
    const importGone = await click(settings, `[...document.querySelectorAll('#bookmark-list .row')][0]?.querySelector('button')`);
    await waitFor(async () => /no longer there/.test(await js(settings, 'document.getElementById("bookmark-state").textContent')), { timeoutMs: 3000 });
    const why = await js(settings, 'document.getElementById("bookmark-state").textContent');
    check('a Safari profile is listed as Safari on this Mac, a browser\'s name is shown as words, and one that has gone says so',
      Array.isArray(drawn) && drawn[0]?.[1] === 'Safari, on this Mac' && drawn[1]?.[1] === 'Firefox-family profile' &&
        drawn[2]?.[0] === HOSTILE_LABEL && markup === 0 && importGone === 'clicked' && /no longer there/.test(why || ''),
      `rows ${JSON.stringify(drawn)}, img ${markup}, import ${importGone}: "${why}"`);
    await js(settings, 'renderBookmarks()');

    /* -------------------------------------------------------------- */
    // Searching Settings finds the new rows by the words a person would type.
    const search = async (words) => {
      await type(settings, byId('q'), words);
      await sleep(150);
      return js(settings, `[...document.querySelectorAll('main .row')].filter((r) => !r.hidden && !r.closest('section[hidden]') &&
        r.getBoundingClientRect().height > 0).map((r) => r.querySelector('.row-label')?.textContent || '')`);
    };
    const forSync = await search('sync');
    const forSafari = await search('safari');
    const forTranslate = await search('translate');
    const forDark = await search('dark websites');
    await type(settings, byId('q'), '');
    await sleep(150);
    check('searching Settings for sync, Safari, translate or dark websites finds those rows',
      Array.isArray(forSync) && forSync.includes('Turn on sync') && Array.isArray(forSafari) &&
        forSafari.includes('Import from a browser on this machine') && Array.isArray(forTranslate) &&
        forTranslate.includes('Translate pages into') && Array.isArray(forDark) && forDark.includes('Dark websites'),
      `sync ${JSON.stringify(forSync)}, safari ${JSON.stringify(forSafari)}, translate ${JSON.stringify(forTranslate)}, ` +
      `dark ${JSON.stringify(forDark)}`);

    return settings;
  }

  /* ================================================================ */
  /* The passwords page                                                */
  /* ================================================================ */

  async function passwordsChecks(settings) {
    if (!credentials || !vault) {
      check('the passwords page has a store and a lock to test', false, 'no credentials or vault in this run');
      return null;
    }
    // A key handed in, as the other credential checks do: a test machine has no keyring.
    if (vault.configured()) vault.write(null);
    credentials.key = crypto.randomBytes(32);
    credentials.loaded = true;
    credentials.unavailable = null;
    credentials.capability = () => ({ available: true, reason: null });
    credentials.records = { login: [], payment: [], address: [], passkey: [] };
    const set = await ask(settings, 'vault-set', { passcode: PASSCODE });

    const pw = await open(pages.PASSWORDS_URL);
    // Unlocked by typing the passcode and pressing Unlock.
    await waitFor(async () => (await js(pw, '!document.getElementById("locked").hidden')) === true, { timeoutMs: 5000 });
    const typed = await type(pw, byId('passcode'), PASSCODE);
    const unlockPress = await click(pw, byId('unlock'));
    const opened = await waitFor(async () => (await js(pw, '!document.getElementById("open").hidden')) === true, { timeoutMs: 5000 });
    check('the passwords page opens with the passcode typed into it',
      Boolean(set && set.ok) && typed === 'typed' && unlockPress === 'clicked' && opened && vault.unlocked(),
      `set ${JSON.stringify(set)}, typed ${typed}, unlock ${unlockPress}, open ${opened}`);

    const addressRows = () => js(pw, `[...document.querySelectorAll('#addresses .row')].filter((r) => !r.hidden).map((r) => ({
      label: r.querySelector('.row-label').textContent, summary: r.querySelector('.row-hint').textContent,
      buttons: [...r.querySelectorAll('button')].map((b) => b.textContent), text: r.textContent }))`);
    const emptyNote = () => js(pw, '(() => { const n = document.getElementById("addresses-empty"); return n.hidden ? null : n.textContent; })()');
    const error = () => js(pw, 'document.getElementById("address-error").textContent');
    const openForm = async () => {
      if ((await js(pw, 'document.getElementById("add-address").open')) !== true) {
        await click(pw, 'document.querySelector("#add-address > summary")');
      }
      return js(pw, 'document.getElementById("add-address").open');
    };
    const fill = async (record) => {
      for (const key of ['label', 'name', 'organization', 'street', 'city', 'region', 'postal', 'country', 'email', 'tel']) {
        if (record[key] === undefined) continue;
        const said = await type(pw, byId(`address-${key}`), record[key]);
        if (said !== 'typed') return `${key}: ${said}`;
      }
      return 'filled';
    };
    const save = () => click(pw, 'document.querySelector("#address-form button[type=submit]")');
    const resetForm = () => js(pw, 'document.getElementById("address-form").reset(), document.getElementById("address-error").textContent = "", true');

    const none = await emptyNote();
    check('with nothing saved, Addresses says so and how to fill one',
      typeof none === 'string' && /None saved/.test(none) && (await addressRows()).length === 0, String(none));

    /* -------------------------------------------------------------- */
    // The empty form: Save does nothing, and only a label is not enough.
    const formOpen = await openForm();
    const emptySave = await save();
    await sleep(300);
    const emptyValid = await js(pw, 'document.getElementById("address-form").checkValidity()');
    const emptyRecords = credentials.records.address.length;
    await fill({ label: 'Nothing else' });
    await save();
    await waitFor(async () => Boolean(await error()), { timeoutMs: 2000 });
    const onlyLabel = await error();
    check('an address form with nothing in it saves nothing, and one with only a name for it asks for more',
      formOpen === true && emptySave === 'clicked' && emptyValid === false && emptyRecords === 0 &&
        onlyLabel === 'Add at least a name, a street or an email.' && credentials.records.address.length === 0 &&
        (await addressRows()).length === 0,
      `form ${formOpen}, empty valid ${emptyValid}, saved ${credentials.records.address.length}, error "${onlyLabel}"`);

    // A name for it made only of spaces: refused, and the page says so.
    await resetForm();
    await fill({ label: '   ', name: 'Nobody At All' });
    await save();
    await waitFor(async () => Boolean(await error()), { timeoutMs: 2000 });
    const spaces = await error();
    check('an address named only with spaces is not saved, and the form says it was not',
      Boolean(spaces) && credentials.records.address.length === 0 && (await addressRows()).length === 0, `error "${spaces}"`);
    await resetForm();

    /* -------------------------------------------------------------- */
    // Typed in and saved, twice.
    const filledHome = await fill(HOME);
    const savedHome = await save();
    const homeRow = await waitFor(async () => (await addressRows()).some((r) => r.label === 'Home'), { timeoutMs: 3000 });
    const formAfter = await js(pw, `({ open: document.getElementById('add-address').open, label: document.getElementById('address-label').value,
      error: document.getElementById('address-error').textContent })`);
    const kept1 = credentials.reveal('address', 'Home');
    const rows1 = await addressRows();
    const home = rows1.find((r) => r.label === 'Home');
    check('an address typed into the form and saved is listed with its name, street and town, and the form clears',
      filledHome === 'filled' && savedHome === 'clicked' && homeRow && home &&
        home.summary === 'Ada King Lovelace, 12 Marylebone Road, London' &&
        kept1 && Object.entries(HOME).every(([k, v]) => kept1[k] === v) &&
        formAfter.open === false && formAfter.label === '' && formAfter.error === '' && (await emptyNote()) === null,
      `filled ${filledHome}, row ${JSON.stringify(home)}, saved ${JSON.stringify(kept1)}, form ${JSON.stringify(formAfter)}`);
    check('an address\'s row shows no email or phone number, and offers Fill and Delete but nothing to reveal',
      home && !home.text.includes(HOME.email) && !home.text.includes(HOME.tel) && !home.text.includes(HOME.postal) &&
        JSON.stringify(home.buttons) === JSON.stringify(['Fill', 'Delete']),
      home ? `buttons ${JSON.stringify(home.buttons)}, text "${home.text}"` : 'no row');

    await openForm();
    await fill(WORK);
    await save();
    await waitFor(async () => (await addressRows()).length === 2, { timeoutMs: 3000 });
    await openForm();
    await fill({ label: HOSTILE_LABEL, name: 'Mallory' });
    await save();
    await waitFor(async () => (await addressRows()).length === 3, { timeoutMs: 3000 });
    const rows3 = await addressRows();
    const evil = rows3.find((r) => r.label === HOSTILE_LABEL);
    const injected = await js(pw, '({ img: document.querySelectorAll("#addresses img").length, title: document.title })');
    check('an address whose name is markup is listed as those words and runs nothing',
      Boolean(evil) && evil.summary === 'Mallory' && injected.img === 0 && injected.title === 'Passwords',
      `rows ${JSON.stringify(rows3.map((r) => r.label))}, ${JSON.stringify(injected)}`);

    /* -------------------------------------------------------------- */
    // Search, as typed into the page's own field.
    const searchFor = async (words) => {
      await type(pw, byId('q'), words);
      await sleep(100);
      return (await addressRows()).map((r) => r.label);
    };
    const byCity = await searchFor('palo');
    const byLabel = await searchFor('HOME');
    const byName = await searchFor('babbage');
    const nothing = await searchFor('zzqx');
    const cleared = await searchFor('');
    check('searching the passwords page narrows Addresses by name, label or town, and clearing it brings them all back',
      JSON.stringify(byCity) === '["Work"]' && JSON.stringify(byLabel) === '["Home"]' && JSON.stringify(byName) === '["Work"]' &&
        nothing.length === 0 && cleared.length === 3,
      `palo ${JSON.stringify(byCity)}, HOME ${JSON.stringify(byLabel)}, babbage ${JSON.stringify(byName)}, ` +
      `zzqx ${JSON.stringify(nothing)}, cleared ${cleared.length}`);

    /* -------------------------------------------------------------- */
    // Fill: into the shop the user was on before coming here.
    const rowOf = (label) => `[...document.querySelectorAll('#addresses .row')]
      .find((r) => r.querySelector('.row-label').textContent === ${JSON.stringify(label)})`;
    const rowButton = (label, text) => buttonIn(rowOf(label), text);
    const shop = await open(t.pageUrl('settings-ui-address.html'));
    await tabs.activate(pw.id);
    await frames(pw);
    const fillPress = await click(pw, rowButton('Home', 'Fill'));
    const got = await waitFor(async () => (await js(shop, 'document.getElementById("full").value')) === HOME.name, { timeoutMs: 3000 });
    const values = await js(shop, 'Object.fromEntries([...document.querySelectorAll("input, textarea")].map((e) => [e.id, e.value]))');
    const fillSaid = await js(pw, `(${rowButton('Home', 'Filled')})?.textContent`);
    check('Fill on an address puts it into the page the user was on, and the button says Filled',
      fillPress === 'clicked' && got && values.street === HOME.street && values.city === HOME.city &&
        values.postal === HOME.postal && values.email === HOME.email && fillSaid === 'Filled',
      `press ${fillPress}, page ${JSON.stringify(values)}, button ${fillSaid}`);

    // The shop now holds what was filled, so putting it to sleep can only
    // freeze it: alive, kept as it is, and woken in milliseconds. The user
    // pressing Fill means it - the page is still there to fill.
    const workButton = (text) => rowButton('Work', text);
    const workSays = () => js(pw, `(${rowOf('Work')})?.querySelector('button')?.textContent`);
    runCommand('sleep-tab', { id: shop.id });
    const frozen = await waitFor(() => shop.isLive && isStopped(shop.tier), { timeoutMs: 5000 });
    await waitFor(async () => (await workSays()) === 'Fill', { timeoutMs: 3000 });
    const frozenPress = await click(pw, workButton('Fill'));
    await waitFor(async () => (await workSays()) !== 'Fill', { timeoutMs: 3000 });
    const frozenSaid = await workSays();
    const wokenName = await waitFor(async () => (await t.inTime(js(shop, 'document.getElementById("full").value'), 500, null)) === WORK.name,
      { timeoutMs: 2000 });
    check('Fill puts an address into the page the user was on even when the browser has frozen that page in the background',
      frozen && frozenPress === 'clicked' && frozenSaid === 'Filled' && wokenName,
      `page ${shop.isLive ? 'alive' : 'gone'} at tier ${shop.tier}, press ${frozenPress}, button "${frozenSaid}", ` +
      `name field ${wokenName ? 'filled' : 'not filled'}`);
    close(shop);

    // A page whose renderer is gone has nothing to fill, and the user is told
    // so rather than an older page being filled in its place.
    const left = await open(t.pageUrl('settings-ui-address.html'));
    await tabs.activate(pw.id);
    runCommand('sleep-tab', { id: left.id });
    const discarded = await waitFor(() => !left.isLive, { timeoutMs: 5000 });
    await waitFor(async () => (await workSays()) === 'Fill', { timeoutMs: 3000 });
    const gonePress = await click(pw, workButton('Fill'));
    await waitFor(async () => (await workSays()) !== 'Fill', { timeoutMs: 3000 });
    const goneSaid = await workSays();
    check('Fill with no page left to fill says so instead of filling some other tab',
      discarded && gonePress === 'clicked' && goneSaid === 'No page to fill',
      `discarded ${discarded} (tier ${left.tier}), press ${gonePress}, button "${goneSaid}"`);
    close(left);

    /* -------------------------------------------------------------- */
    // Delete: two presses, and a press then a click elsewhere starts over.
    const deleteButton = (label) => `(${rowOf(label)})?.querySelector('button.danger')`;
    const firstPress = await click(pw, deleteButton('Work'));
    const asks = await js(pw, `(${deleteButton('Work')})?.textContent`);
    const stillThere = Boolean(credentials.reveal('address', 'Work'));
    const secondPress = await click(pw, deleteButton('Work'));
    const gone = await waitFor(async () => !(await addressRows()).some((r) => r.label === 'Work'), { timeoutMs: 3000 });
    check('Delete on an address asks "Delete?" first, and only the second press deletes it',
      firstPress === 'clicked' && asks === 'Delete?' && stillThere && secondPress === 'clicked' && gone &&
        !credentials.reveal('address', 'Work'),
      `first ${firstPress} -> "${asks}" (still saved ${stillThere}), second ${secondPress}, gone ${gone}`);

    await click(pw, deleteButton('Home'));
    const armed = await js(pw, `(${deleteButton('Home')})?.textContent`);
    await click(pw, 'document.querySelector("header h1")');
    const disarmed = await js(pw, `(${deleteButton('Home')})?.textContent`);
    await click(pw, deleteButton('Home'));
    await sleep(300);
    const afterOne = Boolean(credentials.reveal('address', 'Home')) && (await addressRows()).some((r) => r.label === 'Home');
    await click(pw, 'document.querySelector("header h1")');
    check('a Delete pressed once and then left goes back to Delete, and the next press asks again rather than deleting',
      armed === 'Delete?' && disarmed === 'Delete' && afterOne, `armed "${armed}", after leaving "${disarmed}", kept ${afterOne}`);

    return pw;
  }

  /* ================================================================ */
  /* Who may ask for what                                              */
  /* ================================================================ */

  async function permissionChecks(settings, pw) {
    await wake(settings);
    // The refusal is seen: the bridge warns for a name it does not know.
    const mark = lines.length;
    await tell(settings, 'settings-ui-not-a-command');
    await ask(settings, 'settings-ui-not-a-request');
    await sleep(200);
    const seen = refusals().filter((l) => lines.indexOf(l) >= mark).length;
    check('the page bridge refuses a name it does not know, and says so in the page\'s console', seen === 2, `${seen} warnings`);

    // Settings: each of its new requests reaches the browser and is answered.
    const fromSettings = {};
    const before = lines.length;
    for (const name of NEW_SETTINGS_REQUESTS) fromSettings[name] = await ask(settings, name, name === 'sync-start' ? { passphrase: 'x'.repeat(12) } : null);
    const settingsRefused = refusals().filter((l) => lines.indexOf(l) >= before);
    check('each sync request Settings makes reaches the browser and gets an answer',
      NEW_SETTINGS_REQUESTS.every((n) => fromSettings[n] && typeof fromSettings[n] === 'object') && settingsRefused.length === 0 &&
        fromSettings['sync-start'].ok === false,
      `${JSON.stringify(fromSettings)}${settingsRefused.length ? `, refused: ${settingsRefused.map((l) => l.message).join('; ')}` : ''}`);

    if (!pw) return;
    // Settings may not read, save or fill the records; it sets the passcode and that is all.
    const count = credentials.records.address.length;
    const settingsSave = await ask(settings, 'save-address', { ...WORK, label: 'From Settings' });
    const settingsFill = await ask(settings, 'fill-address', { id: 'Home' });
    const settingsList = await ask(settings, 'list-credentials');
    const settingsDelete = await ask(settings, 'delete-credential', { kind: 'address', id: 'Home' });
    check('Settings cannot save, fill, list or delete saved addresses: they are the passwords page\'s',
      settingsSave === null && settingsFill === null && settingsList === null && settingsDelete === null &&
        credentials.records.address.length === count && !credentials.reveal('address', 'From Settings') &&
        Boolean(credentials.reveal('address', 'Home')),
      `save ${JSON.stringify(settingsSave)}, fill ${JSON.stringify(settingsFill)}, list ${JSON.stringify(settingsList)}, ` +
      `delete ${JSON.stringify(settingsDelete)}, addresses ${count} -> ${credentials.records.address.length}`);

    // The passwords page may, each request crossing the bridge.
    await wake(pw);
    const mark2 = lines.length;
    const pwSave = await ask(pw, 'save-address', { label: 'Via request', name: 'Request Person', street: '' });
    const pwFill = await ask(pw, 'fill-address', { id: 'Via request' });
    const pwDelete = await ask(pw, 'delete-credential', { kind: 'address', id: 'Via request' });
    // Hostile shapes: not a string, too long, a kind that does not exist.
    const pwOdd = await ask(pw, 'save-address', { label: { toString: 1 }, name: 'Odd Shape' });
    const pwOddKept = credentials.records.address.find((r) => r.name === 'Odd Shape');
    const pwLong = await ask(pw, 'save-address', { label: 'Long', name: 'N'.repeat(400), street: 'x'.repeat(5000), postal: '9'.repeat(100) });
    const pwLongKept = credentials.reveal('address', 'Long');
    const pwBadKind = await ask(pw, 'delete-credential', { kind: 'constructor', id: 'Home' });
    const pwRefused = refusals().filter((l) => lines.indexOf(l) >= mark2);
    check('the passwords page saves, fills and deletes addresses through its requests',
      pwSave === true && typeof pwFill === 'boolean' && pwDelete === true && !credentials.reveal('address', 'Via request') &&
        pwRefused.length === 0,
      `save ${pwSave}, fill ${pwFill}, delete ${pwDelete}${pwRefused.length ? `, refused ${pwRefused.map((l) => l.message).join('; ')}` : ''}`);
    check('an address whose fields are far too long is kept cut to size, and an unknown kind of record deletes nothing',
      pwLong === true && pwLongKept && pwLongKept.name.length <= 255 && pwLongKept.street.length <= 511 &&
        pwLongKept.postal.length <= 31 && pwBadKind === false && Boolean(credentials.reveal('address', 'Home')),
      `long save ${JSON.stringify(pwLong)} kept ${JSON.stringify(pwLongKept && { name: pwLongKept.name.length, street: pwLongKept.street.length, postal: pwLongKept.postal.length })}, ` +
      `bad kind ${JSON.stringify(pwBadKind)}`);
    // The house rule (credentials.js remove): a malformed request is answered
    // with a refusal, never a throw the page cannot tell from a crash.
    check('an address sent with a field that is not words is refused with an answer, not an error',
      pwOdd === false && !pwOddKept, `answer ${JSON.stringify(pwOdd)}, kept ${JSON.stringify(pwOddKept || null)}`);
    if (pwOddKept) credentials.remove('address', pwOddKept.label);
    if (pwLongKept) credentials.remove('address', 'Long');

    // But nothing of Settings': no sync, and no settings changed.
    const pwSync = {};
    for (const name of NEW_SETTINGS_REQUESTS) pwSync[name] = await ask(pw, name, null);
    const lang = prefs.get('translateTo');
    const darkBefore = prefs.get('darkWebsites');
    await tell(pw, 'set-pref', { key: 'translateTo', value: 'de' });
    await tell(pw, 'set-pref', { key: 'darkWebsites', value: !darkBefore });
    await sleep(300);
    check('the passwords page cannot reach sync or change a setting',
      Object.values(pwSync).every((v) => v === null) && prefs.get('translateTo') === lang && prefs.get('darkWebsites') === darkBefore,
      `sync ${JSON.stringify(pwSync)}, translate to ${prefs.get('translateTo')}`);

    // The new tab page and History: none of it.
    const newtab = await open(pages.NEW_TAB_URL);
    const history = await open(pages.HISTORY_URL);
    const others = {};
    for (const [name, tab] of [['newtab', newtab], ['history', history]]) {
      others[name] = {};
      for (const req of [...NEW_SETTINGS_REQUESTS, ...NEW_PASSWORDS_REQUESTS, 'list-credentials']) {
        others[name][req] = await ask(tab, req, req === 'save-address' ? { label: `From ${name}`, name: 'X' } : { id: 'Home' });
      }
      await tell(tab, 'set-pref', { key: 'translateTo', value: 'de' });
    }
    await sleep(300);
    check('the new tab page and History cannot reach sync, saved addresses or settings',
      Object.values(others).every((o) => Object.values(o).every((v) => v === null)) && prefs.get('translateTo') === lang &&
        !credentials.reveal('address', 'From newtab') && !credentials.reveal('address', 'From history'),
      JSON.stringify(others));
    close(history);
    close(newtab);
  }

  /* ================================================================ */
  /* A website                                                         */
  /* ================================================================ */

  async function websiteChecks(pw) {
    await wake(pw);
    const page = await open(t.pageUrl('settings-ui-hostile.html'));
    const host = new URL(page.wc.getURL()).hostname;
    hosts.add(host);
    await waitFor(async () => (await js(page, 'document.getElementById("report").textContent')) !== 'pending', { timeoutMs: 5000 });
    const report = await js(page, 'JSON.parse(document.getElementById("report").textContent)');
    const frameUrls = page.wc.mainFrame.frames.map((f) => f.url);
    // A refused frame keeps the address it asked for, so what matters is what is in it.
    const frameBridges = await Promise.all(page.wc.mainFrame.frames.map((f) =>
      t.inTime(f.executeJavaScript('typeof window.debrowser + "/" + Boolean(document.getElementById("locked"))')
        .catch(() => 'unreadable'), 1000, 'no answer')));
    check('a website has no page bridge, no Node, and cannot load the passwords page in a frame or fetch Settings',
      report && report.bridge === 'undefined' && report.require === 'undefined' && report.process === 'undefined' &&
        report.sent.length === 0 && report.fetch === 'refused' && t.senderPage(tabs, page.wc) === null &&
        frameBridges.every((b) => !/^object|true$/.test(b)),
      `report ${JSON.stringify(report)}, frames ${JSON.stringify(frameUrls)}, their bridges ${JSON.stringify(frameBridges)}`);

    // What Settings chose is what the page menu offers here: a real right-click.
    const onPage = await rightClick(page, '#report');
    const pageItems = (onPage?.items || []).filter((i) => i.id);
    const darkItem = pageItems.find((i) => i.id === 'toggle-site-dark');
    const translateItem = pageItems.find((i) => i.id === 'translate-page');
    const model = await rightClick(page, '#full');
    const items = (model?.items || []).filter((i) => i.id);
    const fillItems = items.filter((i) => i.id === 'fill-address-here').map((i) => i.payload?.id);
    const said = (list) => list.map((i) => `${i.id}${i.label ? `="${i.label}"` : ''}`).join(', ');
    check('the page menu follows Settings: dark mode on for this site, translation into French, and the saved address to fill',
      Boolean(onPage) && darkItem?.label === 'Turn off dark mode on this site' &&
        translateItem?.label === 'Translate page to French with Google' && Boolean(model) && (!pw || fillItems.includes('Home')),
      `page ${said(pageItems)}; field ${said(items)}`);

    // The page reaching the channels anyway, right after that right-click,
    // with the vault open and dark mode on: nothing it asks for happens.
    const asPage = { sender: page.wc, senderFrame: page.wc.mainFrame, processId: page.wc.getProcessId(),
      frameId: page.wc.mainFrame?.routingId, ports: [] };
    const url = page.wc.getURL();
    const lang = prefs.get('translateTo');
    const records = JSON.stringify(credentials ? credentials.records.address : []);
    // Only what the page opens counts: earlier suites may have left one.
    const google = () => tabs.all().filter((x) => /translate\.google/.test(x.url));
    const googleBefore = new Set(google().map((x) => x.id));
    for (const name of NEW_SHEET_COMMANDS) ipcMain.emit('debrowser:command', asPage, name, { id: 'Home', text: 'bonjour' });
    ipcMain.emit('debrowser:command', asPage, 'set-pref', { key: 'translateTo', value: 'de' });
    const handler = ipcMain._invokeHandlers?.get?.('debrowser:request');
    const answers = {};
    if (typeof handler === 'function') {
      for (const name of [...NEW_SETTINGS_REQUESTS, ...NEW_PASSWORDS_REQUESTS, 'list-credentials']) {
        answers[name] = await t.inTime(Promise.resolve(handler(asPage, name,
          name === 'save-address' ? { label: 'From a site', name: 'Site' } : { id: 'Home', passphrase: 'x'.repeat(12) }))
          .catch((err) => `threw ${err?.message}`), 2000, 'no answer');
      }
    }
    await sleep(700);
    const fields = await js(page, '[document.getElementById("full").value, document.getElementById("email").value]');
    check('a website that sends the new commands and requests itself is refused every one',
      typeof handler === 'function' && Object.values(answers).every((a) => a === null) &&
        Array.isArray(fields) && fields.every((v) => v === '') && sitePrefs.get(host, 'dark') === undefined &&
        page.wc.getURL() === url && prefs.get('translateTo') === lang && prefs.get('darkWebsites') === true &&
        JSON.stringify(credentials ? credentials.records.address : []) === records &&
        google().every((x) => googleBefore.has(x.id)),
      `requests ${typeof handler === 'function' ? JSON.stringify(answers) : 'handler not reachable'}, fields ${JSON.stringify(fields)}, ` +
      `dark here ${sitePrefs.get(host, 'dark')}, url ${page.wc.getURL() === url ? 'same' : page.wc.getURL()}, ` +
      `language ${prefs.get('translateTo')} (was ${lang}), dark websites ${prefs.get('darkWebsites')}, ` +
      `addresses ${JSON.stringify(credentials ? credentials.records.address : []) === records ? 'same' : 'changed'}, ` +
      `new Google tabs ${google().filter((x) => !googleBefore.has(x.id)).map((x) => x.url.slice(0, 80)).join(' ') || 'none'}`);
    close(page);

    // A site typed into the new tab page gets a renderer of its own, with no bridge.
    const fresh = await open(pages.NEW_TAB_URL);
    const site = t.pageUrl('settings-ui-address.html');
    runCommand('navigate', { url: site, id: fresh.id });
    await loaded(fresh, 'settings-ui-address.html');
    const bridge = await js(fresh, 'typeof window.debrowser');
    check('a site opened from the new tab page has no page bridge', bridge === 'undefined', `window.debrowser is ${bridge}`);
    close(fresh);

    // And were a site ever loaded into a renderer built for one of our
    // pages, the bridge it found would be refused at the browser.
    const stale = await open(pages.NEW_TAB_URL);
    hosts.add(new URL(site).hostname);
    await stale.wc.loadURL(t.pageUrl('settings-ui-address.html')).catch(() => {});
    await waitFor(() => !stale.wc.isLoading(), { timeoutMs: 5000 });
    const staleHost = (() => { try { return new URL(stale.wc.getURL()).hostname; } catch { return ''; } })();
    hosts.add(staleHost);
    const staleBridge = await js(stale, 'typeof window.debrowser');
    const staleAnswers = {};
    if (staleBridge === 'object') {
      for (const name of [...NEW_SETTINGS_REQUESTS, ...NEW_PASSWORDS_REQUESTS]) {
        staleAnswers[name] = await ask(stale, name, name === 'save-address' ? { label: 'Stale', name: 'Stale' } : { id: 'Home' });
      }
      for (const name of [...NEW_SHEET_COMMANDS, 'set-pref']) await tell(stale, name, { key: 'translateTo', value: 'de', id: 'Home' });
      await sleep(500);
    }
    check('a website left holding a page bridge is refused every new command and request',
      /^http:/.test(stale.wc.getURL()) && Object.values(staleAnswers).every((a) => a === null) &&
        prefs.get('translateTo') === lang && sitePrefs.get(staleHost, 'dark') === undefined &&
        !(credentials && credentials.reveal('address', 'Stale')),
      `at ${stale.wc.getURL()}, bridge ${staleBridge}, answers ${JSON.stringify(staleAnswers)}`);
    close(stale);
  }

  /** A real right-click at the field; the menu's model, with the sheet closed again. */
  async function rightClick(tab, selector) {
    await tabs.activate(tab.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      context.model = null;
      const pressed = await click(tab, `document.querySelector(${JSON.stringify(selector)})`, { button: 'right' });
      if (pressed !== 'clicked') return null;
      if (await waitFor(() => context.model && context.model.tabId === tab.id, { timeoutMs: 2000, pollMs: 50 })) break;
    }
    const model = context.model;
    if (shell.sheetPage === 'context') shell.closeSheet();
    return model;
  }

  /* ================================================================ */
  /* The page menu's own sheet sending its new items                    */
  /* ================================================================ */

  async function sheetChecks(settings) {
    await wake(settings);
    // Over Settings, so none of them has a page to act on: what is checked is
    // that each crosses the bridge, not what it then does.
    await tabs.activate(settings.id);
    // One harmless row: a menu with none closes itself.
    context.model = { items: [{ id: 'copy-text', label: 'Copy', icon: 'copy', payload: { text: '' } }], params: { x: 40, y: 40 }, tabId: settings.id };
    shell.openSheet('context', { x: 120, y: 120, right: 120 });
    const up = await waitFor(() => shell.sheetPage === 'context' && shell.sheetView &&
      !shell.sheetView.webContents.isLoading() && shell.sheetView.webContents.getURL().includes('context.html'), { timeoutMs: 5000 });
    const wc = up ? shell.sheetView.webContents : null;
    const crossed = [];
    const spy = (_event, channel, command) => { if (channel === 'debrowser:command') crossed.push(command); };
    const mark = lines.length;
    const tabsNow = tabs.all().length;
    const urlNow = settings.wc.getURL();
    if (wc) {
      watch(wc);
      wc.on('ipc-message', spy);
      await t.inTime(wc.executeJavaScript(`${JSON.stringify(NEW_SHEET_COMMANDS)}.forEach((n) => window.debrowser.send(n, null)); true`), 2000);
      await sleep(400);
      wc.removeListener('ipc-message', spy);
    }
    const refused = refusals().filter((l) => lines.indexOf(l) >= mark);
    if (shell.sheetPage === 'context') shell.closeSheet();
    context.model = null;
    check('each new item in the page menu reaches the browser when the menu sends it',
      Boolean(wc) && NEW_SHEET_COMMANDS.every((n) => crossed.includes(n)) && refused.length === 0 &&
        tabs.all().length === tabsNow && settings.wc.getURL() === urlNow,
      `crossed ${crossed.join(', ') || 'nothing'}${refused.length ? `, refused ${refused.map((l) => l.message).join('; ')}` : ''}`);
  }
};
