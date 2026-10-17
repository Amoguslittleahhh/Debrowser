'use strict';

/**
 * Saved cards and addresses, filled from the right-click menu of a field.
 *
 * End to end: a passcode set from Settings, records saved through the
 * passwords page, a real right-click sent to a real checkout page, the menu's
 * item run through the command dispatcher as the sheet would, and the values
 * read back out of the page. The pages are in test/pages/autofill-*.html.
 *
 * The rules being held to (main.js fillOnRequest, probe-preload.js findField):
 * a fill happens only because the user picked it in the browser's own menu or
 * on the passwords page, only into the tab they picked it for, and only into
 * fields a person can see. A page gets no say in any of it.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain } = require('electron');
const pages = require('../../pages');
const { Credentials, validate, KINDS } = require('../../data/credentials');

const PASSCODE = 'autofill-smoke-passcode';

const CARD = { label: 'Personal Visa', number: '4111111111111111', expiry: '03/29', holder: 'Ada Lovelace' };
const HOME = {
  label: 'Home',
  name: 'Ada King Lovelace',
  organization: 'Analytical Engines',
  street: '1600 Amphitheatre Parkway\nSuite 4',
  city: 'Mountain View',
  region: 'CA',
  postal: '94043',
  country: 'United States',
  email: 'ada@example.test',
  tel: '+1 650 555 0100'
};
// One street line and no company, so filling it after Home shows what Home left.
const WORK = {
  ...HOME, label: 'Work', name: 'Charles Babbage', organization: '', street: '1 Difference Way', city: 'Palo Alto',
  email: 'charles@example.test'
};

module.exports = async function autofill(t) {
  const { check, waitFor, sleep, tabs, shell, context, credentials, vault, runCommand } = t;
  if (!credentials || !vault) {
    check('saved cards and addresses have a store and a lock to test', false, 'no credentials or vault in this run');
    return;
  }

  // Everything this changes, to put back for the features after it.
  const before = {
    key: credentials.key,
    loaded: credentials.loaded,
    unavailable: credentials.unavailable,
    records: credentials.records,
    capability: Object.prototype.hasOwnProperty.call(credentials, 'capability') ? credentials.capability : null,
    vaultRecord: vault.record,
    unlockedUntil: vault.unlockedUntil,
    failures: vault.failures,
    blockedUntil: vault.blockedUntil
  };
  const opened = [];
  const tmpDirs = [];
  const tabsBefore = tabs.all().length;

  const loaded = (tab, name) => waitFor(() => tab.isLive && !tab.loading && tab.wc.getURL().includes(name), { timeoutMs: 10_000 });
  const open = async (url, { activate = true } = {}) => {
    const tab = tabs.create({ url, activate, realise: true });
    opened.push(tab);
    await loaded(tab, url.split('/').pop());
    if (activate) await tabs.activate(tab.id);
    return tab;
  };
  const page = (name) => open(t.pageUrl(name));
  const close = (tab) => { if (tab && tabs.all().includes(tab)) tabs.close(tab.id); };
  const js = (tab, code) => tab.wc.executeJavaScript(code).catch((err) => `threw ${err.message}`);
  const ask = (tab, command, payload) => js(tab,
    `window.debrowser.request(${JSON.stringify(command)}, ${JSON.stringify(payload ?? null)})`);
  const values = async (tab) => (await js(tab,
    'Object.fromEntries([...document.querySelectorAll("input, select, textarea")].map((e) => [e.id, e.value]))')) || {};
  /** Wait for a fill to land in `id`, then read the whole form. */
  const filled = async (tab, id) => {
    await waitFor(async () => Boolean((await values(tab))[id]), { timeoutMs: 3000, pollMs: 50 });
    await sleep(100);
    return values(tab);
  };
  /** Nothing should arrive: give it the time a fill would take, then read. */
  const settled = async (tab) => { await sleep(700); return values(tab); };
  const allEmpty = (v) => Object.values(v || {}).every((x) => x === '');

  const items = (model) => (model?.items || []).filter((i) => i.id);
  const fillItems = (model) => items(model).filter((i) => /^fill-(card|address)-here$/.test(i.id) ||
    (i.id === 'open-passwords' && /card or address/.test(i.label)));
  const describe = (model) => items(model).map((i) => i.id).join(',') || 'no menu';

  /**
   * A real right-click, as the mouse sends it, at the middle-left of the
   * element. The browser's own handler builds the menu; the sheet it opens is
   * closed again unless asked to stay.
   */
  async function rightClick(tab, selector, { keepOpen = false, wait = true } = {}) {
    const at = await js(tab, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + Math.min(12, r.width / 2)), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!at || typeof at !== 'object') return null;
    // A page that has loaded has not necessarily been drawn, and a click on
    // one that has not lands nowhere: two frames first, and a second try.
    for (let attempt = 0; attempt < 2; attempt++) {
      await t.inTime(js(tab, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'), 500);
      context.model = null;
      tab.wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
      tab.wc.sendInputEvent({ type: 'mouseDown', button: 'right', x: at.x, y: at.y, clickCount: 1 });
      tab.wc.sendInputEvent({ type: 'mouseUp', button: 'right', x: at.x, y: at.y, clickCount: 1 });
      if (!wait) { await sleep(700); break; }
      if (await waitFor(() => context.model && context.model.tabId === tab.id, { timeoutMs: 2000, pollMs: 50 })) break;
    }
    const model = context.model;
    if (!keepOpen && shell.sheetPage === 'context') shell.closeSheet();
    return model;
  }

  /** Right-click a field and run its menu's item for the saved record named `label`. */
  async function fillFromMenu(tab, selector, kind, label) {
    const model = await rightClick(tab, selector);
    const command = kind === 'card' ? 'fill-card-here' : 'fill-address-here';
    const item = items(model).find((i) => i.id === command && i.payload?.id === label);
    if (item) runCommand(item.id, item.payload);
    return { model, item };
  }

  try {
    /* -------------------------------------------------------------- */
    // The pure parts first: what an address record may be.
    {
      const ok = validate('address', HOME);
      const missingLabel = validate('address', { ...HOME, label: '' });
      const noLabelKey = (() => { const { label: _l, ...rest } = HOME; return validate('address', rest); })();
      const longLabel = validate('address', { ...HOME, label: 'x'.repeat(128) });
      const longestLabel = validate('address', { ...HOME, label: 'x'.repeat(127) });
      const longStreet = validate('address', { ...HOME, street: 'x'.repeat(512) });
      const longPostal = validate('address', { ...HOME, postal: '1'.repeat(32) });
      const longEmail = validate('address', { ...HOME, email: `${'a'.repeat(310)}@example.test` });
      const numberField = validate('address', { ...HOME, postal: 94043 });
      const objectField = validate('address', { ...HOME, city: { toString: () => 'London' } });
      const missingField = (() => { const { organization: _o, ...rest } = HOME; return validate('address', rest); })();
      const notRecords = [null, undefined, 'Home', 42, []].map((r) => validate('address', r));
      check('an address needs a label, and every part must be text within its limit',
        ok && longestLabel && !missingLabel && !noLabelKey && !longLabel && !longStreet && !longPostal && !longEmail &&
          !numberField && !objectField && !missingField && notRecords.every((r) => r === false),
        `ok ${ok}, 127-char label ${longestLabel}, empty label ${missingLabel}, no label ${noLabelKey}, ` +
        `128-char label ${longLabel}, long street ${longStreet}, long postcode ${longPostal}, long email ${longEmail}, ` +
        `number ${numberField}, object ${objectField}, missing part ${missingField}, non-records ${notRecords.join('/')}`);

      // The menu itself: three of each at most, a long name cut short, and
      // nothing at all off a field or with nothing saved.
      const many = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: `${prefix} ${i}`, label: `${prefix} ${i}` }));
      const field = { isEditable: true, editFlags: { canPaste: true } };
      const build = (params, fill) => ({ items: t.contextMenu.buildModel(params, { fill }) });
      const full = build(field, { locked: false, cards: many(4, 'Card'), addresses: many(5, 'Place') });
      const longName = 'A card with a very long name\nthat goes on';
      const long = build(field, { locked: false, cards: [{ id: longName, label: longName }], addresses: [] });
      const nothing = build(field, { locked: true, cards: [], addresses: [] });
      const offField = build({ selectionText: 'words' }, { locked: false, cards: many(1, 'Card'), addresses: [] });
      const longLabelShown = items(long).find((i) => i.id === 'fill-card-here')?.label || '';
      check('the menu offers at most three cards and three addresses, a long name shortened onto one line',
        items(full).filter((i) => i.id === 'fill-card-here').length === 3 &&
          items(full).filter((i) => i.id === 'fill-address-here').length === 3 &&
          !longLabelShown.includes('\n') && longLabelShown.includes('…') && longLabelShown.length <= 'Fill card “”'.length + 24 &&
          items(long).find((i) => i.id === 'fill-card-here')?.payload?.id === longName &&
          fillItems(nothing).length === 0 && fillItems(offField).length === 0,
        `full: ${describe(full)}; long: "${longLabelShown}"; nothing saved: ${describe(nothing)}; selection: ${describe(offField)}`);
    }

    /* -------------------------------------------------------------- */
    // With no passcode the feature is off, and a field's menu says nothing of it.
    const vaultWas = vault.configured();
    if (vaultWas) vault.write(null);
    credentials.key = crypto.randomBytes(32);
    credentials.loaded = true;
    credentials.unavailable = null;
    credentials.capability = () => ({ available: true, reason: null });
    credentials.records = { login: [], payment: [], address: [], passkey: [] };

    let card = await page('autofill-card.html');
    {
      // Records that could only be left over from an old passcode, which the
      // menu must not offer while there is none.
      credentials.records.payment.push({ ...CARD });
      const model = await rightClick(card, '#cc-number');
      credentials.records.payment = [];
      check('with no passcode set, a field\'s menu offers no saved cards or addresses',
        Boolean(model) && items(model).some((i) => i.id === 'edit-paste') && fillItems(model).length === 0,
        describe(model));
    }

    /* -------------------------------------------------------------- */
    // A passcode from Settings, then cards and addresses saved the ways a
    // person and the browser save them.
    const settingsTab = await open(pages.SETTINGS_URL);
    const set = await ask(settingsTab, 'vault-set', { passcode: PASSCODE });
    close(settingsTab);
    const pwTab = await open(pages.PASSWORDS_URL);
    const unlocked = await ask(pwTab, 'vault-unlock', { method: 'passcode', passcode: PASSCODE });
    check('a passcode set in Settings unlocks the passwords page',
      Boolean(set && set.ok && unlocked && unlocked.ok && vault.unlocked()),
      `set ${JSON.stringify(set)}, unlock ${JSON.stringify(unlocked)}`);

    // The passwords page's own forms, typed into and submitted.
    await js(pwTab, 'refresh()');
    await waitFor(async () => (await js(pwTab, '!document.getElementById("open").hidden')) === true, { timeoutMs: 5000 });
    const typed = await js(pwTab, `(async () => {
      const put = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      document.getElementById('add-card').open = true;
      put('card-label', ${JSON.stringify(CARD.label)});
      put('card-number', '4111 1111 1111 1111');
      put('card-expiry', '0329');
      put('card-holder', ${JSON.stringify(CARD.holder)});
      document.getElementById('card-form').requestSubmit();
      document.getElementById('add-address').open = true;
      ${JSON.stringify(Object.entries(HOME))}.forEach(([k, v]) => put('address-' + k, v));
      document.getElementById('address-form').requestSubmit();
      return true;
    })()`);
    await waitFor(async () => (await js(pwTab,
      'document.querySelectorAll("#cards .row").length === 1 && document.querySelectorAll("#addresses .row").length === 1')) === true,
    { timeoutMs: 5000 });
    const rows = await js(pwTab, `({
      cards: [...document.querySelectorAll('#cards .row')].map((r) => r.textContent),
      addresses: [...document.querySelectorAll('#addresses .row')].map((r) => r.textContent)
    })`);
    const savedCard = credentials.reveal('payment', CARD.label);
    const savedHome = credentials.reveal('address', HOME.label);
    check('a card and an address typed into the passwords page are saved and listed',
      typed === true && savedCard?.number === CARD.number && savedCard?.expiry === CARD.expiry &&
        savedHome && Object.keys(HOME).every((k) => savedHome[k] === HOME[k]) &&
        rows?.cards?.[0]?.includes('1111') && !rows?.cards?.[0]?.includes(CARD.number) &&
        rows?.addresses?.[0]?.includes('Home') && rows?.addresses?.[0]?.includes('Mountain View'),
      `card ${JSON.stringify(savedCard && { ...savedCard, number: `…${savedCard.number.slice(-4)}` })}, ` +
      `address ${JSON.stringify(savedHome)}, rows ${JSON.stringify(rows)}`);

    // The list the page and the menu see: names and enough to tell them
    // apart, never the number, the email or the phone.
    const listed = await ask(pwTab, 'list-credentials');
    const listedText = JSON.stringify(listed);
    check('the list of saved addresses carries a label and a short summary, not the email or phone',
      Array.isArray(listed?.addresses) && listed.addresses.length === 1 &&
        Object.keys(listed.addresses[0]).sort().join(',') === 'id,label,summary' &&
        !listedText.includes(HOME.email) && !listedText.includes(HOME.tel) && !listedText.includes(CARD.number),
      JSON.stringify(listed?.addresses));

    // The request the page uses, straight, and the store's own door.
    const work = await ask(pwTab, 'save-address', WORK);
    const noLabel = await ask(pwTab, 'save-address', { ...WORK, label: '' });
    const blankLabel = await ask(pwTab, 'save-address', { ...WORK, label: '   ' });
    const noPayload = await ask(pwTab, 'save-address', null);
    const oversized = await ask(pwTab, 'save-address', { ...WORK, label: 'Huge', street: 'x'.repeat(5000), postal: '9'.repeat(100) });
    const huge = credentials.reveal('address', 'Huge');
    const badCard = await ask(pwTab, 'save-payment', { label: 'Bad', number: '4111-abcd', expiry: '13/29', holder: '' });
    const spare = await ask(pwTab, 'save-payment', { label: 'Spare', number: '3782 822463 10005', expiry: '01/27', holder: 'A Lovelace' });
    const putOk = credentials.put('address', { ...WORK, label: 'Parents', city: 'Cupertino' });
    const putLong = credentials.put('address', { ...WORK, label: 'Too long', street: 'x'.repeat(600) });
    const putNoLabel = credentials.put('address', { ...WORK, label: '' });
    const putCard = credentials.put('payment', { label: 'Backup', number: '5555555555554444', expiry: '12/35', holder: 'Ada L' });
    check('the passwords page saves a good card or address, refuses one without a label, and cuts an address part that is too long',
      work === true && noLabel === false && blankLabel === false && noPayload === false && oversized === true &&
        huge && huge.street.length <= 511 && huge.postal.length <= 31 && badCard === false &&
        spare === true && credentials.reveal('payment', 'Spare')?.number === '378282246310005',
      `work ${work}, no label ${noLabel}, blank label ${blankLabel}, null ${noPayload}, oversized ${oversized} ` +
      `(street ${huge?.street.length}, postcode ${huge?.postal.length}), bad card ${badCard}, spaced card ${spare}`);
    check('the store itself refuses an address without a label or with a part over its limit',
      putOk === true && putLong === false && putNoLabel === false && putCard === true &&
        !credentials.reveal('address', 'Too long') && !credentials.reveal('address', ''),
      `put ${putOk}, long street ${putLong}, no label ${putNoLabel}, card ${putCard}`);
    credentials.remove('address', 'Huge');

    // The same label replaces, rather than adding a second "Work".
    await ask(pwTab, 'save-address', { ...WORK, city: 'Menlo Park' });
    const works = credentials.records.address.filter((r) => r.label === 'Work');
    check('saving an address under a label already used replaces it',
      works.length === 1 && works[0].city === 'Menlo Park', `${works.length} called Work, city ${works[0]?.city}`);
    await ask(pwTab, 'save-address', WORK);

    /* -------------------------------------------------------------- */
    // The menu of a real right-click.
    await tabs.activate(card.id);
    {
      const model = await rightClick(card, '#cc-number');
      const cards = items(model).filter((i) => i.id === 'fill-card-here');
      const places = items(model).filter((i) => i.id === 'fill-address-here');
      const labels = fillItems(model).map((i) => i.label);
      check('right-clicking a field offers each saved card and address by name',
        cards.some((i) => i.payload?.id === CARD.label && i.label === `Fill card “${CARD.label}”`) &&
          cards.some((i) => i.payload?.id === 'Backup') &&
          places.some((i) => i.payload?.id === 'Home' && i.label === 'Fill address “Home”') &&
          places.some((i) => i.payload?.id === 'Work') && places.some((i) => i.payload?.id === 'Parents'),
        labels.join(' | ') || describe(model));
      // The model goes to the sheet's renderer: a name to show and an id to
      // send back, not the record.
      const text = JSON.stringify(model?.items || []);
      check('the menu carries the names of saved cards and addresses, not their contents',
        Boolean(model) && !text.includes(CARD.number) && !text.includes('4444') && !text.includes(HOME.email) &&
          !text.includes(HOME.tel) && !text.includes('Amphitheatre'),
        text.slice(0, 200));

      const words = await rightClick(card, '#words');
      check('right-clicking words that are not a field offers nothing to fill',
        Boolean(words) && fillItems(words).length === 0 && items(words).some((i) => i.id === 'back'), describe(words));
    }

    // Our own pages are never filled, and their fields do not offer it.
    {
      await tabs.activate(pwTab.id);
      await js(pwTab, 'refresh()');
      await waitFor(async () => (await js(pwTab, '!document.getElementById("q").hidden')) === true, { timeoutMs: 4000 });
      const model = await rightClick(pwTab, '#q');
      check('a field on the browser\'s own pages offers nothing to fill',
        Boolean(model) && items(model).some((i) => i.id === 'edit-paste') && fillItems(model).length === 0, describe(model));
    }

    // Locked: one item that opens the lock, and the fill itself refused.
    {
      await ask(pwTab, 'vault-lock');
      await tabs.activate(card.id);
      const model = await rightClick(card, '#cc-number');
      const offered = fillItems(model);
      runCommand('fill-card-here', { id: CARD.label });
      runCommand('fill-address-here', { id: 'Home' });
      const after = await settled(card);
      check('while the passwords are locked a field offers only "Fill a saved card or address…", and nothing is filled',
        offered.length === 1 && offered[0].id === 'open-passwords' && offered[0].label === 'Fill a saved card or address…' &&
          allEmpty(after),
        `${offered.map((i) => `${i.id} "${i.label}"`).join(', ') || describe(model)}; page ${JSON.stringify(after)}`);
      // The item takes the user to the lock.
      if (offered[0]) runCommand(offered[0].id, offered[0].payload);
      const toLock = await waitFor(() => tabs.activeTab() && pages.pageName(tabs.activeTab().url) === 'passwords', { timeoutMs: 3000 });
      check('"Fill a saved card or address…" opens the passwords page', toLock, tabs.activeTab()?.url);
      const again = await ask(pwTab, 'vault-unlock', { method: 'passcode', passcode: PASSCODE });
      if (!again?.ok) check('the passwords unlock again for the rest of the checks', false, JSON.stringify(again));
    }

    // Wrong orders: a fill with no right-click behind it, ids that are no
    // saved record's, and the lock closing while the menu is open.
    {
      await tabs.activate(card.id);
      context.model = null;
      const threw = [];
      const run = (command, payload) => { try { runCommand(command, payload); } catch (err) { threw.push(`${command}: ${err.message}`); } };
      run('fill-card-here', { id: CARD.label });
      run('fill-address-here', { id: 'Home' });
      const unasked = await settled(card);
      await rightClick(card, '#cc-number');
      for (const payload of [null, {}, { id: '__proto__' }, { id: 'constructor' }, { id: { label: CARD.label } }, { id: ['Home'] }]) {
        run('fill-card-here', payload);
        run('fill-address-here', payload);
      }
      const odd = await settled(card);
      const model = await rightClick(card, '#cc-number');
      const item = items(model).find((i) => i.id === 'fill-card-here' && i.payload?.id === CARD.label);
      vault.lock();
      if (item) run(item.id, item.payload);
      const lockedMeanwhile = await settled(card);
      check('nothing is filled without a right-click, for an id that is not a saved one, or once the lock has closed',
        allEmpty(unasked) && allEmpty(odd) && Boolean(item) && allEmpty(lockedMeanwhile) && threw.length === 0,
        `unasked ${JSON.stringify(unasked)}, odd ids ${JSON.stringify(odd)}, after locking ${JSON.stringify(lockedMeanwhile)}` +
        (threw.length ? `, threw ${threw.join('; ')}` : ''));
      const again = await ask(pwTab, 'vault-unlock', { method: 'passcode', passcode: PASSCODE });
      if (!again?.ok) check('the passwords unlock again for the rest of the checks', false, JSON.stringify(again));
    }

    /* -------------------------------------------------------------- */
    // Filling, read back out of the page.
    close(card);
    card = await page('autofill-card.html');
    {
      const { item } = await fillFromMenu(card, '#cc-name', 'card', CARD.label);
      const v = await filled(card, 'cc-number');
      const heard = await js(card, 'window.heard');
      check('a saved card picked from the menu fills the number, name and expiry, and not the security code',
        Boolean(item) && v['cc-number'] === CARD.number && v['cc-name'] === CARD.holder && v['cc-exp'] === CARD.expiry &&
          v['cc-csc'] === '' && v.search === '' &&
          Array.isArray(heard) && ['cc-number', 'cc-name', 'cc-exp'].every((id) => heard.includes(id)),
        `item ${Boolean(item)}, page ${JSON.stringify(v)}, input events on ${JSON.stringify(heard)}`);
    }

    {
      const split = await page('autofill-card-split.html');
      const { item } = await fillFromMenu(split, '#number', 'card', CARD.label);
      const v = await filled(split, 'number');
      check('an expiry split into a month list and a four-digit year list is picked in both',
        Boolean(item) && v.number === CARD.number && v.holder === CARD.holder && v.month === '03' && v.year === '2029',
        JSON.stringify(v));
      const { item: backup } = await fillFromMenu(split, '#number', 'card', 'Backup');
      await waitFor(async () => (await values(split)).number === '5555555555554444', { timeoutMs: 3000, pollMs: 50 });
      const w = await values(split);
      check('a second card replaces the first, December 2035 at the end of the lists',
        Boolean(backup) && w.number === '5555555555554444' && w.month === '12' && w.year === '2035', JSON.stringify(w));
      close(split);
    }

    {
      const hints = await page('autofill-hints.html');
      const { item } = await fillFromMenu(hints, '#cardnum', 'card', CARD.label);
      const v = await filled(hints, 'cardnum');
      check('a card form with no autocomplete tokens is filled by its labels, month 1-12 and a two-digit year',
        Boolean(item) && v.cardnum === CARD.number && v.holder === CARD.holder && v.expm === '3' && v.expy === '29' && v.cvc === '',
        JSON.stringify({ cardnum: v.cardnum, holder: v.holder, expm: v.expm, expy: v.expy, cvc: v.cvc }));

      const { item: home } = await fillFromMenu(hints, '#town', 'address', 'Home');
      const a = await filled(hints, 'town');
      check('an address form with no autocomplete tokens gets the town, ZIP, email, phone and country by their labels',
        Boolean(home) && a.town === HOME.city && a.zip === HOME.postal && a.mail === HOME.email && a.phone === HOME.tel &&
          a.country === 'US',
        JSON.stringify(a));
      check('a box labelled just "Name" gets the whole name',
        a.name === HOME.name, `name box holds "${a.name}"`);
      check('a street box known only by its label gets every line of the street',
        a.street === HOME.street || a.street === HOME.street.replace('\n', ', '),
        `street box holds ${JSON.stringify(a.street)}`);
      check('the State box gets the state, and a "Country/Region" list is not taken for it',
        a.state === HOME.region, `state box holds "${a.state}", country list ${a.country}`);
      close(hints);
    }

    {
      const parts = await page('autofill-address.html');
      const { item } = await fillFromMenu(parts, '#first', 'address', 'Home');
      const v = await filled(parts, 'first');
      check('an address with autocomplete tokens fills first and last name, both street lines, city, state, postcode, country, email and phone',
        Boolean(item) && v.first === 'Ada' && v.last === 'King Lovelace' && v.org === HOME.organization &&
          v.line1 === '1600 Amphitheatre Parkway' && v.line2 === 'Suite 4' && v.city === HOME.city && v.region === 'CA' &&
          v.postal === HOME.postal && v.country === 'US' && v.email === HOME.email && v.tel === HOME.tel && v.notes === '',
        JSON.stringify(v));
      // The user picked the wrong one, and picks Work over it.
      const { item: work } = await fillFromMenu(parts, '#first', 'address', 'Work');
      await waitFor(async () => (await values(parts)).first === 'Charles', { timeoutMs: 3000, pollMs: 50 });
      const w = await values(parts);
      check('filling a second address over the first leaves none of the first behind',
        Boolean(work) && w.first === 'Charles' && w.line1 === '1 Difference Way' && w.line2 === '' && w.org === '' &&
          w.city === 'Palo Alto' && w.email === WORK.email,
        `company "${w.org}", line 2 "${w.line2}", line 1 "${w.line1}", city "${w.city}"`);
      close(parts);
    }

    {
      const whole = await page('autofill-address-whole.html');
      const { item } = await fillFromMenu(whole, '#full', 'address', 'Home');
      const v = await filled(whole, 'full');
      check('a whole-name box and a street textarea get the full name and every line',
        Boolean(item) && v.full === HOME.name && v.street === HOME.street && v.city === HOME.city && v.region === 'CA' &&
          v.postal === HOME.postal && v.country === HOME.country && v.email === HOME.email && v.tel === HOME.tel,
        JSON.stringify(v));
      close(whole);
    }

    {
      const react = await page('autofill-react.html');
      await fillFromMenu(react, '#name', 'address', 'Home');
      await filled(react, 'name');
      await fillFromMenu(react, '#number', 'card', CARD.label);
      await filled(react, 'number');
      // Another redraw, as the page's next keystroke would cause.
      await js(react, 'redraw()');
      const state = await js(react, 'window.state');
      const v = await values(react);
      check('a page that learns values only from input events holds every filled value after it redraws',
        state?.name === HOME.name && state?.street === '1600 Amphitheatre Parkway, Suite 4' && state?.city === HOME.city &&
          state?.postal === HOME.postal && state?.country === 'US' && state?.email === HOME.email &&
          state?.number === CARD.number && state?.exp === CARD.expiry &&
          v.name === HOME.name && v.number === CARD.number && v.country === 'US',
        `state ${JSON.stringify(state)}, page ${JSON.stringify(v)}`);
      close(react);
    }

    /* -------------------------------------------------------------- */
    // A page that harvests: decoys before every visible field.
    {
      context.model = null;
      const hostile = await page('autofill-hostile.html');
      await sleep(800);
      const pestered = await js(hostile, 'window.pestered');
      check('a page scripting right-clicks at its own fields opens no menu',
        context.model === null && pestered > 0, `scripted ${pestered} times, menu ${describe(context.model)}`);

      await fillFromMenu(hostile, '#number', 'card', CARD.label);
      await filled(hostile, 'exp');
      await fillFromMenu(hostile, '#given', 'address', 'Home');
      const v = await filled(hostile, 'given');
      const decoys = [
        ['d-number-offscreen', 'number', CARD.number, 'placed far off the left of the page'],
        ['d-line2-offscreen', 'line2', 'Suite 4', 'placed far above the page'],
        ['d-name-opacity', 'holder', CARD.holder, 'fully transparent'],
        ['d-org-parent-opacity', 'org', HOME.organization, 'inside a fully transparent box'],
        ['d-exp-none', 'exp', CARD.expiry, 'not displayed'],
        ['d-email-parent-none', 'email', HOME.email, 'inside a box that is not displayed'],
        ['d-given-hidden', 'given', 'Ada', 'type=hidden'],
        ['d-family-zero', 'family', 'King Lovelace', 'zero-sized'],
        ['d-line1-invisible', 'line1', '1600 Amphitheatre Parkway', 'visibility: hidden'],
        ['d-country-parent-invisible', 'country', 'US', 'inside an invisible box'],
        ['d-city-clipped', 'city', HOME.city, 'clipped away to nothing'],
        ['d-tel-shut', 'tel', HOME.tel, 'inside a box of no height that hides its overflow'],
        ['d-region-disabled', 'region', 'CA', 'disabled'],
        ['d-postal-readonly', 'postal', HOME.postal, 'read-only']
      ];
      for (const [decoy, real, want, how] of decoys) {
        check(`a decoy field ${how} stays empty, and the visible one after it is filled`,
          v[decoy] === '' && v[real] === want, `decoy ${decoy} = "${v[decoy]}", visible ${real} = "${v[real]}"`);
      }
      close(hostile);
    }

    /* -------------------------------------------------------------- */
    // A page cannot fill itself: it has no bridge, and the browser's own
    // channels do not answer it even when everything else lines up.
    {
      const self = await page('autofill-card.html');
      const bridge = await js(self, 'typeof window.debrowser + "/" + typeof require + "/" + typeof process');
      const model = await rightClick(self, '#cc-number');
      const asPage = { sender: self.wc, senderFrame: self.wc.mainFrame, processId: self.wc.getProcessId(), frameId: self.wc.mainFrame?.routingId, ports: [] };
      // As a renderer would have to, were the page to reach the channel: the
      // command right after a real right-click on it, with the vault open.
      ipcMain.emit('debrowser:command', asPage, 'fill-card-here', { id: CARD.label });
      ipcMain.emit('debrowser:command', asPage, 'fill-address-here', { id: 'Home' });
      // The handler the request channel runs, as Electron keeps it.
      const handler = ipcMain._invokeHandlers?.get?.('debrowser:request');
      const viaRequest = [];
      if (typeof handler === 'function') {
        for (const [command, payload] of [['fill-payment', { id: CARD.label }], ['fill-address', { id: 'Home' }],
          ['list-credentials', null], ['reveal-credential', { kind: 'payment', id: CARD.label }]]) {
          viaRequest.push(await t.inTime(Promise.resolve(handler(asPage, command, payload)).catch((err) => `threw ${err?.message}`),
            2000, 'no answer'));
        }
      }
      const after = await settled(self);
      check('a web page has no bridge to the browser, and sending the fill commands as the page fills nothing',
        bridge === 'undefined/undefined/undefined' && t.senderPage(tabs, self.wc) === null &&
          model?.tabId === self.id && vault.unlocked() && allEmpty(after) &&
          (typeof handler !== 'function' || viaRequest.every((r) => r === null)),
        `bridge ${bridge}, sender ${t.senderPage(tabs, self.wc)}, requests ${handler ? JSON.stringify(viaRequest) : 'handler not reachable'}, ` +
        `page ${JSON.stringify(after)}`);
      close(self);
    }

    // In the background: a scripted right-click, and even a real one sent to
    // the hidden view, puts no menu over the page in front.
    {
      const front = await page('autofill-card.html');
      const back = await open(t.pageUrl('autofill-card.html'), { activate: false });
      await tabs.activate(front.id);
      context.model = null;
      await js(back, `(() => { const el = document.getElementById('cc-number'); el.focus();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 80 })); })()`);
      const scripted = await rightClick(back, '#cc-number', { wait: false });
      runCommand('fill-card-here', { id: CARD.label });
      const backValues = await settled(back);
      const frontValues = await values(front);
      check('a tab in the background cannot open the menu, and nothing is filled in it or the tab in front',
        scripted === null && back.visible === false && allEmpty(backValues) && allEmpty(frontValues),
        `menu ${describe(scripted)}, back ${JSON.stringify(backValues)}, front ${JSON.stringify(frontValues)}`);

      // Right-clicked in front, then the user moved to another tab: the item
      // no longer fills anything.
      const model = await rightClick(front, '#cc-number');
      const item = items(model).find((i) => i.id === 'fill-card-here' && i.payload?.id === CARD.label);
      await tabs.activate(back.id);
      if (item) runCommand(item.id, item.payload);
      const movedBack = await settled(back);
      const movedFront = await values(front);
      check('a card picked after moving to another tab is filled into neither tab',
        Boolean(item) && allEmpty(movedBack) && allEmpty(movedFront),
        `back ${JSON.stringify(movedBack)}, front ${JSON.stringify(movedFront)}`);

      // And the ordinary case: only the tab that was right-clicked.
      await tabs.activate(front.id);
      const { item: picked } = await fillFromMenu(front, '#cc-number', 'card', CARD.label);
      const inFront = await filled(front, 'cc-number');
      const inBack = await values(back);
      check('a card is filled only into the tab whose field was right-clicked',
        Boolean(picked) && inFront['cc-number'] === CARD.number && allEmpty(inBack),
        `front ${inFront['cc-number']}, back ${JSON.stringify(inBack)}`);
      close(front);
      close(back);
    }

    // A page that goes somewhere else a moment after it is right-clicked,
    // while the menu is open: the menu goes as the page does, so nothing in
    // it can be picked for a page the user did not right-click.
    for (const [to, where, host] of [['', 'a different site', 'elsewhere.test'], ['same-site', 'another address on the same site', 'other.']]) {
      const swap = await open(`${t.pageUrl('autofill-swap.html')}${to ? `?to=${to}` : ''}`);
      const model = await rightClick(swap, '#number', { keepOpen: true });
      const item = items(model).find((i) => i.id === 'fill-card-here' && i.payload?.id === CARD.label);
      const menuWasUp = await waitFor(() => shell.sheetPage === 'context', { timeoutMs: 1000, pollMs: 50 });
      await waitFor(() => swap.isLive && swap.wc.getURL().includes(host) && !swap.loading, { timeoutMs: 5000 });
      await waitFor(async () => (await js(swap, 'Boolean(document.getElementById("cc-number"))')) === true, { timeoutMs: 3000 });
      const menuStillUp = shell.sheetPage === 'context';
      if (menuStillUp) shell.closeSheet();
      const v = await settled(swap);
      check(`a page that moves to ${where} after the right-click takes the menu with it, and nothing is filled there`,
        Boolean(item) && menuWasUp && !menuStillUp && swap.wc.getURL().includes(host) && allEmpty(v),
        `now at ${swap.wc.getURL()}, menu ${menuWasUp ? 'open' : 'never open'} and ${menuStillUp ? 'still open' : 'closed'} ` +
        `after the move, page ${JSON.stringify(v)}`);
      close(swap);
    }

    // A card form in a frame of its own: the menu offers a card only where it
    // can put one.
    {
      const shop = await page('autofill-frame.html');
      const frameReady = await waitFor(() => {
        const f = shop.wc.mainFrame.frames[0];
        return Boolean(f && f.url.includes('//pay.') && !shop.wc.isLoading());
      }, { timeoutMs: 8000 });
      const frame = shop.wc.mainFrame.frames[0];
      const inFrame = frameReady ? await frame.executeJavaScript(`(() => {
        const r = document.getElementById('cc-number').getBoundingClientRect();
        return { x: r.left + 12, y: r.top + r.height / 2 };
      })()`).catch(() => null) : null;
      const box = await js(shop, '(() => { const r = document.getElementById("provider").getBoundingClientRect(); return { x: r.left + 1, y: r.top + 1 }; })()');
      context.model = null;
      if (inFrame && box) {
        const x = Math.round(box.x + inFrame.x);
        const y = Math.round(box.y + inFrame.y);
        await t.inTime(js(shop, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'), 500);
        shop.wc.sendInputEvent({ type: 'mouseMove', x, y });
        shop.wc.sendInputEvent({ type: 'mouseDown', button: 'right', x, y, clickCount: 1 });
        shop.wc.sendInputEvent({ type: 'mouseUp', button: 'right', x, y, clickCount: 1 });
        await waitFor(() => context.model && context.model.tabId === shop.id, { timeoutMs: 3000, pollMs: 50 });
      }
      const model = context.model;
      if (shell.sheetPage === 'context') shell.closeSheet();
      const item = items(model).find((i) => i.id === 'fill-card-here' && i.payload?.id === CARD.label);
      if (item) runCommand(item.id, item.payload);
      await sleep(700);
      const got = frameReady ? await frame.executeJavaScript('document.getElementById("cc-number").value').catch(() => 'unreadable') : 'no frame';
      check('a card field in a frame is either filled from the menu or not offered a card',
        Boolean(model) && model.items.some((i) => i.id === 'edit-paste') && (item ? got === CARD.number : true),
        `menu ${describe(model)}, frame field holds "${got}"`);
      close(shop);
    }

    /* -------------------------------------------------------------- */
    // The passwords page's Fill button: into the page the user was on.
    {
      const older = await page('autofill-address.html');
      const target = await page('autofill-address-whole.html');
      await tabs.activate(pwTab.id);
      await js(pwTab, 'load()');
      // A row's button, pressed as soon as it reads `button` - Fill says
      // "Filled" for a moment after each press.
      const press = async (label, button = 'Fill') => {
        let result = 'no button';
        await waitFor(async () => {
          result = await js(pwTab, `(() => {
            const row = [...document.querySelectorAll('#addresses .row, #cards .row')]
              .find((r) => r.querySelector('.row-label')?.textContent === ${JSON.stringify(label)});
            const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(button)});
            if (!b) return 'no button';
            b.click();
            return 'pressed';
          })()`);
          return result === 'pressed';
        }, { timeoutMs: 3000, pollMs: 100 });
        return result;
      };
      await waitFor(async () => (await js(pwTab, 'document.querySelectorAll("#addresses .row").length')) >= 3, { timeoutMs: 3000 });
      const pressed = await press('Home');
      const v = await filled(target, 'full');
      const said = await js(pwTab, `[...document.querySelectorAll('#addresses .row')]
        .find((r) => r.querySelector('.row-label')?.textContent === 'Home')?.querySelector('.row-control button')?.textContent`);
      const untouched = await values(older);
      check('Fill on the passwords page puts the address into the page the user was on, and says so',
        pressed === 'pressed' && v.full === HOME.name && v.street === HOME.street && v.email === HOME.email &&
          said === 'Filled' && allEmpty(untouched),
        `pressed ${pressed}, page ${JSON.stringify(v)}, button "${said}", older page ${JSON.stringify(untouched)}`);

      // That page put to sleep while the passwords page was in front: the
      // card must not go to whatever older page is still awake.
      close(target);
      const cardOlder = await page('autofill-card.html');
      const cardMeant = await page('autofill-card-split.html');
      await tabs.activate(pwTab.id);
      runCommand('sleep-tab', { id: cardMeant.id });
      const asleep = await waitFor(() => !cardMeant.isLive, { timeoutMs: 5000 });
      await js(pwTab, 'load()');
      await waitFor(async () => (await js(pwTab, 'document.querySelectorAll("#cards .row").length')) >= 2, { timeoutMs: 3000 });
      const pressedAsleep = await press(CARD.label);
      const wrong = await settled(cardOlder);
      check('a card is not filled into an older page when the page it was meant for has been put to sleep',
        asleep && pressedAsleep === 'pressed' && allEmpty(wrong),
        `asleep ${asleep}, Fill ${pressedAsleep}, older page ${JSON.stringify(wrong)}`);
      close(older);
      close(cardOlder);
      close(cardMeant);

      // The page the user left sends itself to another site the moment it is
      // hidden. Fill is pressed for the shop the user saw, out of their sight.
      const leaving = await page('autofill-leave.html');
      await tabs.activate(pwTab.id);
      const left = await waitFor(() => leaving.isLive && leaving.wc.getURL().includes('elsewhere.test') && !leaving.loading,
        { timeoutMs: 5000 });
      const pressedLeave = await press(CARD.label);
      const there = await settled(leaving);
      check('Fill on the passwords page does not put a card into a different site the page went to once it was hidden',
        left && pressedLeave === 'pressed' && allEmpty(there),
        `Fill ${pressedLeave}, page now ${leaving.wc.getURL()}, holds ${JSON.stringify(there)}`);
      close(leaving);
    }

    /* -------------------------------------------------------------- */
    // Asleep and woken: the new renderer still has the menu and still fills.
    {
      const front = await page('idle.html');
      const napper = await open(t.pageUrl('autofill-card-split.html'), { activate: false });
      runCommand('sleep-tab', { id: napper.id });
      const asleep = await waitFor(() => !napper.isLive, { timeoutMs: 5000 });
      await tabs.activate(napper.id);
      await loaded(napper, 'autofill-card-split.html');
      const { item } = await fillFromMenu(napper, '#number', 'card', CARD.label);
      const v = await filled(napper, 'number');
      check('a tab put to sleep and woken again still offers and fills a saved card',
        asleep && Boolean(item) && v.number === CARD.number && v.month === '03', `asleep ${asleep}, page ${JSON.stringify(v)}`);
      close(napper);
      close(front);
    }

    /* -------------------------------------------------------------- */
    // On disk: encrypted, private, read back by a store started afresh, and a
    // tampered record dropped rather than filled.
    {
      const file = path.join(credentials.dir, KINDS.address);
      const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const mode = fs.existsSync(file) ? (fs.statSync(file).mode & 0o777) : null;
      const fresh = new Credentials(() => {});
      fresh.dir = credentials.dir;
      fresh.key = credentials.key;
      fresh.capability = () => ({ available: true, reason: null });
      fresh.load();
      const labels = fresh.records.address.map((r) => r.label).sort().join(',');
      check('saved addresses are kept encrypted on disk and come back when the store starts again',
        raw.length > 0 && !raw.includes('Lovelace') && !raw.includes(HOME.email) && !raw.includes('Mountain') &&
          (process.platform === 'win32' || mode === 0o600) && labels === 'Home,Parents,Work' &&
          fresh.reveal('address', 'Home')?.street === HOME.street,
        `file ${raw.length} bytes, mode ${mode?.toString(8)}, read back ${labels}`);

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-autofill-'));
      tmpDirs.push(dir);
      const writer = new Credentials(() => {});
      writer.dir = dir;
      writer.key = crypto.randomBytes(32);
      const good = writer.seal(HOME);
      const badShape = writer.seal({ ...HOME, label: 'Evil', street: { lines: ['x'] } });
      const tampered = { ...writer.seal({ ...HOME, label: 'Altered' }) };
      tampered.ct = Buffer.from(Buffer.from(tampered.ct, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b))).toString('base64');
      fs.writeFileSync(path.join(dir, KINDS.address), JSON.stringify([good, badShape, tampered]));
      const reader = new Credentials(() => {});
      reader.dir = dir;
      reader.key = writer.key;
      reader.capability = () => ({ available: true, reason: null });
      reader.load();
      const kept = reader.records.address.map((r) => r.label).join(',');
      let listedOk = true;
      try { reader.list(); } catch { listedOk = false; }
      check('an address record edited on disk, or of the wrong shape, is dropped and the good one kept',
        kept === 'Home' && listedOk && reader.reveal('address', 'Evil') === null, `kept ${kept}, list ${listedOk ? 'fine' : 'threw'}`);
    }

    /* -------------------------------------------------------------- */
    // Deleting an address: by the request, by the page's own button, and the
    // menu and the fill forget it.
    {
      const deleted = await ask(pwTab, 'delete-credential', { kind: 'address', id: 'Work' });
      const again = await ask(pwTab, 'delete-credential', { kind: 'address', id: 'Work' });
      const wrongKind = await ask(pwTab, 'delete-credential', { kind: 'nonsense', id: 'Home' });
      const notText = await ask(pwTab, 'delete-credential', { kind: 'address', id: { label: 'Home' } });
      const proto = await ask(pwTab, 'delete-credential', { kind: '__proto__', id: 'Home' });
      await js(pwTab, 'load()');
      await waitFor(async () => (await js(pwTab, 'document.querySelectorAll("#addresses .row").length')) === 2, { timeoutMs: 3000 });
      const twice = await js(pwTab, `(async () => {
        const row = [...document.querySelectorAll('#addresses .row')].find((r) => r.querySelector('.row-label')?.textContent === 'Parents');
        const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent === 'Delete');
        if (!b) return 'no button';
        b.click();
        const armed = b.textContent;
        b.click();
        return armed;
      })()`);
      await waitFor(() => !credentials.reveal('address', 'Parents'), { timeoutMs: 3000 });
      const remaining = credentials.records.address.map((r) => r.label).join(',');
      const shown = await (async () => {
        await waitFor(async () => (await js(pwTab, 'document.querySelectorAll("#addresses .row").length')) === 1, { timeoutMs: 3000 });
        return js(pwTab, '[...document.querySelectorAll("#addresses .row-label")].map((l) => l.textContent).join(",")');
      })();
      check('an address is deleted by the request and by pressing Delete twice, and nothing else goes with it',
        deleted === true && again === false && wrongKind === false && notText === false && proto === false &&
          twice === 'Delete?' && remaining === 'Home' && shown === 'Home' && credentials.reveal('payment', CARD.label),
        `delete ${deleted}, again ${again}, wrong kind ${wrongKind}, id not text ${notText}, __proto__ ${proto}, ` +
        `button said "${twice}", left ${remaining}, page shows ${shown}`);

      const after = await page('autofill-address.html');
      const model = await rightClick(after, '#first');
      runCommand('fill-address-here', { id: 'Work' });
      const v = await settled(after);
      const offered = items(model).filter((i) => i.id === 'fill-address-here').map((i) => i.payload?.id);
      check('a deleted address is no longer offered, and asking for it fills nothing',
        offered.join(',') === 'Home' && allEmpty(v), `offered ${offered.join(',')}, page ${JSON.stringify(v)}`);
      close(after);
    }
    close(pwTab);
  } finally {
    if (shell.sheetPage === 'context') shell.closeSheet();
    context.model = null;
    for (const tab of opened) close(tab);
    for (const dir of tmpDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
    // The store and the lock as they were.
    try { credentials.clear(); } catch { /* nothing saved */ }
    credentials.key = before.key;
    credentials.loaded = before.loaded;
    credentials.unavailable = before.unavailable;
    credentials.records = before.records;
    if (before.capability) credentials.capability = before.capability;
    else delete credentials.capability;
    if (credentials.key) {
      for (const [kind, list] of Object.entries(before.records || {})) if (list?.length) credentials.save(kind);
    }
    try { vault.write(before.vaultRecord ?? null); } catch { /* memory only */ }
    vault.unlockedUntil = before.unlockedUntil;
    vault.failures = before.failures;
    vault.blockedUntil = before.blockedUntil;
  }

  const leftOnDisk = Object.entries(KINDS)
    .filter(([kind, file]) => !(before.records?.[kind]?.length) && fs.existsSync(path.join(credentials.dir, file)))
    .map(([, file]) => file);
  check('the autofill checks leave no tabs, saved cards, addresses or passcode behind',
    tabs.all().length === tabsBefore && leftOnDisk.length === 0 && vault.configured() === Boolean(before.vaultRecord) &&
      credentials.key === before.key && tmpDirs.every((dir) => !fs.existsSync(dir)),
    `tabs ${tabsBefore} -> ${tabs.all().length}, files left ${leftOnDisk.join(',') || 'none'}, passcode ${vault.configured()}`);
};
