'use strict';

/**
 * Importing from Safari: its bookmarks from Bookmarks.plist (a binary property
 * list) and its history from History.db beside it.
 *
 * Safari's folder is macOS-only, so the files are built here, in a temporary
 * folder: a small bplist00 writer below, plus one file Python's plistlib wrote,
 * so the reader is checked against a writer that is not this file's. Then the
 * hostile ones - cut short, lying about their own shape, referring to
 * themselves - which must be refused, quickly, and never take the browser down.
 * Those that could hang are read in a worker with a deadline.
 *
 * Then the real flow: Settings' "Find browsers" and its Import button, run
 * with this process briefly believing it is a Mac whose home folder is the
 * temporary one, since that is the only way findProfiles lists Safari.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const pages = require('../../pages');
const importer = require('../../data/importer');
const { Bookmarks, readProfile, findProfiles } = require('../../data/bookmarks');

const IMPORTER = require.resolve('../../data/importer');
const SAFARI_EPOCH_MS = 978307200000;
const toSafari = (ms) => (ms - SAFARI_EPOCH_MS) / 1000;

/* ------------------------------------------------------------------ */
/* A binary property list writer, enough for the fixtures              */
/* ------------------------------------------------------------------ */

/** A number written as a real even when it is whole; `single` for a 4-byte float. */
class Real { constructor(value, single = false) { this.value = value; this.single = single; } }

const isDict = (v) => v instanceof Map || (v && typeof v === 'object' && !Array.isArray(v) &&
  !(v instanceof Date) && !Buffer.isBuffer(v) && !(v instanceof Real));

function uintBytes(n, size) {
  const b = Buffer.alloc(size);
  let v = BigInt(n);
  for (let i = size - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

function intObject(n) {
  const size = n < 0x100 ? 1 : n < 0x10000 ? 2 : n < 2 ** 32 ? 4 : 8;
  return Buffer.concat([Buffer.from([0x10 | Math.log2(size)]), uintBytes(n, size)]);
}

/** An object's marker, with its length inline or, from 15, as an integer after it. */
const head = (kind, n) => (n < 15 ? Buffer.from([(kind << 4) | n])
  : Buffer.concat([Buffer.from([(kind << 4) | 0x0f]), intObject(n)]));

/**
 * Objects (already encoded) laid out as a file. Every part of the trailer can
 * be overridden, which is how the hostile files lie about themselves.
 */
function assemble(objects, { top = 0, refSize = 1, offsetSize = null, count = objects.length, tableAt = null, offsets = null } = {}) {
  const parts = [Buffer.from('bplist00', 'latin1')];
  let at = 8;
  const where = [];
  for (const o of objects) { where.push(at); parts.push(o); at += o.length; }
  const size = offsetSize || (at < 0x100 ? 1 : at < 0x10000 ? 2 : 4);
  const table = Buffer.concat((offsets || where).map((o) => uintBytes(o, size)));
  const trailer = Buffer.alloc(32);
  trailer[6] = size;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(count), 8);
  trailer.writeBigUInt64BE(BigInt(top), 16);
  trailer.writeBigUInt64BE(BigInt(tableAt ?? at), 24);
  return Buffer.concat([...parts, table, trailer]);
}

/** Any JS value as a binary property list. A Map is a dictionary whose keys are taken as given. */
function writePlist(root) {
  const nodes = [];
  const flatten = (v) => {
    const i = nodes.length;
    const node = { v, kids: [] };
    nodes.push(node);
    if (Array.isArray(v)) node.kids = v.map(flatten);
    else if (isDict(v)) {
      const entries = v instanceof Map ? [...v] : Object.entries(v);
      node.kids = entries.map(([k]) => flatten(k)).concat(entries.map(([, val]) => flatten(val)));
    }
    return i;
  };
  flatten(root);
  const refSize = nodes.length < 0x100 ? 1 : nodes.length < 0x10000 ? 2 : 4;
  const refs = (kids) => Buffer.concat(kids.map((k) => uintBytes(k, refSize)));
  const double = (marker, n) => { const b = Buffer.alloc(9); b[0] = marker; b.writeDoubleBE(n, 1); return b; };
  const encode = ({ v, kids }) => {
    if (v === null || v === undefined) return Buffer.from([0x00]);
    if (v === false) return Buffer.from([0x08]);
    if (v === true) return Buffer.from([0x09]);
    if (v instanceof Real && v.single) { const b = Buffer.alloc(5); b[0] = 0x22; b.writeFloatBE(v.value, 1); return b; }
    if (v instanceof Real) return double(0x23, v.value);
    if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? intObject(v) : double(0x23, v);
    if (v instanceof Date) return double(0x33, toSafari(v.getTime()));
    if (Buffer.isBuffer(v)) return Buffer.concat([head(0x4, v.length), v]);
    if (typeof v === 'string') {
      if (/^[\x00-\x7f]*$/.test(v)) return Buffer.concat([head(0x5, v.length), Buffer.from(v, 'latin1')]);
      return Buffer.concat([head(0x6, v.length), Buffer.from(v, 'utf16le').swap16()]);
    }
    if (Array.isArray(v)) return Buffer.concat([head(0xa, kids.length), refs(kids)]);
    return Buffer.concat([head(0xd, kids.length / 2), refs(kids)]);
  };
  return assemble(nodes.map(encode), { refSize });
}

/* Safari's shapes. */
const leaf = (url, title) => ({
  WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: url, WebBookmarkUUID: 'B0A1C2D3-0000-4000-8000-000000000000',
  ...(title === undefined ? {} : { URIDictionary: { title } })
});
const folder = (Title, Children) => ({ Title, WebBookmarkType: 'WebBookmarkTypeList', WebBookmarkUUID: 'F', Children });
const library = (children) => ({ Title: '', WebBookmarkType: 'WebBookmarkTypeList', WebBookmarkFileVersion: 1, Children: children });

/* Written by Python's plistlib: the bar with a unicode folder, the Reading List, and a Sync dictionary of every scalar kind. */
const PYTHON_PLIST = 'YnBsaXN0MDDUAQIDBAUyMxdYQ2hpbGRyZW5VVGl0bGVfEBZXZWJCb29rbWFya0ZpbGVWZXJzaW9uXxAPV2ViQm9va21hcmtUeXBlowYZJNMBAgQHGBeiCBDTCQoECw4PXVVSSURpY3Rpb25hcnlZVVJMU3RyaW5n0QwNVXRpdGxlVUFwcGxlXxAWaHR0cHM6Ly93d3cuYXBwbGUuY29tL18QE1dlYkJvb2ttYXJrVHlwZUxlYWbTAQIEERYXoRLTCQoEExUP0QwUbxARZeVnLAAgAC0AIABXAGkAawBpAHAAZQBkAGkAYQAg2DzfjF8QMGh0dHBzOi8vamEud2lraXBlZGlhLm9yZy93aWtpLyVFNiU5NyVBNSVFNiU5QyVBQ2kAQwBhAGYA6QAgJhUAIGXlZyxfEBNXZWJCb29rbWFya1R5cGVMaXN0XEJvb2ttYXJrc0JhctMBAgQaIxehG9QcCQoEHSAiD1tSZWFkaW5nTGlzdNEeH1lEYXRlQWRkZWQzQcXxMyAAAADRDCFVTGF0ZXJfEBZodHRwczovL2xhdGVyLmV4YW1wbGUvXxAVY29tLmFwcGxlLlJlYWRpbmdMaXN01CUJCgQmLzEPVFN5bmPUJygpKissLS5URGF0YVNPZmZST25UUmVhbEMAAQIICSNABAAAAAAAANEMMF8QEVB5dGhvbiB3cm90ZSB0aGlzXxAYaHR0cHM6Ly9weXRob24uZXhhbXBsZS94UBABAAgAEQAaACAAOQBLAE8AVgBZAGAAbgB4AHsAgQCHAKAAtgC9AL8AxgDJAO4BIQE0AUoBVwFeAWABaQF1AXgBggGLAY4BlAGtAcUBzgHTAdwB4QHlAegB7QHxAfIB8wH8Af8CEwIuAi8AAAAAAAACAQAAAAAAAAA0AAAAAAAAAAAAAAAAAAACMQ==';

/* ------------------------------------------------------------------ */
/* Reading where a bad file cannot hang the browser                    */
/* ------------------------------------------------------------------ */

const WORKER = `
const { parentPort, workerData } = require('worker_threads');
const { parseBinaryPlist } = require(workerData.importer);
parentPort.postMessage(workerData.files.map((bytes) => {
  try {
    const v = parseBinaryPlist(Buffer.from(bytes));
    return { value: v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v };
  } catch (err) { return { threw: String(err && err.message) }; }
}));`;

/** Parse each file in a worker: {results} or, when it ran out of time or memory, {failed}. */
function parseApart(files, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const worker = new Worker(WORKER, { eval: true, workerData: { importer: IMPORTER, files },
      resourceLimits: { maxOldGenerationSizeMb: 192 } });
    const timer = setTimeout(() => { resolve({ failed: `still reading after ${ms} ms` }); worker.terminate(); }, ms);
    worker.once('message', (results) => { clearTimeout(timer); resolve({ results, ms: Date.now() - started }); worker.terminate(); });
    worker.once('error', (err) => { clearTimeout(timer); resolve({ failed: err.code || err.message }); });
    worker.once('exit', (code) => { clearTimeout(timer); resolve({ failed: `worker exited ${code}` }); });
  });
}

const attempt = (fn) => { try { return { value: fn() }; } catch (err) { return { threw: err.message }; } };

/** Run `fn` while `fs[name]` refuses `file` with `code`, as macOS refuses an app without Full Disk Access. */
function refusing(name, file, code, fn) {
  const real = fs[name];
  fs[name] = function (target, ...rest) {
    if (String(target) === file) {
      const err = new Error(`${code}: operation not permitted, open '${file}'`);
      err.code = code;
      throw err;
    }
    return real.call(this, target, ...rest);
  };
  const restore = () => { fs[name] = real; };
  let out;
  try { out = fn(); } catch (err) { restore(); throw err; }
  // Held across an await when the work is asynchronous, and no longer.
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

module.exports = async function safariImport(t) {
  const { check, waitFor, inTime, sleep, tabs, bookmarks, history, prefs } = t;
  const { parseBinaryPlist, readSafariBookmarks, readHistory } = importer;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debrowser-safari-test-'));

  try {
    /* -------------------------------------------------------------- */
    // A file Python wrote: every scalar kind, UTF-16 with a surrogate pair,
    // and the bookmarks a person would expect from it.
    {
      const buf = Buffer.from(PYTHON_PLIST, 'base64');
      const root = attempt(() => parseBinaryPlist(buf)).value || {};
      const bar = root.Children?.[0];
      const sync = root.Children?.[2]?.Sync || {};
      const added = root.Children?.[1]?.Children?.[0]?.ReadingList?.DateAdded;
      check('a Bookmarks.plist written by another program reads back as it was written, unicode, dates, reals, data and booleans included',
        root.WebBookmarkFileVersion === 1 && bar?.Title === 'BookmarksBar' &&
          bar.Children[1].Title === 'Café ☕ 日本' &&
          bar.Children[1].Children[0].URIDictionary.title === '日本 - Wikipedia 🎌' &&
          added instanceof Date && added.toISOString() === '2024-05-01T12:00:00.000Z' &&
          sync.Real === 2.5 && sync.On === true && sync.Off === false &&
          Buffer.isBuffer(sync.Data) && sync.Data.equals(Buffer.from([0, 1, 2])),
        JSON.stringify(root).slice(0, 300));

      const file = path.join(tmp, 'python.plist');
      fs.writeFileSync(file, buf);
      const read = readSafariBookmarks({ kind: 'safari', browser: 'Safari', path: file });
      const got = (read.entries || []).map((e) => [e.url, e.title, e.folder]);
      check('Safari\'s bookmarks import with their titles and folders, the bar\'s own name dropped and the Reading List left behind',
        read.ok && JSON.stringify(got) === JSON.stringify([
          ['https://www.apple.com/', 'Apple', ''],
          ['https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC', '日本 - Wikipedia 🎌', 'Café ☕ 日本'],
          ['https://python.example/x', 'Python wrote this', '']]),
        JSON.stringify(read).slice(0, 400));
    }

    /* -------------------------------------------------------------- */
    // A library big enough that references take two bytes, with every
    // shape a real one has: menu folders nested, bookmarklets, a leaf with no
    // title, titles past every length marker.
    const longTitle = 'A title long enough to need its length written after the marker, '.repeat(5);
    const longUnicode = 'Ünïcödé title past fifteen units ✓ 🎉'.repeat(3);
    const barLeaves = Array.from({ length: 40 }, (_, i) => leaf(`https://bar${i}.example/page?i=${i}`, `Bar ${i}`));
    const shaped = library([
      { Title: 'History', WebBookmarkType: 'WebBookmarkTypeProxy', WebBookmarkIdentifier: 'History' },
      folder('BookmarksBar', [
        ...barLeaves,
        leaf('javascript:alert(document.cookie)', 'A bookmarklet'),
        leaf('file:///etc/passwd', 'A local file'),
        leaf('data:text/html,<script>alert(1)</script>', 'Data'),
        leaf('ftp://ftp.example/', 'FTP'),
        leaf('https://untitled.example/'),
        { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://odd-title.example/', URIDictionary: { title: 42 } },
        { WebBookmarkType: 'WebBookmarkTypeLeaf', URIDictionary: { title: 'No address' } },
        { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 7 }
      ]),
      folder('BookmarksMenu', [
        leaf('https://menu.example/', 'In the menu'),
        folder('Work', [
          leaf('https://work.example/', longTitle),
          folder('Deeper', [leaf('HTTP://SHOUTING.EXAMPLE/', longUnicode)])
        ])
      ]),
      folder('com.apple.ReadingList', [leaf('https://reading.example/', 'Read later')]),
      { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://top.example/', URIDictionary: { title: 'Top' },
        Sync: { Key: 'x', ServerID: 'y', Ints: [0, 255, 256, 65535, 65536, 2 ** 32 + 5], Float: new Real(1.5, true),
          Whole: new Real(3), Neg: -2.25, When: new Date(Date.UTC(2023, 0, 2, 3, 4, 5)), Blob: Buffer.alloc(300, 7), Yes: true, No: false, Nothing: null } }
    ]);
    const shapedFile = path.join(tmp, 'shaped.plist');
    const shapedBuf = writePlist(shaped);
    fs.writeFileSync(shapedFile, shapedBuf);
    {
      const refSize = shapedBuf[shapedBuf.length - 25];
      const root = attempt(() => parseBinaryPlist(shapedBuf));
      const sync = root.value?.Children?.[4]?.Sync || {};
      const deeper = root.value?.Children?.[2]?.Children?.[1]?.Children?.[1]?.Children?.[0];
      check('a library of hundreds of objects reads with two-byte references, long and UTF-16 strings, and integers of every width',
        refSize === 2 && deeper?.URIDictionary?.title === longUnicode &&
          root.value.Children[2].Children[1].Children[0].URIDictionary.title === longTitle &&
          JSON.stringify(sync.Ints) === JSON.stringify([0, 255, 256, 65535, 65536, 2 ** 32 + 5]) &&
          sync.Float === 1.5 && sync.Whole === 3 && sync.Neg === -2.25 &&
          sync.When instanceof Date && sync.When.getTime() === Date.UTC(2023, 0, 2, 3, 4, 5) &&
          sync.Blob?.length === 300 && sync.Yes === true && sync.No === false && sync.Nothing === null,
        `ref size ${refSize}, ${root.threw || JSON.stringify(sync).slice(0, 300)}`);

      const read = readSafariBookmarks({ kind: 'safari', browser: 'Safari', path: shapedFile });
      const urls = (read.entries || []).map((e) => e.url);
      const by = Object.fromEntries((read.entries || []).map((e) => [e.url, e]));
      check('only web addresses are imported: bookmarklets, files, data and ftp addresses are left out, and so are leaves with no address',
        read.ok && urls.length === 40 + 6 &&
          !urls.some((u) => /^(javascript|file|data|ftp):/i.test(u)) && !urls.includes('https://reading.example/'),
        JSON.stringify(urls));
      check('a bookmark with no title, or a title that is not text, imports untitled, and each keeps the folder it is in',
        by['https://untitled.example/']?.title === '' && by['https://odd-title.example/']?.title === '' &&
          by['https://bar7.example/page?i=7']?.title === 'Bar 7' && by['https://bar7.example/page?i=7']?.folder === '' &&
          by['https://menu.example/']?.folder === '' && by['https://work.example/']?.folder === 'Work' &&
          by['https://work.example/']?.title === longTitle && by['HTTP://SHOUTING.EXAMPLE/']?.folder === 'Deeper' &&
          by['https://top.example/']?.title === 'Top',
        JSON.stringify(read.entries?.slice(40)));
    }

    // Big enough for four-byte references and offsets.
    {
      const many = library([folder('BookmarksBar', Array.from({ length: 7000 }, (_, i) => leaf(`https://many.example/${i}`, `Many ${i}`)))]);
      const buf = writePlist(many);
      const file = path.join(tmp, 'many.plist');
      fs.writeFileSync(file, buf);
      const started = Date.now();
      const read = readSafariBookmarks({ kind: 'safari', browser: 'Safari', path: file });
      check('a library of thousands of bookmarks, with four-byte references, imports whole and quickly',
        buf[buf.length - 25] === 4 && read.ok && read.entries.length === 7000 && read.entries[6999].title === 'Many 6999' &&
          Date.now() - started < 3000,
        `ref size ${buf[buf.length - 25]}, ${read.ok ? read.entries.length : read.reason} in ${Date.now() - started} ms`);
    }

    /* -------------------------------------------------------------- */
    // Files that are not what they say.
    {
      const reasons = [];
      const notPlists = {
        'empty': Buffer.alloc(0),
        'short': Buffer.from('bplist00'),
        'XML': Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict><key>Children</key><array/></dict></plist>'),
        'another version': Buffer.concat([Buffer.from('bplist15'), shapedBuf.subarray(8)]),
        'JSON': Buffer.from(JSON.stringify({ roots: {} }).padEnd(100, ' '))
      };
      for (const [name, buf] of Object.entries(notPlists)) {
        const file = path.join(tmp, `not-${name.replace(/\W/g, '')}.plist`);
        fs.writeFileSync(file, buf);
        const read = readSafariBookmarks({ kind: 'safari', browser: 'Safari', path: file });
        if (read.ok || !/^could not read Safari’s bookmarks|^could not read Safari's bookmarks/.test(read.reason)) reasons.push(`${name}: ${JSON.stringify(read)}`);
      }
      const missing = readSafariBookmarks({ kind: 'safari', browser: 'Safari', path: path.join(tmp, 'nowhere', 'Bookmarks.plist') });
      check('a file that is not a binary property list, or is not there, is refused with a reason rather than imported as nothing',
        reasons.length === 0 && !missing.ok && /could not read/.test(missing.reason),
        reasons.join('; ') || missing.reason);
    }

    // Cut short at every length: each is refused or read, none hangs.
    {
      const whole = Buffer.from(PYTHON_PLIST, 'base64');
      const cuts = Array.from({ length: whole.length }, (_, n) => whole.subarray(0, n));
      const res = await parseApart(cuts, 15_000);
      const accepted = (res.results || []).map((r, n) => (r.threw ? null : `${n}: ${r.value}`)).filter(Boolean);
      check('a Bookmarks.plist cut short anywhere is refused, every time, without hanging',
        !!res.results && accepted.length === 0, res.failed || `accepted: ${accepted.slice(0, 6).join(', ')}`);
    }

    // Lying about its own shape.
    {
      const arrayOfSelf = assemble([Buffer.from([0xa1, 0x00])]);
      const dictOfSelf = assemble([Buffer.from([0xd1, 0x01, 0x00]), Buffer.concat([head(5, 1), Buffer.from('k')])]);
      const roundabout = assemble([Buffer.from([0xa1, 0x01]), Buffer.from([0xa1, 0x02]), Buffer.from([0xa1, 0x00])]);
      const topPastCount = assemble([Buffer.from([0x09])], { top: 5 });
      const refPastCount = assemble([Buffer.from([0xa1, 0x09])]);
      const hugeCount = assemble([Buffer.from([0x09])], { count: 2n ** 62n });
      const countPastTable = assemble([Buffer.from([0x09])], { count: 1_999_999 });
      const tablePastEnd = assemble([Buffer.from([0x09])], { tableAt: 2 ** 40 });
      const arrayPastEnd = assemble([Buffer.from([0xaf, 0x12, 0x7f, 0xff, 0xff, 0xff])]);
      const named = { arrayOfSelf, dictOfSelf, roundabout, topPastCount, refPastCount, hugeCount, countPastTable, tablePastEnd, arrayPastEnd };
      const res = await parseApart(Object.values(named), 10_000);
      const wrong = Object.keys(named).filter((_, i) => !res.results?.[i]?.threw)
        .map((name) => `${name}: ${JSON.stringify(res.results?.[Object.keys(named).indexOf(name)])}`);
      check('a property list that contains itself, or names more objects or places than it has, is refused straight away',
        !!res.results && wrong.length === 0 && res.ms < 5000, res.failed || wrong.join('; ') || `${res.ms} ms`);
    }

    // Pointing past its own end. The header promises a damaged file throws
    // rather than reading past its end; a string or object that runs off the
    // end is not to come back as a shorter string or as nothing at all.
    {
      const stringPastEnd = assemble([Buffer.concat([Buffer.from([0x5f, 0x11, 0x10, 0x00]), Buffer.from('only a little')])]);
      const unicodePastEnd = assemble([Buffer.concat([Buffer.from([0x6f, 0x11, 0x10, 0x00]), Buffer.from('ab', 'utf16le').swap16()])]);
      const dataPastEnd = assemble([Buffer.concat([Buffer.from([0x4f, 0x11, 0x10, 0x00]), Buffer.from('xyz')])]);
      const objectPastEnd = assemble([Buffer.from([0x09])], { offsets: [1_000_000], offsetSize: 4 });
      const named = { stringPastEnd, unicodePastEnd, dataPastEnd, objectPastEnd };
      const res = await parseApart(Object.values(named), 10_000);
      const wrong = Object.keys(named).map((name, i) => [name, res.results?.[i]]).filter(([, r]) => !r?.threw)
        .map(([name, r]) => `${name} read as ${JSON.stringify(r)}`);
      const file = path.join(tmp, 'past-end.plist');
      fs.writeFileSync(file, objectPastEnd);
      const read = readSafariBookmarks({ kind: 'safari', browser: 'Safari', path: file });
      check('a property list whose objects run past the end of the file is refused, not imported as nothing',
        !!res.results && wrong.length === 0 && !read.ok,
        `${res.failed || wrong.join('; ')}; import gave ${JSON.stringify(read)}`);
    }

    // Folders that share their children, over and over: forty levels of an
    // array holding the next one twice is a few hundred bytes on disk and a
    // trillion folders read naively.
    {
      const levels = 40;
      const objects = Array.from({ length: levels }, (_, i) => (i === levels - 1 ? Buffer.from([0xa0]) : Buffer.from([0xa2, i + 1, i + 1])));
      const res = await parseApart([assemble(objects)], 8000);
      check('a property list whose folders share their children over and over is refused in moments, not read for ever',
        !!res.results && !!res.results[0].threw, res.failed || JSON.stringify(res.results));
    }

    // Nesting deeper than any library: refused, or read, but the browser stays up.
    {
      const depth = 100_000;
      const objects = Array.from({ length: depth }, (_, i) => (i === depth - 1 ? Buffer.from([0xa0])
        : Buffer.concat([Buffer.from([0xa1]), uintBytes(i + 1, 4)])));
      const file = path.join(tmp, 'deep.plist');
      fs.writeFileSync(file, assemble(objects, { refSize: 4 }));
      const read = attempt(() => readSafariBookmarks({ kind: 'safari', browser: 'Safari', path: file }));

      let node = leaf('https://bottom.example/', 'At the bottom');
      for (let i = 500; i >= 1; i--) node = folder(`Level ${i}`, [node]);
      const deepish = path.join(tmp, 'deepish.plist');
      fs.writeFileSync(deepish, writePlist(library([node])));
      const readable = readSafariBookmarks({ kind: 'safari', browser: 'Safari', path: deepish });
      check('folders nested a hundred thousand deep are refused cleanly, and five hundred deep still import',
        !read.threw && read.value.ok === false && /could not read/.test(read.value.reason) &&
          readable.ok && readable.entries.length === 1 && readable.entries[0].folder === 'Level 500',
        `${JSON.stringify(read)}; ${JSON.stringify(readable).slice(0, 200)}`);
    }

    // A key the file chose. "__proto__" is an ordinary key in a property
    // list; read into a plain object, it rewrites that object's prototype, so
    // a dictionary with nothing of its own reads as a bookmark it never was.
    {
      const planted = new Map([['__proto__', { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://planted.example/' }]]);
      const buf = writePlist(library([folder('BookmarksBar', [planted, leaf('https://real.example/', 'Real')])]));
      const file = path.join(tmp, 'proto.plist');
      fs.writeFileSync(file, buf);
      const parsed = attempt(() => parseBinaryPlist(buf)).value;
      const dict = parsed?.Children?.[0]?.Children?.[0];
      const read = readSafariBookmarks({ kind: 'safari', browser: 'Safari', path: file });
      check('a dictionary key named __proto__ is read as an ordinary key, and conjures no bookmark',
        !!dict && Object.prototype.hasOwnProperty.call(dict, '__proto__') && Object.getPrototypeOf(dict) === Object.prototype &&
          read.ok && JSON.stringify(read.entries.map((e) => e.url)) === JSON.stringify(['https://real.example/']),
        `own keys ${JSON.stringify(dict && Object.keys(dict))}, prototype ${dict && Object.getPrototypeOf(dict) === Object.prototype ? 'Object' : 'replaced'}, imported ${JSON.stringify(read.entries?.map((e) => e.url))}`);
    }

    /* -------------------------------------------------------------- */
    // History.db, as Safari keeps it: an item per address, a row per visit,
    // times in seconds since 2001.
    const { DatabaseSync } = require('node:sqlite');
    const now = Date.now();
    const safariDir = path.join(tmp, 'Library', 'Safari');
    fs.mkdirSync(safariDir, { recursive: true });
    const plistPath = path.join(safariDir, 'Bookmarks.plist');
    fs.writeFileSync(plistPath, shapedBuf);
    const dbPath = path.join(safariDir, 'History.db');
    {
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE history_items (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE,
                 domain_expansion TEXT NULL, visit_count INTEGER NOT NULL, daily_visit_counts BLOB);
               CREATE TABLE history_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, history_item INTEGER NOT NULL,
                 visit_time REAL NOT NULL, title TEXT NULL, load_successful BOOLEAN NOT NULL DEFAULT 1,
                 redirect_source INTEGER NULL, redirect_destination INTEGER NULL)`);
      const item = db.prepare('INSERT INTO history_items (id, url, visit_count) VALUES (?, ?, ?)');
      const visit = db.prepare('INSERT INTO history_visits (history_item, visit_time, title, load_successful) VALUES (?, ?, ?, ?)');
      const H = 3600_000;
      item.run(1, 'https://news.safari-import.test/', 12);
      visit.run(1, toSafari(now - 72 * H), 'Old news', 1);
      visit.run(1, toSafari(now - 1 * H), 'News today', 1);
      visit.run(1, toSafari(now - 48 * H), 'Middle news', 1);
      item.run(2, 'https://docs.safari-import.test/a?b=1#c', 1);
      visit.run(2, toSafari(now - 2 * H) + 0.375, 'Docs ☕ 日本', 1);
      item.run(3, 'file:///etc/passwd', 5);
      visit.run(3, toSafari(now - 0.1 * H), 'Local', 1);
      item.run(4, 'javascript:alert(1)', 2);
      visit.run(4, toSafari(now - 0.2 * H), 'Script', 1);
      item.run(5, 'https://future.safari-import.test/', 1);
      visit.run(5, toSafari(now + 30 * 24 * H), 'From the future', 1);
      item.run(6, 'https://never.safari-import.test/', 3);
      item.run(7, 'https://zero.safari-import.test/', 0);
      visit.run(7, toSafari(now - 5 * H), null, 1);
      item.run(8, 'https://failed.safari-import.test/', 4);
      visit.run(8, toSafari(now - 24 * H), 'The page it was', 1);
      visit.run(8, toSafari(now - 0.5 * H), null, 0);
      db.close();
    }
    const profile = { browser: 'Safari', kind: 'safari', path: plistPath };
    const expectedPages = ['https://failed.safari-import.test/', 'https://news.safari-import.test/',
      'https://docs.safari-import.test/a?b=1#c', 'https://zero.safari-import.test/'];
    {
      const before = fs.statSync(dbPath);
      const read = readHistory(profile);
      const by = Object.fromEntries((read.entries || []).map((e) => [e.url, e]));
      const news = by['https://news.safari-import.test/'];
      const docs = by['https://docs.safari-import.test/a?b=1#c'];
      const after = fs.statSync(dbPath);
      check('Safari\'s history imports newest first, with each page\'s latest title, its visit count and the time of its last visit',
        read.ok && JSON.stringify(read.entries.map((e) => e.url)) === JSON.stringify(expectedPages) &&
          news?.title === 'News today' && news.visits === 12 && Math.abs(news.visitedAt - (now - 3600_000)) < 2 &&
          docs?.title === 'Docs ☕ 日本' && Math.abs(docs.visitedAt - (now - 7200_000 + 375)) < 2 &&
          by['https://zero.safari-import.test/']?.visits === 1 && by['https://zero.safari-import.test/']?.title === '' &&
          after.mtimeMs === before.mtimeMs && after.size === before.size,
        JSON.stringify(read).slice(0, 600));
      check('history leaves out files, scripts, pages never visited and visits dated in the future',
        read.ok && !['file:///etc/passwd', 'javascript:alert(1)', 'https://future.safari-import.test/', 'https://never.safari-import.test/']
          .some((u) => by[u]),
        JSON.stringify(Object.keys(by)));
      // A failed load is a visit Safari records without a title. The page
      // was still called what it was called the time before.
      check('a page whose last visit failed to load keeps the title it was last seen with',
        by['https://failed.safari-import.test/']?.title === 'The page it was',
        JSON.stringify(by['https://failed.safari-import.test/']));
    }

    // Safari running: its history open, the newest visits still in the log
    // beside it rather than in the database.
    {
      const dir = path.join(tmp, 'running');
      fs.mkdirSync(dir);
      const live = new DatabaseSync(path.join(dir, 'History.db'));
      try {
        live.exec(`PRAGMA journal_mode=WAL;
          CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, visit_count INTEGER NOT NULL);
          CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER NOT NULL, visit_time REAL NOT NULL, title TEXT)`);
        live.prepare('INSERT INTO history_items VALUES (1, ?, 2)').run('https://wal.safari-import.test/');
        live.prepare('INSERT INTO history_visits VALUES (1, 1, ?, ?)').run(toSafari(now - 60_000), 'Just now');
        const walBefore = fs.statSync(path.join(dir, 'History.db-wal')).size;
        const read = readHistory({ browser: 'Safari', kind: 'safari', path: path.join(dir, 'Bookmarks.plist') });
        check('history is read while Safari has it open, including visits not yet written into the database itself',
          walBefore > 0 && read.ok && read.entries.length === 1 && read.entries[0].title === 'Just now',
          `log ${walBefore} bytes, ${JSON.stringify(read)}`);
      } finally {
        live.close();
      }
    }

    {
      const none = readHistory({ browser: 'Safari', kind: 'safari', path: path.join(tmp, 'Bookmarks.plist') });
      const junkDir = path.join(tmp, 'junk');
      fs.mkdirSync(junkDir);
      fs.writeFileSync(path.join(junkDir, 'History.db'), Buffer.alloc(8192, 0x41));
      const junk = readHistory({ browser: 'Safari', kind: 'safari', path: path.join(junkDir, 'Bookmarks.plist') });
      const emptyDir = path.join(tmp, 'emptydb');
      fs.mkdirSync(emptyDir);
      new DatabaseSync(path.join(emptyDir, 'History.db')).close();
      const empty = readHistory({ browser: 'Safari', kind: 'safari', path: path.join(emptyDir, 'Bookmarks.plist') });
      check('no History.db, one that is not a database, or one without Safari\'s tables each say why nothing came over',
        !none.ok && /no history/.test(none.reason) && !junk.ok && /could not read Safari/.test(junk.reason) &&
          !empty.ok && /could not read Safari/.test(empty.reason),
        JSON.stringify([none, junk, empty]));
    }

    // macOS refusing: an app without Full Disk Access is told how to get it.
    {
      const locked = /Full Disk Access/;
      const bm = ['EPERM', 'EACCES'].map((code) => refusing('readFileSync', plistPath, code, () => readProfile(profile)));
      const hist = ['EPERM', 'EACCES'].map((code) => refusing('copyFileSync', dbPath, code, () => readHistory(profile)));
      const other = refusing('readFileSync', plistPath, 'EIO', () => readProfile(profile));
      check('when macOS keeps Safari\'s files private, the import says to allow Full Disk Access or export from Safari',
        [...bm, ...hist].every((r) => !r.ok && locked.test(r.reason) && /Export Browsing Data/.test(r.reason)) &&
          !other.ok && !locked.test(other.reason),
        JSON.stringify([...bm, ...hist, other]).slice(0, 500));
    }

    /* -------------------------------------------------------------- */
    // Into the browser's own bookmarks: twice is once, and so is twice
    // either side of a restart.
    {
      const dir = path.join(tmp, 'profile');
      fs.mkdirSync(dir);
      const read = readProfile(profile);
      const store = new Bookmarks(() => {}, dir);
      const first = store.merge(read.entries);
      const second = store.merge(read.entries);
      const restarted = new Bookmarks(() => {}, dir);
      const third = restarted.merge(readProfile(profile).entries);
      const work = restarted.items.find((b) => b.url === 'https://work.example/');
      check('Safari\'s bookmarks merge in once: importing again, even after a restart, adds nothing',
        read.ok && first.added === 46 && second.added === 0 && second.skipped === 46 && third.added === 0 &&
          restarted.items.length === 46 && work?.folder === 'Work' && work.title === longTitle.trim(),
        JSON.stringify({ first, second, third, kept: restarted.items.length, work }));
    }

    /* -------------------------------------------------------------- */
    // The real flow, from Settings.
    const settings = tabs.create({ url: pages.SETTINGS_URL, activate: true, realise: true });
    const js = (code) => inTime(settings.wc.executeJavaScript(code), 5000, null);
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    // os.homedir() reads HOME, but USERPROFILE on Windows: both are pointed at the stand-in.
    const realHome = process.env.HOME;
    const realProfile = process.env.USERPROFILE;
    const savedBefore = new Set(bookmarks.all().map((b) => b.url));
    const pagesBefore = new Set(history.all().map((e) => e.url));
    const historyWas = prefs.get('saveHistory');
    try {
      await waitFor(async () => settings.isLive && !settings.loading &&
        await js(`[...document.querySelectorAll('#bookmark-actions button')].some((b) => b.textContent === 'Find browsers')`),
      { timeoutMs: 10_000 });

      // A page cannot name a file of its own choosing: only what findProfiles lists.
      const named = await js(`window.debrowser.request('import-from-profile', { path: ${JSON.stringify(plistPath)}, withHistory: true })`);
      check('Settings cannot import from a Safari file this machine does not list as Safari\'s',
        named && named.ok === false && /no longer there/.test(named.reason || '') && !bookmarks.items.some((b) => b.url === 'https://work.example/'),
        JSON.stringify(named));

      /** "Find browsers", then the Safari row's Import; what the row and the page said. */
      const importFromPage = async () => {
        await js(`document.getElementById('bookmark-state').textContent = '';
          [...document.querySelectorAll('#bookmark-actions button')].find((b) => b.textContent === 'Find browsers').click()`);
        const listed = await waitFor(() => js(`[...document.querySelectorAll('#bookmark-list .row-label')].some((l) => l.textContent === 'Safari')`),
          { timeoutMs: 4000 });
        const hint = await js(`[...document.querySelectorAll('#bookmark-list .row')].find((r) => r.querySelector('.row-label')?.textContent === 'Safari')?.querySelector('.row-hint')?.textContent`);
        await js(`[...document.querySelectorAll('#bookmark-list .row')].find((r) => r.querySelector('.row-label')?.textContent === 'Safari')?.querySelector('button')?.click()`);
        await waitFor(async () => !/^Found|^$/.test((await js(`document.getElementById('bookmark-state').textContent`)) || ''), { timeoutMs: 6000 });
        return { listed, hint, state: await js(`document.getElementById('bookmark-state').textContent`) };
      };

      Object.defineProperty(process, 'platform', { ...realPlatform, value: 'darwin' });
      process.env.HOME = tmp;
      process.env.USERPROFILE = tmp;
      let listedBare = null;
      let first = null;
      let again = null;
      let locked = null;
      let withHistory = null;
      try {
        // Safari's folder with nothing in it yet is still listed: macOS hides
        // the files inside from an app it has not let in, not the folder.
        fs.renameSync(plistPath, `${plistPath}.away`);
        listedBare = findProfiles().filter((p) => p.kind === 'safari');
        fs.renameSync(`${plistPath}.away`, plistPath);

        first = await importFromPage();
        again = await importFromPage();
        locked = await refusing('readFileSync', plistPath, 'EPERM', importFromPage);
        if (historyWas === false) prefs.set('saveHistory', true);
        withHistory = await js(`window.debrowser.request('import-from-profile', { path: ${JSON.stringify(plistPath)}, withHistory: true })`);
      } finally {
        Object.defineProperty(process, 'platform', realPlatform);
        if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
        if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
        if (historyWas === false) prefs.set('saveHistory', false);
      }

      check('on a Mac, Safari is listed whenever its folder is there, even before macOS lets its files be read',
        listedBare.length === 1 && listedBare[0].browser === 'Safari' && listedBare[0].path === plistPath,
        JSON.stringify(listedBare));
      const saved = bookmarks.items.filter((b) => b.url.includes('.example/') && !savedBefore.has(b.url));
      check('Settings lists Safari as "Safari, on this Mac" and its Import brings the bookmarks in, folders kept',
        first.listed && first.hint === 'Safari, on this Mac' && /^Imported 46 from Safari/.test(first.state || '') &&
          saved.length >= 46 && saved.find((b) => b.url === 'https://work.example/')?.folder === 'Work',
        JSON.stringify(first));
      check('importing Safari a second time from Settings adds nothing and says they were already saved',
        again.listed && /^Imported 0 from Safari, skipped 46 already saved/.test(again.state || ''),
        JSON.stringify(again));
      check('Settings shows the Full Disk Access advice when macOS will not let Safari\'s bookmarks be read',
        locked.listed && /Full Disk Access/.test(locked.state || ''), JSON.stringify(locked));
      const brought = history.all().filter((e) => e.url.includes('safari-import.test') && !pagesBefore.has(e.url));
      check('the welcome tour\'s import brings Safari\'s history over with the bookmarks',
        withHistory?.ok === true && withHistory.pages === expectedPages.length && brought.length === expectedPages.length &&
          brought.find((e) => e.url === 'https://news.safari-import.test/')?.visits === 12,
        `${JSON.stringify(withHistory)}, ${brought.length} page(s) in history`);
    } finally {
      for (const b of bookmarks.items.slice()) if (!savedBefore.has(b.url)) bookmarks.remove(b.url);
      for (const e of history.all()) if (!pagesBefore.has(e.url) && e.url.includes('safari-import.test')) history.remove(e.id);
      tabs.close(settings.id);
      await sleep(100);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};
