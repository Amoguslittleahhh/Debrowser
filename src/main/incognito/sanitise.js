'use strict';

/**
 * Files leaving a private window lose what they say about you.
 *
 * A photo from a phone carries where it was taken (GPS), when, on what
 * device, often the owner's name - in metadata the page it is uploaded to can
 * read, and that usually survives to wherever the site publishes it. Private
 * windows strip it from every JPEG, PNG and WebP picked for upload before the
 * page is handed the file.
 *
 * Only metadata is removed: the compressed image data is copied byte for byte,
 * so the pixels a site decodes are exactly the ones in the original. Colour
 * profiles are kept - they change how an image looks, not who took it.
 *
 * How the page gets the clean copy: the DevTools protocol's file-chooser
 * interception (Page.setInterceptFileChooserDialog). The browser shows the
 * picker itself, writes cleaned copies into this run's private directory, and
 * hands the page those (DOM.setFileInputFiles). Measured in M0: Electron has
 * no API of its own for this. A file dragged onto a page does not pass through
 * the picker and is not cleaned; the connection page says so.
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* The formats                                                         */
/* ------------------------------------------------------------------ */

/**
 * JPEG: a run of marker segments before the image data. Dropped: APP1 (Exif,
 * with the GPS block, and XMP), APP13 (IPTC and Photoshop), APP3-APP15 other
 * than APP14 (Adobe colour transform, needed to decode some files), and COM
 * comments. Kept: APP0 (JFIF), APP2 (ICC profile), and everything from the
 * start of scan on.
 */
function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const parts = [buf.subarray(0, 2)];
  const removed = [];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;                     // not a marker: not a JPEG we understand
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }            // fill byte
    if (marker === 0xda || marker === 0xd9) break;        // start of scan / end: the rest is image data
    if (marker >= 0xd0 && marker <= 0xd7) { parts.push(buf.subarray(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const segment = buf.subarray(i, i + 2 + len);
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe ||
      (marker >= 0xe3 && marker <= 0xef && marker !== 0xee);
    if (drop) removed.push(jpegName(marker, segment));
    else parts.push(segment);
    i += 2 + len;
  }
  parts.push(buf.subarray(i));
  return { data: Buffer.concat(parts), removed };
}

function jpegName(marker, segment) {
  if (marker === 0xfe) return 'comment';
  if (marker === 0xed) return 'IPTC';
  if (marker === 0xe1) {
    const id = segment.subarray(4, 10).toString('latin1');
    return id.startsWith('Exif') ? 'Exif' : 'XMP';
  }
  return `APP${marker - 0xe0}`;
}

/**
 * PNG: chunks after the signature. Dropped: text (tEXt, zTXt, iTXt - where
 * XMP and "Author" live), eXIf, and tIME. Everything else is copied, CRCs and
 * all, because nothing else is changed.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
function stripPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const parts = [buf.subarray(0, 8)];
  const removed = [];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (end > buf.length) return null;
    if (PNG_DROP.has(type)) removed.push(type);
    else parts.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return { data: Buffer.concat(parts), removed };
}

/**
 * WebP: a RIFF file of chunks. Dropped: EXIF and XMP; the VP8X header's flags
 * for them are cleared and the RIFF size rewritten, since both would
 * otherwise describe chunks that are no longer there.
 */
function stripWebp(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const parts = [];
  const removed = [];
  let vp8x = null;
  let i = 12;
  while (i + 8 <= buf.length) {
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const end = i + 8 + len + (len & 1);                  // chunks are padded to even sizes
    if (i + 8 + len > buf.length) return null;
    const chunk = Buffer.from(buf.subarray(i, Math.min(end, buf.length)));
    if (type === 'EXIF' || type === 'XMP ') removed.push(type.trim());
    else {
      if (type === 'VP8X') vp8x = chunk;
      parts.push(chunk);
    }
    i = end;
  }
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04);                    // the EXIF and XMP flags
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return { data: Buffer.concat([header, body]), removed };
}

/**
 * The file's metadata removed, or null for a format this does not handle -
 * which is then passed on unchanged, and said so.
 */
function stripImage(buf) {
  return stripJpeg(buf) || stripPng(buf) || stripWebp(buf);
}

/* ------------------------------------------------------------------ */
/* The picker                                                          */
/* ------------------------------------------------------------------ */

/**
 * Take over a tab's file picker. Called once the tab's debugger session is
 * up (see fingerprint.shield), and again if that session is replaced.
 *
 * @param {object} tab        - has `wc` and `cdp`
 * @param {string} dir        - where cleaned copies go: this run's private directory
 * @param {(opts) => Promise<string[]>} pick - shows the picker, resolves to paths
 */
async function interceptUploads(tab, dir, pick, log = () => {}) {
  const wc = tab.wc;
  // Page.enable first, and not optional: without it the interception is
  // accepted - `{}`, no error - and does nothing, and the native picker opens
  // and hands the page the original file. Measured. It costs the page
  // instrumentation cdp.js otherwise avoids, which a private tab pays.
  if (!(await tab.cdp.enable('Page'))) return false;
  const ok = await tab.cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
  if (ok === null) return false;
  if (!wc.__sanitiserWired) {
    wc.__sanitiserWired = true;
    wc.debugger.on('message', (_event, method, params) => {
      if (method !== 'Page.fileChooserOpened') return;
      chosen(tab, dir, pick, params, log).catch((err) => log('sanitise', `upload failed: ${err.message}`));
    });
  }
  return true;
}

async function chosen(tab, dir, pick, params, log) {
  const multiple = params.mode === 'selectMultiple';
  const picked = await pick({ multiple });
  if (!picked || !picked.length || !tab.wc || tab.wc.isDestroyed()) {
    // Cancelled: the page is told nothing was chosen, as with the real picker.
    await tab.cdp.send('DOM.setFileInputFiles', { files: [], backendNodeId: params.backendNodeId });
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const file of picked) files.push(cleanCopy(file, dir, log));
  await tab.cdp.send('DOM.setFileInputFiles', { files, backendNodeId: params.backendNodeId });
}

/** A copy of `file` with its image metadata removed, under the same name. */
function cleanCopy(file, dir, log = () => {}) {
  let result = null;
  try {
    result = stripImage(fs.readFileSync(file));
  } catch (err) {
    log('sanitise', `could not read ${path.basename(file)}: ${err.message}`);
    return file;
  }
  if (!result) return file;                               // not an image this knows: unchanged
  // A directory per file, so the page still sees the file's own name.
  const own = fs.mkdtempSync(path.join(dir, 'u-'));
  const out = path.join(own, path.basename(file));
  fs.writeFileSync(out, result.data, { mode: 0o600 });
  if (result.removed.length) log('sanitise', `${path.basename(file)}: removed ${result.removed.join(', ')}`);
  return out;
}

module.exports = { stripJpeg, stripPng, stripWebp, stripImage, interceptUploads, cleanCopy };
