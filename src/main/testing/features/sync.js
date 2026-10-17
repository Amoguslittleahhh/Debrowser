'use strict';

/**
 * Sync through a folder the user already syncs (data/sync.js), between
 * several computers that all live in this one process.
 *
 * The suite runs offline, so the browser starts no Sync of its own here
 * (getSync() is null) and these checks make theirs. The desk is the browser
 * itself: its real bookmarks, reading list and settings, with a synced setting
 * arriving through the same set-pref command Settings sends. The laptop and
 * the rest are stores of their own in temporary profiles. They share one
 * temporary folder standing in for Dropbox. A test machine has no keyring, so
 * each computer gets a stand-in keystore that only it can open.
 *
 * A step between two computers is `round(t, A, B)`: each in turn reads the
 * folder and writes its file, as its timer would.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nativeTheme } = require('electron');
const { Sync, changedEntries, seal, open, SYNCED_PREFS, DIR_NAME, MIN_PASSPHRASE } = require('../../data/sync');
const { Bookmarks } = require('../../data/bookmarks');
const { ReadingList } = require('../../data/reading-list');
const { Prefs, SCHEMA } = require('../../prefs');
const pages = require('../../pages');

const PASSPHRASE = 'correct horse battery staple';
/** Every address here is under this, so the folder can be searched for any of them in the clear. */
const SITE = 'sync.test';
const at = (name) => `https://${name}.${SITE}/`;
/** Settings that belong to one machine, which must never travel. */
const MACHINE_ONLY = ['memoryBudgetMB', 'maxLiveTabs', 'downloadDir', 'graphicsMode', 'hardwareAcceleration',
  'rememberWindowBounds', 'batteryMode', 'incognitoSearchEngine'];

/** A stand-in for the system keystore: what one machine seals, only that machine opens. */
function keystore(machine) {
  const mark = `sealed-on-${machine}:`;
  return {
    encryptString: (text) => Buffer.from(mark + Buffer.from(text).toString('hex')),
    decryptString: (sealed) => {
      const text = Buffer.from(sealed).toString();
      if (!text.startsWith(mark)) throw new Error('sealed on another machine');
      return Buffer.from(text.slice(mark.length), 'hex').toString();
    }
  };
}

const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const urls = (c) => c.bookmarks.all().map((b) => b.url).sort();
const mark = (c, name) => c.bookmarks.all().find((b) => b.url === at(name));
const has = (c, name) => Boolean(mark(c, name));
const saved = (c, name) => c.readingList.items.find((e) => e.url === at(name));
const deviceFile = (c) => path.join(c.sync.state.folder, 'devices', `${c.sync.state.deviceId}.json`);
const contents = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
/** What a computer last wrote, opened with its key. */
const written = (c) => { try { return open(c.sync.key, JSON.parse(contents(deviceFile(c)))); } catch { return null; } };

/** Each in turn reads the folder and writes its file, a moment apart so each write is later than the last. */
async function round(t, ...computers) {
  let ok = true;
  for (const c of computers) {
    await t.sleep(4);
    const result = c.sync.syncNow();
    if (!result || !result.ok) ok = false;
  }
  return ok;
}

module.exports = async function syncFeature(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-sync-check-'));
  const made = [];

  /** A computer: the browser itself (`real`), or a profile of its own under tmp. */
  const computer = (name, { real = false } = {}) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    const c = { name, dir, applied: [], log: [], keystore: keystore(name) };
    c.prefs = real ? t.prefs : new Prefs(() => {}, { file: path.join(dir, 'preferences.json') });
    c.bookmarks = real ? t.bookmarks : new Bookmarks(() => {}, dir);
    c.readingList = real ? (t.readingList || new ReadingList(null)) : new ReadingList(path.join(dir, 'reading-list.json'));
    // The browser's own settings change as Settings changes them; the others' directly.
    c.setPref = (key, value) => (real ? t.runCommand('set-pref', { key, value }) : c.prefs.set(key, value));
    c.make = () => {
      c.sync = new Sync({
        dir, bookmarks: c.bookmarks, readingList: c.readingList, prefs: c.prefs,
        applyPref: (key, value) => { c.applied.push(key); c.setPref(key, value); },
        safeStorage: c.keystore, keystore: () => ({ available: true, reason: null }),
        log: (line) => c.log.push(line)
      });
      made.push(c.sync);
      return c.sync;
    };
    c.make();
    return c;
  };

  // Put back afterwards: the browser's bookmarks, reading list and every
  // setting these checks could have changed.
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const kept = {
    bookmarks: clone(t.bookmarks.items),
    readingList: t.readingList ? clone(t.readingList.items) : null,
    prefs: Object.fromEntries([...SYNCED_PREFS, ...MACHINE_ONLY].map((k) => [k, clone(t.prefs.values[k])])),
    lightChosen: clone(t.prefs.values.lightChosen)
  };

  try {
    pureChecks(t);
    await pageChecks(t);
    await sharedFolder(t, tmp, computer);
    await sideFolders(t, tmp, computer);
  } finally {
    for (const s of made) clearInterval(s.timer);
    t.bookmarks.items = kept.bookmarks;
    t.bookmarks.save();
    if (t.readingList) {
      t.readingList.items = kept.readingList;
      t.readingList.save();
    }
    for (const [key, value] of Object.entries(kept.prefs)) {
      if (JSON.stringify(t.prefs.values[key]) === JSON.stringify(value)) continue;
      // Through the command, so whatever the setting drives follows it back;
      // following the system's accent is set as it was, not re-taken.
      if (key === 'accentFromSystem') t.prefs.set(key, value);
      else t.runCommand('set-pref', { key, value });
    }
    if (kept.lightChosen === undefined) delete t.prefs.values.lightChosen;
    else t.prefs.values.lightChosen = kept.lightChosen;
    t.prefs.save();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

/* ------------------------------------------------------------------ */
/* The parts with no folder                                            */
/* ------------------------------------------------------------------ */

function pureChecks(t) {
  const { check } = t;

  const before = [
    { url: at('one'), title: 'One', folder: '' },
    { url: at('two'), title: 'Two', folder: 'Work' },
    { url: at('three'), title: 'Three', folder: '' },
    { url: at('four'), title: 'Four', folder: '', addedAt: 1 }
  ];
  const after = [
    { url: at('one'), title: 'One, renamed', folder: '' },
    { url: at('two'), title: 'Two', folder: 'Home' },
    { url: at('four'), title: 'Four', folder: '', addedAt: 2 },
    { url: at('five'), title: 'Five', folder: '' }
  ];
  const edits = changedEntries(before, after, ['title', 'folder']).map((e) => e.url);
  const none = [changedEntries(null, after, ['title']), changedEntries(before, null, ['title']),
    changedEntries(undefined, undefined, ['title']), changedEntries([], [], ['title'])];
  check('only a bookmark\'s title or folder changing counts as an edit to pass on; one added, removed or saved again does not',
    same(edits, [at('one'), at('two')]) && none.every((list) => Array.isArray(list) && list.length === 0),
    `edits ${JSON.stringify(edits)}, empty cases ${JSON.stringify(none)}`);

  const key = crypto.randomBytes(32);
  const value = { v: 1, bookmarks: [{ url: at('sealed'), title: 'Sealed away' }] };
  const one = seal(key, value);
  const two = seal(key, value);
  const flip = (field) => {
    const bytes = Buffer.from(one[field], 'base64');
    bytes[bytes.length - 1] ^= 1;
    return { ...one, [field]: bytes.toString('base64') };
  };
  const altered = {
    'another key': open(crypto.randomBytes(32), one),
    'a changed byte of data': open(key, flip('data')),
    'a changed tag': open(key, flip('tag')),
    'a changed iv': open(key, flip('iv')),
    'data cut short': open(key, { ...one, data: one.data.slice(0, 4) }),
    'no tag': open(key, { ...one, tag: '' })
  };
  let threw = null;
  let malformed = [];
  try {
    malformed = [null, undefined, 7, 'text', [], {}, { iv: 1, tag: 2, data: 3 }, { iv: 'x', tag: 'y', data: 'z' }]
      .map((m) => open(key, m));
  } catch (err) { threw = err.message; }
  const opened = Object.entries(altered).filter(([, v]) => v !== null).map(([k]) => k);
  check('sync data opens only with its own key, and anything altered or malformed opens as nothing rather than throwing',
    JSON.stringify(open(key, one)) === JSON.stringify(value) && opened.length === 0 && !threw &&
      malformed.every((v) => v === null) && one.iv !== two.iv && one.data !== two.data && !JSON.stringify(one).includes(SITE),
    `opened with ${opened.join(', ') || 'nothing wrong'}${threw ? `; threw ${threw}` : ''}; a fresh iv each time ${one.iv !== two.iv}`);

  // Node's GCM takes a tag cut down to 4 bytes unless it is told the length,
  // and then checks only those 4: a forged file needs 2^32 tries, not 2^128.
  const shortTag = { ...one, tag: Buffer.from(one.tag, 'base64').subarray(0, 4).toString('base64') };
  const shortOpened = open(key, shortTag);
  check('sync data whose authentication tag was cut short does not open',
    shortOpened === null, shortOpened === null ? '' : 'a 4-byte tag opened it');

  const unknown = SYNCED_PREFS.filter((k) => !Object.hasOwn(SCHEMA, k));
  const local = SYNCED_PREFS.filter((k) => MACHINE_ONLY.includes(k) || /^(incognito|gpu|vmGpu|graphics|window|devTools)/.test(k));
  check('every synced setting is a real setting, and none of them belongs to one machine or to private windows',
    unknown.length === 0 && local.length === 0, `not settings: ${unknown.join(', ') || 'none'}; one machine's: ${local.join(', ') || 'none'}`);
}

/* ------------------------------------------------------------------ */
/* Settings, and who may ask                                           */
/* ------------------------------------------------------------------ */

async function pageChecks(t) {
  const { check, waitFor, tabs } = t;
  const settings = tabs.create({ url: pages.SETTINGS_URL, activate: true, realise: true });
  const site = tabs.create({ url: t.pageUrl('idle.html'), activate: true, realise: true });
  const newTab = tabs.create({ url: pages.NEW_TAB_URL, activate: true, realise: true });
  try {
    await waitFor(() => [settings, site, newTab].every((tab) => tab.isLive && !tab.loading), { timeoutMs: 10_000 });
    const ask = (tab, command, payload) => tab.wc.executeJavaScript(
      `(window.debrowser && window.debrowser.request) ? window.debrowser.request(${JSON.stringify(command)}, ${JSON.stringify(payload ?? null)}) : 'no bridge'`)
      .catch(() => 'threw');

    // Under the suite the browser has no Sync, as on a machine with no keystore.
    const drawn = await waitFor(() => settings.wc.executeJavaScript(
      'Boolean(document.querySelector("#sync-rows .row"))').catch(() => false), { timeoutMs: 5000 });
    const view = await settings.wc.executeJavaScript(`(() => {
      const rows = document.getElementById('sync-rows');
      return { label: rows.querySelector('.row-label')?.textContent, disabled: rows.querySelector('button')?.disabled,
        input: rows.querySelector('input')?.type, note: document.getElementById('sync-state').textContent };
    })()`).catch(() => ({}));
    const status = await ask(settings, 'sync-status');
    const start = await ask(settings, 'sync-start', { passphrase: PASSPHRASE });
    check('where sync cannot run, Settings says why and its button to turn sync on cannot be pressed',
      drawn && view.label === 'Turn on sync' && view.disabled === true && view.input === 'password' &&
        /isn’t available on this computer/.test(view.note || '') && status && status.on === false && status.available === false &&
        start && start.ok === false && !start.cancelled,
      `page ${JSON.stringify(view)}, status ${JSON.stringify(status)}, start ${JSON.stringify(start)}`);

    const asked = {};
    for (const [label, tab] of [['website', site], ['new tab page', newTab]]) {
      asked[label] = [];
      for (const command of ['sync-status', 'sync-start', 'sync-now', 'sync-stop']) {
        asked[label].push(await ask(tab, command, { passphrase: PASSPHRASE }));
      }
    }
    check('neither a website nor the new tab page can ask about sync, turn it on, run it or stop it',
      Object.values(asked).flat().every((answer) => answer === null || answer === 'no bridge'), JSON.stringify(asked));
  } finally {
    for (const tab of [settings, site, newTab]) if (tabs.all().includes(tab)) tabs.close(tab.id);
  }
}

/* ------------------------------------------------------------------ */
/* The desk, the laptop and the tablet, in one folder                  */
/* ------------------------------------------------------------------ */

async function sharedFolder(t, tmp, computer) {
  const { check } = t;
  const cloud = path.join(tmp, 'Dropbox');
  fs.mkdirSync(cloud);
  const root = path.join(cloud, DIR_NAME);
  const metaFile = path.join(root, 'sync.json');
  const devices = path.join(root, 'devices');

  const A = computer('desk', { real: true });
  const B = computer('laptop');

  // The desk starts with only what these checks give it.
  A.bookmarks.items = [];
  A.bookmarks.save();
  A.readingList.items = [];
  const deskDownloads = path.join(tmp, 'Desk downloads');
  const laptopDownloads = path.join(tmp, 'Laptop downloads');
  const deskBudget = A.prefs.get('memoryBudgetMB');
  A.bookmarks.add({ url: at('shared'), title: 'Saved on the desk' });
  A.bookmarks.add({ url: at('desk-one'), title: 'Desk one' });
  A.readingList.add(at('desk-read'), 'Desk article');
  A.setPref('theme', 'dark');
  A.setPref('tabWidth', 'compact');
  A.setPref('homepage', at('home'));
  A.setPref('downloadDir', deskDownloads);
  B.bookmarks.add({ url: at('shared'), title: 'Saved on the laptop' });
  B.bookmarks.add({ url: at('laptop-one'), title: 'Laptop one' });
  B.readingList.add(at('laptop-read'), 'Laptop article');
  B.setPref('theme', 'light');
  B.setPref('memoryBudgetMB', 2048);
  B.setPref('downloadDir', laptopDownloads);

  // Refused before anything is written.
  {
    const lone = computer('no-keyring');
    lone.sync.keystore = () => ({ available: false, reason: 'no keyring was found' });
    const noKeyring = await lone.sync.start(cloud, PASSPHRASE);
    const short = await B.sync.start(cloud, 'x'.repeat(MIN_PASSPHRASE - 1));
    const odd = [];
    for (const passphrase of [undefined, null, 12345678, ['correct horse battery'], '']) odd.push(await B.sync.start(cloud, passphrase));
    const left = [root, path.join(B.dir, 'sync-key.dat'), path.join(B.dir, 'sync.json')].filter((f) => fs.existsSync(f));
    check('sync is not turned on without a keystore, or with a passphrase shorter than eight characters or none, and nothing is written',
      !noKeyring.ok && /no keyring was found/.test(noKeyring.reason || '') && lone.sync.status().available === false &&
        !short.ok && /at least 8/.test(short.reason || '') && odd.every((r) => r && !r.ok) && left.length === 0 && !B.sync.status().on,
      `no keyring ${JSON.stringify(noKeyring)}, short ${JSON.stringify(short)}, odd ${odd.map((r) => r.ok)}, left ${left.join(', ')}`);
  }

  const setUp = await A.sync.start(cloud, PASSPHRASE);
  const meta = contents(metaFile);
  const deskStatus = A.sync.status();
  const layout = [metaFile, deviceFile(A), path.join(A.dir, 'sync-key.dat'), path.join(A.dir, 'sync.json')].every((f) => fs.existsSync(f));
  check('the first computer sets the folder up: a passphrase check in it, its own file, and its key kept by the keystore',
    setUp.ok && setUp.joined === false && layout && meta && !meta.includes(PASSPHRASE) && deskStatus.on && deskStatus.folder === cloud &&
      !deskStatus.needsPassphrase && deskStatus.devices.length === 0 && A.applied.length === 0,
    `${JSON.stringify(setUp)}, layout ${layout}, status ${JSON.stringify(deskStatus)}`);

  const wrong = await B.sync.start(cloud, `${PASSPHRASE}r`);
  check('another computer giving the wrong passphrase is turned away, and nothing of it is left in the folder or on it',
    !wrong.ok && /isn’t the passphrase/.test(wrong.reason || '') && contents(metaFile) === meta &&
      fs.readdirSync(devices).length === 1 && !fs.existsSync(path.join(B.dir, 'sync-key.dat')) && !B.sync.status().on,
    JSON.stringify(wrong));

  // Joining by choosing the "Debrowser Sync" folder itself, as someone might.
  const joined = await B.sync.start(root, PASSPHRASE);
  await round(t, A);
  const both = [at('desk-one'), at('laptop-one'), at('shared')];
  const reading = [at('desk-read'), at('laptop-read')];
  check('the first time two computers meet, their bookmarks and reading lists are combined, nothing removed or doubled',
    joined.ok && joined.joined === true && B.sync.state.deviceId !== A.sync.state.deviceId &&
      B.sync.state.folder === A.sync.state.folder && same(urls(A), both) && same(urls(B), both) &&
      same(A.readingList.items.map((e) => e.url), reading) && same(B.readingList.items.map((e) => e.url), reading),
    `joined ${JSON.stringify(joined)}; desk ${urls(A).join(' ')}; laptop ${urls(B).join(' ')}`);

  check('a computer joining takes the settings of the one already syncing, which keeps its own',
    B.prefs.get('theme') === 'dark' && B.prefs.get('tabWidth') === 'compact' && B.prefs.get('homepage') === at('home') &&
      A.prefs.get('theme') === 'dark' && A.applied.length === 0,
    `laptop theme ${B.prefs.get('theme')} width ${B.prefs.get('tabWidth')}; desk theme ${A.prefs.get('theme')}, set on desk ${A.applied}`);

  const carried = [written(A), written(B)].map((snap) => (snap ? Object.keys(snap.prefs || {}) : null));
  check('settings that belong to one machine - its memory budget, its download folder - stay on it and are not in its file',
    carried.every((keys) => keys && keys.length > 0 && keys.every((k) => SYNCED_PREFS.includes(k))) &&
      B.prefs.get('memoryBudgetMB') === 2048 && B.prefs.get('downloadDir') === laptopDownloads &&
      A.prefs.get('memoryBudgetMB') === deskBudget && A.prefs.get('downloadDir') === deskDownloads,
    `files carry ${JSON.stringify(carried && carried.map((k) => k && k.filter((x) => !SYNCED_PREFS.includes(x))))}; ` +
      `laptop ${B.prefs.get('memoryBudgetMB')} ${B.prefs.get('downloadDir')}; desk ${A.prefs.get('memoryBudgetMB')} ${A.prefs.get('downloadDir')}`);

  // Once: changed on the laptop afterwards, it is not taken from the desk again.
  B.setPref('theme', 'light');
  await round(t, B);
  const keptLight = B.prefs.get('theme');
  A.setPref('homepage', at('home-two'));
  await round(t, A, B, A);
  check('a joining computer takes the others\' settings once; after that a setting changed on any computer changes just that one on the others, through Settings\' own command',
    keptLight === 'light' && B.prefs.get('theme') === 'light' && B.prefs.get('homepage') === at('home-two') &&
      A.prefs.get('theme') === 'light' && JSON.stringify(A.applied) === '["theme"]' && nativeTheme.themeSource === 'light',
    `laptop theme ${keptLight} then ${B.prefs.get('theme')}, homepage ${B.prefs.get('homepage')}; desk theme ${A.prefs.get('theme')}, ` +
      `set on desk ${JSON.stringify(A.applied)}, engine theme ${nativeTheme.themeSource}`);

  // Bookmarks: added, edited and deleted, on each side.
  A.bookmarks.add({ url: at('desk-two'), title: 'Desk two' });
  await round(t, A, B);
  B.bookmarks.add({ url: at('laptop-two'), title: 'Laptop two' });
  await round(t, B, A);
  check('a bookmark saved on either computer reaches the other', has(B, 'desk-two') && has(A, 'laptop-two'),
    `laptop ${urls(B).join(' ')}; desk ${urls(A).join(' ')}`);

  A.bookmarks.update(mark(A, 'desk-one').id, { title: 'Desk one, renamed', folder: 'Work' });
  await round(t, A, B);
  B.bookmarks.update(mark(B, 'laptop-one').id, { title: 'Laptop one, renamed' });
  await round(t, B, A);
  const onLaptop = mark(B, 'desk-one');
  const onDesk = mark(A, 'laptop-one');
  check('a bookmark renamed or moved to a folder on either computer changes on the other',
    onLaptop && onLaptop.title === 'Desk one, renamed' && onLaptop.folder === 'Work' && onDesk && onDesk.title === 'Laptop one, renamed',
    `on the laptop ${JSON.stringify(onLaptop)}; on the desk ${JSON.stringify(onDesk)}`);

  A.bookmarks.remove(at('desk-two'));
  await round(t, A, B);
  B.bookmarks.remove(at('laptop-two'));
  await round(t, B, A, B, A);
  check('a bookmark deleted on either computer goes from the other, and stays gone',
    !has(A, 'desk-two') && !has(B, 'desk-two') && !has(A, 'laptop-two') && !has(B, 'laptop-two'),
    `desk ${urls(A).join(' ')}; laptop ${urls(B).join(' ')}`);

  // desk-one came to the laptop from the desk. It is deleted on the laptop
  // while the desk, not knowing yet, saves something else and writes its file
  // out again - still listing desk-one.
  B.bookmarks.remove(at('desk-one'));
  A.bookmarks.add({ url: at('desk-three'), title: 'Desk three' });
  await round(t, A, B);
  const notTakenBack = !has(B, 'desk-one') && has(B, 'desk-three');
  await round(t, A, B, A, B);
  // laptop-one came to the desk from the laptop; deleted on the desk.
  A.bookmarks.remove(at('laptop-one'));
  await round(t, A, B, A, B);
  check('a bookmark that came from the other computer and is deleted goes from both and does not come back, even when the other wrote it out again meanwhile',
    notTakenBack && !has(A, 'desk-one') && !has(B, 'desk-one') && !has(A, 'laptop-one') && !has(B, 'laptop-one'),
    `taken back at first ${!notTakenBack}; desk ${urls(A).join(' ')}; laptop ${urls(B).join(' ')}`);

  // Saved again: desk-one (deleted on the laptop) on the desk, laptop-two
  // (deleted on the laptop) on the laptop itself.
  A.bookmarks.add({ url: at('desk-one'), title: 'Desk one, again' });
  B.bookmarks.add({ url: at('laptop-two'), title: 'Laptop two, again' });
  await round(t, A, B, A, B);
  check('a bookmark saved again after it was deleted comes back on both computers, whichever one saves it',
    has(A, 'desk-one') && has(B, 'desk-one') && has(A, 'laptop-two') && has(B, 'laptop-two'),
    `desk ${urls(A).join(' ')}; laptop ${urls(B).join(' ')}`);

  // The reading list.
  A.readingList.add(at('desk-later'), 'Desk, later');
  await round(t, A, B);
  const arrived = saved(B, 'desk-later') && !saved(B, 'desk-later').readAt;
  B.readingList.markRead(at('desk-later'));
  await round(t, B, A);
  const readOnDesk = Boolean(saved(A, 'desk-later') && saved(A, 'desk-later').readAt);
  A.readingList.remove(at('laptop-read'));
  B.readingList.remove(at('desk-later'));
  await round(t, A, B, A, B);
  const removed = !saved(A, 'laptop-read') && !saved(B, 'laptop-read') && !saved(A, 'desk-later') && !saved(B, 'desk-later');
  B.readingList.add(at('laptop-read'), 'Laptop article, again');
  await round(t, B, A, B);
  check('a page saved to read later, read, or removed on one computer is saved, read or removed on the other, and saved again it comes back',
    arrived && readOnDesk && removed && saved(A, 'laptop-read') && saved(B, 'laptop-read'),
    `arrived ${Boolean(arrived)}, read on the desk ${readOnDesk}, removed ${removed}, back ${Boolean(saved(A, 'laptop-read'))}`);

  A.readingList.markRead(at('desk-read'));
  await round(t, A, B);
  const readOnLaptop = Boolean(saved(B, 'desk-read') && saved(B, 'desk-read').readAt);
  await t.sleep(4);
  A.readingList.add(at('desk-read'), 'Desk article');
  await round(t, A, B);
  // Anything at all, so the laptop writes its file out again.
  B.bookmarks.add({ url: at('laptop-three'), title: 'Laptop three' });
  await round(t, B, A);
  check('a page saved again to read later stays unread, though another computer still has it as read',
    readOnLaptop && saved(A, 'desk-read') && !saved(A, 'desk-read').readAt,
    `read on the laptop ${readOnLaptop}; on the desk after saving again and a sync: ${JSON.stringify(saved(A, 'desk-read'))}`);

  // Echoes. The desk changes a setting; the laptop takes it in and writes it
  // back out; the desk changes its mind before it has read the laptop again.
  A.setPref('tabWidth', 'roomy');
  await round(t, A, B);
  const followed = B.prefs.get('tabWidth');
  A.setPref('tabWidth', 'compact');
  await round(t, A);
  const deskAfter = A.prefs.get('tabWidth');
  await round(t, B, A);
  check('a setting changed again is not put back by another computer that is only passing on the earlier change',
    followed === 'roomy' && deskAfter === 'compact' && A.prefs.get('tabWidth') === 'compact' && B.prefs.get('tabWidth') === 'compact',
    `laptop followed to ${followed}; desk, changed back to compact, has ${deskAfter} after its sync; then desk ${A.prefs.get('tabWidth')}, laptop ${B.prefs.get('tabWidth')}`);

  const three = mark(A, 'desk-three').id;
  A.bookmarks.update(three, { title: 'Desk three, first name' });
  await round(t, A, B);
  A.bookmarks.update(three, { title: 'Desk three, second name' });
  await round(t, A);
  const deskTitle = mark(A, 'desk-three').title;
  await round(t, B, A);
  check('a bookmark renamed again is not put back by another computer that is only passing on its earlier name',
    deskTitle === 'Desk three, second name' && mark(A, 'desk-three').title === deskTitle && mark(B, 'desk-three').title === deskTitle,
    `desk after its own rename and a sync: ${deskTitle}; then desk ${mark(A, 'desk-three').title}, laptop ${mark(B, 'desk-three').title}`);

  // A third computer.
  const C = computer('tablet');
  C.bookmarks.add({ url: at('tablet-one'), title: 'Tablet one' });
  const cJoined = await C.sync.start(cloud, PASSPHRASE);
  await round(t, A, B, C);
  const deleted = ['desk-two', 'laptop-one'];
  check('a third computer joins: it takes the settings and every bookmark, none of the deleted ones, and the others take its own',
    cJoined.ok && cJoined.joined && [A, B, C].every((c) => has(c, 'tablet-one') && deleted.every((d) => !has(c, d))) &&
      same(urls(C), urls(A)) && same(urls(B), urls(A)) && C.prefs.get('theme') === A.prefs.get('theme') &&
      C.prefs.get('homepage') === A.prefs.get('homepage') && C.sync.status().devices.length === 2,
    `desk ${urls(A).join(' ')}; laptop ${urls(B).join(' ')}; tablet ${urls(C).join(' ')}; tablet theme ${C.prefs.get('theme')}; ` +
      `tablet sees ${C.sync.status().devices.length} others`);

  C.bookmarks.remove(at('shared'));
  await round(t, C, A, B);
  // A deletion on the desk that the tablet hears of only from the laptop:
  // its copy of the folder has the laptop's file, and not yet the desk's.
  A.bookmarks.remove(at('desk-three'));
  await round(t, A, B);
  const aside = path.join(tmp, 'desk-file-in-transit.json');
  const deskFile = deviceFile(A);
  fs.renameSync(deskFile, aside);
  await round(t, C);
  const goneOnTablet = !has(C, 'desk-three');
  fs.renameSync(aside, deskFile);
  await round(t, A, B, C, A, B, C);
  check('a deletion on one computer reaches a third through whichever computer it hears from first, and stays gone everywhere',
    [A, B, C].every((c) => !has(c, 'shared') && !has(c, 'desk-three')) && goneOnTablet,
    `gone on the tablet from the laptop's file alone ${goneOnTablet}; desk ${urls(A).join(' ')}; tablet ${urls(C).join(' ')}`);

  // Restarted.
  await round(t, A, B, C, A, B, C);
  const was = { desk: urls(A), laptop: urls(B), applied: A.applied.length + B.applied.length, id: A.sync.state.deviceId,
    deskFile: contents(deviceFile(A)), laptopFile: contents(deviceFile(B)) };
  A.make();
  B.make();
  const carriedOn = await round(t, A, B, A, B);
  const deskNow = A.sync.status();
  check('restarted, a computer carries on from where it was: still on, nothing taken in or set again, its file not written again',
    deskNow.on && !deskNow.needsPassphrase && !deskNow.error && A.sync.state.deviceId === was.id && carriedOn &&
      same(urls(A), was.desk) && same(urls(B), was.laptop) && A.applied.length + B.applied.length === was.applied &&
      contents(deviceFile(A)) === was.deskFile && contents(deviceFile(B)) === was.laptopFile && A.sync.state.adoptPrefs === false,
    `status ${JSON.stringify(deskNow)}; settings set again ${A.applied.length + B.applied.length - was.applied}; ` +
      `desk file rewritten ${contents(deviceFile(A)) !== was.deskFile}, laptop's ${contents(deviceFile(B)) !== was.laptopFile}`);

  // Deleted, and the browser closed before the next sync.
  B.bookmarks.remove(at('laptop-two'));
  B.make();
  await round(t, B, A, C);
  check('a bookmark deleted just before the browser closed still goes from the other computers once it is back',
    !has(A, 'laptop-two') && !has(C, 'laptop-two') && !has(B, 'laptop-two'), `desk ${urls(A).join(' ')}`);

  // The laptop's keystore no longer opens the key - a reinstalled system.
  B.keystore = keystore('laptop, reinstalled');
  B.make();
  const lost = B.sync.status();
  const refused = B.sync.syncNow();
  const appliedBefore = B.applied.length;
  B.bookmarks.add({ url: at('laptop-four'), title: 'Laptop four' });
  const again = await B.sync.start(cloud, PASSPHRASE);
  await round(t, A, C);
  check('a computer whose keystore lost the key asks for the passphrase again, and given it carries on without taking the others\' settings again',
    lost.on && lost.needsPassphrase && /passphrase again/.test(lost.error || '') && !refused.ok && again.ok &&
      B.applied.length === appliedBefore && has(A, 'laptop-four') && has(C, 'laptop-four'),
    `status ${JSON.stringify(lost)}; start ${JSON.stringify(again)}; settings set again ${B.applied.length - appliedBefore}`);

  await hostileFiles(t, { A, B, C, devices, tmp });

  // Nothing new: no file is written again.
  await round(t, A, B, C, A, B, C, A, B, C);
  const files = [A, B, C].map((c) => ({ name: c.name, file: deviceFile(c), body: contents(deviceFile(c)), mtime: fs.statSync(deviceFile(c)).mtimeMs }));
  await t.sleep(30);
  await round(t, A, B, C, A, B, C);
  const rewritten = files.filter((f) => contents(f.file) !== f.body || fs.statSync(f.file).mtimeMs !== f.mtime).map((f) => f.name);
  check('a computer with nothing new does not write its file again, so the folder has nothing to upload',
    rewritten.length === 0, `rewritten: ${rewritten.join(', ')}`);

  const tabletFile = deviceFile(C);
  fs.rmSync(tabletFile);
  await round(t, C);
  const restored = fs.existsSync(tabletFile);
  check('a computer\'s file that went missing from the folder is written again at its next sync',
    restored, restored ? '' : 'the tablet synced "up to date" with no file of its own in the folder');
  if (!restored) {
    // So what follows does not inherit it: anything new makes the tablet write.
    C.bookmarks.add({ url: at('tablet-two'), title: 'Tablet two' });
    await round(t, C, A, B);
  }

  const everyFile = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? everyFile(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const inFolder = everyFile(cloud);
  const clear = inFolder.filter((f) => {
    const text = fs.readFileSync(f, 'latin1');
    return text.includes(SITE) || /Desk one|Laptop article|"bookmarks"|"readingList"|"prefs"|"deleted"/.test(text);
  });
  check('nothing in the synced folder can be read without the passphrase: no address, title, list or setting in the clear',
    inFolder.length >= 4 && clear.length === 0, `${inFolder.length} files; readable: ${clear.map((f) => path.relative(cloud, f)).join(', ')}`);

  // Stopping, on the laptop.
  const laptopId = B.sync.state.deviceId;
  const laptopFile = deviceFile(B);
  const laptopHad = urls(B);
  const deskHad = urls(A);
  clearInterval(B.sync.timer);
  B.sync.stop();
  const gone = [laptopFile, path.join(B.dir, 'sync.json'), path.join(B.dir, 'sync-key.dat')].filter((f) => fs.existsSync(f));
  const stay = [deviceFile(A), deviceFile(C), metaFile].every((f) => fs.existsSync(f));
  const off = !B.sync.status().on && !B.sync.syncNow().ok;
  B.make();
  const offAfterRestart = !B.sync.status().on;
  await round(t, A, C);
  check('stopping sync on a computer takes its file from the folder and its key from the computer, and leaves every bookmark where it was',
    gone.length === 0 && stay && off && offAfterRestart && same(urls(B), laptopHad) && same(urls(A), deskHad),
    `left behind: ${gone.join(', ') || 'nothing'}; others' files there ${stay}; off ${off}, after a restart ${offAfterRestart}`);
  const listed = A.sync.status().devices.map((d) => d.id);
  check('a computer that stopped syncing is no longer listed among the others',
    !listed.includes(laptopId) && listed.includes(C.sync.state.deviceId),
    `the desk lists ${listed.join(', ')}; the laptop was ${laptopId}`);

  // Old deletions are forgotten, so the list of them does not grow for ever.
  const day = 24 * 60 * 60 * 1000;
  C.sync.state.deleted.bookmarks[at('deleted-long-ago')] = Date.now() - 91 * day;
  C.sync.state.deleted.bookmarks[at('deleted-lately')] = Date.now() - day;
  await round(t, C);
  const remembered = Object.keys((written(C) || {}).deleted?.bookmarks || {});
  check('a deletion is remembered for weeks and then forgotten, so the list of them does not grow for ever',
    !remembered.includes(at('deleted-long-ago')) && remembered.includes(at('deleted-lately')), remembered.join(' '));

  await timersAndTurns(t, { A, C });
}

/** Files in devices/ that are not one computer's sound file. */
async function hostileFiles(t, { A, B, C, devices }) {
  const { check } = t;
  const laptopFile = deviceFile(B);
  const laptopBody = contents(laptopFile);
  const laptopSnap = open(B.sync.key, JSON.parse(laptopBody));
  const later = Date.now() + 60_000;
  // What each file would do if it were read: add a bookmark, and delete desk-one.
  const forged = (name) => ({
    ...laptopSnap, at: later,
    bookmarks: [...laptopSnap.bookmarks, { url: at(name), title: name, folder: '', addedAt: Date.now() }],
    deleted: { bookmarks: { [at('desk-one')]: later }, readingList: {} }
  });
  const tampered = (() => {
    const sealed = JSON.parse(laptopBody);
    const data = Buffer.from(sealed.data, 'base64');
    data[Math.floor(data.length / 2)] ^= 0x20;
    return JSON.stringify({ ...sealed, data: data.toString('base64') });
  })();
  const planted = {
    'aaaaaaaaaaaaaaaa.json': JSON.stringify(seal(crypto.randomBytes(32), forged('another-passphrase'))),
    'cccccccccccccccc.json': laptopBody.slice(0, Math.floor(laptopBody.length / 2)),
    'dddddddddddddddd.json': '',
    'eeeeeeeeeeeeeeee.json': 'null',
    '.DS_Store': '\u0000\u0000\u0000\u0001Bud1',
    'desktop.ini': '[.ShellClassInfo]'
  };
  // Valid files, sealed with the folder's own key, under names a synced
  // folder gives copies: none of them is a computer's file.
  const conflicted = JSON.stringify(seal(B.sync.key, forged('conflicted-copy')));
  const id = B.sync.state.deviceId;
  for (const name of [`${id} (conflicted copy 2026-10-17).json`, `${id} (laptop's conflicted copy).json`,
    `${id}.sync-conflict-20261017-053409-ABCDEFG.json`, `${id}.json.tmp`, `${id}.json~`, `${id.toUpperCase()}.json`,
    `${id.slice(0, 15)}.json`, `${id}0.json`]) planted[name] = conflicted;
  for (const [name, body] of Object.entries(planted)) fs.writeFileSync(path.join(devices, name), body);
  fs.mkdirSync(path.join(devices, 'ffffffffffffffff.json'));
  // And the laptop's own file damaged in transit.
  fs.writeFileSync(laptopFile, tampered);

  const deskHad = urls(A);
  const known = Object.keys(A.sync.state.remote).sort();
  let result = null;
  let threw = null;
  try { result = A.sync.syncNow(); } catch (err) { threw = err.stack || err.message; }
  check('damaged, cut-short, empty or foreign files in the folder, and conflicted copies of a computer\'s file, are passed over and sync carries on',
    !threw && result && result.ok && same(urls(A), deskHad) && has(A, 'desk-one') &&
      same(Object.keys(A.sync.state.remote), known) && !A.sync.status().error,
    threw || `result ${JSON.stringify(result)}; desk now ${urls(A).join(' ')}; knows ${Object.keys(A.sync.state.remote).join(', ')}`);

  for (const name of Object.keys(planted)) fs.rmSync(path.join(devices, name), { force: true });
  fs.rmSync(path.join(devices, 'ffffffffffffffff.json'), { recursive: true, force: true });
  fs.writeFileSync(laptopFile, laptopBody);
  B.bookmarks.add({ url: at('laptop-five'), title: 'Laptop five' });
  await round(t, B, A);
  check('after a damaged file, the next sound one from that computer is taken in', has(A, 'laptop-five'), urls(A).join(' '));

  // A file sealed with the right key - another computer, or another version
  // of Debrowser - with a malformed entry in its list.
  const oddFile = path.join(devices, '1111111111111111.json');
  fs.writeFileSync(oddFile, JSON.stringify(seal(A.sync.key, {
    v: 1, device: { id: '1111111111111111', name: 'Odd one' }, at: Date.now(),
    bookmarks: [null, { url: at('odd-one'), title: 'Odd one' }], readingList: [null], deleted: null, prefs: null
  })));
  B.bookmarks.add({ url: at('laptop-six'), title: 'Laptop six' });
  await round(t, B);
  const oddResult = A.sync.syncNow();
  const deskWrote = written(A);
  check('one computer\'s file with a malformed entry does not stop the others from syncing',
    oddResult.ok && has(A, 'laptop-six') && deskWrote && deskWrote.bookmarks.some((b) => b.url === at('laptop-six')),
    `result ${JSON.stringify(oddResult)}; laptop-six on the desk ${has(A, 'laptop-six')}`);
  fs.rmSync(oddFile);
  await round(t, A, B, C);

  // A link named like a computer's file, to a file that never ends. Read for
  // real it would take the browser's main process with it, so the read is
  // stopped at the door and noted.
  if (process.platform !== 'win32' && fs.existsSync('/dev/zero')) {
    const link = path.join(devices, '2222222222222222.json');
    fs.symlinkSync('/dev/zero', link);
    const realRead = fs.readFileSync;
    let attempted = false;
    fs.readFileSync = function guardedRead(file, ...rest) {
      let endless = false;
      try {
        const stat = fs.statSync(file);
        endless = !stat.isFile() && !stat.isDirectory();
      } catch { /* the real read says why */ }
      if (endless) {
        attempted = true;
        throw new Error('a file that never ends');
      }
      return realRead.call(this, file, ...rest);
    };
    let linkResult = null;
    try { linkResult = A.sync.syncNow(); } finally { fs.readFileSync = realRead; }
    fs.rmSync(link);
    check('a link in the folder to a device that never ends is not read, so it cannot hang the browser',
      !attempted && linkResult && linkResult.ok, `read attempted ${attempted}; result ${JSON.stringify(linkResult)}`);
  }
}

/** The timer, and a sync asked for while one is running. */
async function timersAndTurns(t, { A, C }) {
  const { check } = t;
  const s = C.sync;
  const realSetTimeout = globalThis.setTimeout;
  const kicks = [];
  globalThis.setTimeout = function capture(...args) {
    const handle = realSetTimeout.apply(this, args);
    kicks.push(handle);
    return handle;
  };
  let first;
  let second;
  try {
    s.schedule(60_000);
    first = s.timer;
    s.schedule(60_000);
    second = s.timer;
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  const holding = [second, ...kicks].filter((h) => !h || typeof h.hasRef !== 'function' || h.hasRef());
  const replaced = first !== second && first._destroyed === true;
  clearInterval(second);
  for (const kick of kicks) clearTimeout(kick);
  check('the sync timer never keeps the browser open, and scheduling it again replaces it rather than adding a second',
    holding.length === 0 && kicks.length === 2 && replaced,
    `timers holding the browser open ${holding.length}; first sync timers ${kicks.length}; old timer cleared ${replaced}`);

  // Taking in another computer's bookmark saves the tablet's bookmarks, and
  // whatever listens for that asks for a sync - inside the one running.
  const inner = [];
  const listening = C.bookmarks.onChange;
  C.bookmarks.onChange = () => { inner.push(C.sync.syncNow()); };
  A.bookmarks.add({ url: at('desk-four'), title: 'Desk four' });
  await round(t, A);
  let outer;
  try { outer = C.sync.syncNow(); } finally { C.bookmarks.onChange = listening; }
  check('a sync asked for while one is running does not start a second one inside it',
    outer && outer.ok && inner.length >= 1 && inner.every((r) => r && r.ok === false) && C.sync.running === false && has(C, 'desk-four'),
    `outer ${JSON.stringify(outer)}; inner ${JSON.stringify(inner)}`);

  const items = C.readingList.items;
  Object.defineProperty(C.readingList, 'items', { configurable: true, get() { throw new Error('the disk went away'); } });
  let failed;
  try { failed = C.sync.syncNow(); } finally {
    Object.defineProperty(C.readingList, 'items', { configurable: true, enumerable: true, writable: true, value: items });
  }
  const recovered = C.sync.syncNow();
  check('a sync that fails part way says so, and the next one runs',
    failed && !failed.ok && /Sync failed/.test(failed.reason || '') && recovered.ok && C.sync.status().error === null && C.sync.running === false,
    `failed ${JSON.stringify(failed)}; next ${JSON.stringify(recovered)}`);
}

/* ------------------------------------------------------------------ */
/* Other folders, for what needs one to itself                         */
/* ------------------------------------------------------------------ */

async function sideFolders(t, tmp, computer) {
  const { check } = t;

  // The second computer's copy of the folder has sync.json, but not yet the
  // first computer's own file.
  const cloud = path.join(tmp, 'OneDrive');
  fs.mkdirSync(cloud);
  const P = computer('office');
  const Q = computer('home');
  P.setPref('theme', 'dark');
  P.setPref('searchEngine', 'duckduckgo');
  P.bookmarks.add({ url: at('office-one'), title: 'Office one' });
  const composed = 'crème brûlée, café au lait'.normalize('NFC');
  await P.sync.start(cloud, composed);
  const officeFile = deviceFile(P);
  const inTransit = path.join(tmp, 'office-file-in-transit.json');
  fs.renameSync(officeFile, inTransit);
  const homeJoined = await Q.sync.start(cloud, composed.normalize('NFD'));
  check('the same passphrase typed in another Unicode form, as one keyboard or another may send it, opens the folder',
    homeJoined.ok && homeJoined.joined === true, JSON.stringify(homeJoined));
  fs.renameSync(inTransit, officeFile);
  await round(t, Q, P, Q);
  check('a computer that joins before the others\' files have reached it still takes their settings once they do',
    has(Q, 'office-one') && Q.prefs.get('theme') === 'dark' && Q.prefs.get('searchEngine') === 'duckduckgo',
    `home has the office's bookmark ${has(Q, 'office-one')}; theme ${Q.prefs.get('theme')}, search ${Q.prefs.get('searchEngine')}`);

  // Light graphics on the office machine: reduce motion reads as on there,
  // chosen by nobody.
  const motion = Q.prefs.get('reduceMotion');
  P.prefs.setLight(true);
  await round(t, P, Q);
  const motionAfter = Q.prefs.get('reduceMotion');
  P.prefs.setLight(false);
  await round(t, P, Q);
  check('what light graphics decides for one machine is not passed to the others as a setting the user chose',
    motion === false && motionAfter === false, `reduce motion on the other computer: ${motion}, then ${motionAfter}`);

  // The office's clock runs a day fast, writes, and is put right - as a
  // dual-booted machine's is on every start, until it has asked the network.
  const realNow = Date.now;
  Date.now = () => realNow() + 24 * 60 * 60 * 1000;
  try {
    P.bookmarks.add({ url: at('office-fast-clock'), title: 'Saved while the clock was fast' });
    P.sync.syncNow();
  } finally {
    Date.now = realNow;
  }
  await round(t, Q);
  P.bookmarks.add({ url: at('office-right-clock'), title: 'Saved once the clock was right' });
  await round(t, P, Q);
  check('a computer whose clock was put back is still heard from',
    has(Q, 'office-fast-clock') && has(Q, 'office-right-clock'),
    `from the fast clock ${has(Q, 'office-fast-clock')}; after it was put right ${has(Q, 'office-right-clock')}`);

  // The home profile copied to a new computer, whose keystore cannot open the
  // key, while the original carries on.
  const copyDir = path.join(tmp, 'home-copy');
  fs.cpSync(Q.dir, copyDir, { recursive: true });
  const R = computer('home-copy');
  const needs = R.sync.status().needsPassphrase;
  const copyStarted = await R.sync.start(cloud, composed);
  R.bookmarks.add({ url: at('copy-only'), title: 'Only on the copy' });
  Q.bookmarks.add({ url: at('original-only'), title: 'Only on the original' });
  // The two alone: through the office's file each would hear of the other
  // second-hand, and not from each other's.
  await round(t, R, Q, R, Q);
  check('a profile copied to a new computer syncs as a computer of its own, with the one it was copied from',
    needs && copyStarted.ok && has(Q, 'copy-only') && has(R, 'original-only'),
    `asked for the passphrase ${needs}; same id as the original ${R.sync.state && R.sync.state.deviceId === Q.sync.state.deviceId}; ` +
      `original has the copy's ${has(Q, 'copy-only')}, copy has the original's ${has(R, 'original-only')}`);

  // A damaged passphrase check, and a file chosen as the folder.
  const share = path.join(tmp, 'Network share');
  fs.mkdirSync(share);
  const X = computer('server-a');
  const Y = computer('server-b');
  const eight = 'x'.repeat(MIN_PASSPHRASE);
  X.bookmarks.add({ url: at('server-one'), title: 'Server one' });
  const eightOk = await X.sync.start(share, eight);
  const meta = path.join(share, DIR_NAME, 'sync.json');
  const whole = contents(meta);
  const tries = [];
  for (const broken of [whole.slice(0, Math.floor(whole.length / 2)), '', '{}', 'null', '[]', '{"salt": 5}',
    JSON.stringify({ v: 1, salt: 'AAAA', check: null })]) {
    fs.writeFileSync(meta, broken);
    try { tries.push(await Y.sync.start(share, eight)); } catch (err) { tries.push({ threw: err.message }); }
  }
  fs.writeFileSync(meta, whole);
  const notAFolder = path.join(tmp, 'not-a-folder.txt');
  fs.writeFileSync(notAFolder, 'a file');
  const fileTried = await Y.sync.start(notAFolder, eight);
  const serverOn = X.sync.syncNow();
  check('a passphrase of exactly eight characters is enough; a damaged passphrase check, or a file chosen as the folder, is refused with a reason, never thrown',
    eightOk.ok && tries.every((r) => r && r.ok === false && typeof r.reason === 'string') && fileTried.ok === false &&
      typeof fileTried.reason === 'string' && serverOn.ok && !Y.sync.status().on,
    `eight ${JSON.stringify(eightOk)}; damaged ${JSON.stringify(tries)}; file ${JSON.stringify(fileTried)}`);

  // The passphrase check gone - deleted, or not arrived yet - while another
  // computer's file is there. The right passphrase, given again.
  fs.rmSync(meta);
  const Z = computer('server-c');
  const split = await Z.sync.start(share, eight);
  await round(t, X, Z, X, Z);
  check('a computer that finds others\' files but no passphrase check does not start a separate sync of its own in the same folder',
    !split.ok || has(Z, 'server-one'),
    `turned on ${split.ok} (${JSON.stringify(split)}); has the other computer's bookmark ${has(Z, 'server-one')}`);
}
