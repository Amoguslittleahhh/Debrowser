'use strict';

/**
 * What changed in this version, from the CHANGELOG.md packed with the app.
 *
 * After an update the browser opens these notes once, and the page reads the
 * same notes the release page shows - one source, so the two cannot disagree.
 * While a newer version is waiting to be installed, the page says so and
 * points to Settings → Updates.
 */

const fs = require('fs');
const path = require('path');

/**
 * One version's notes: its sections, and each item's bold headline and text.
 * Falls back to the newest section when the version has none (a build from
 * source, before its notes are written up).
 *
 * @returns {{version: string, sections: Array<{title: string, items: Array<{head: string, text: string}>}>}|null}
 */
function notesFor(markdown, version) {
  const parts = String(markdown).split(/^## /m).slice(1);
  const part = parts.find((p) => p.split('\n')[0].trim() === version) || parts[0];
  if (!part) return null;
  const [heading, ...lines] = part.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('### ')) {
      current = { title: line.slice(4).trim(), items: [] };
      sections.push(current);
      continue;
    }
    const text = line.replace(/^- /, '').trim();
    if (!text) continue;
    if (!current) { current = { title: '', items: [] }; sections.push(current); }
    const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(text);
    if (line.startsWith('- ')) current.items.push(bold ? { head: bold[1], text: bold[2] } : { head: '', text });
    else if (current.items.length) current.items[current.items.length - 1].text += ` ${text}`;
    else current.items.push({ head: '', text });
  }
  return { version: heading.trim(), sections: sections.filter((s) => s.items.length) };
}

/**
 * Every released version's notes, newest first. `Unreleased` is left out: a
 * release renames it to its version, so in a packaged build it is only ever
 * work that hasn't shipped.
 */
function allNotes(markdown) {
  return String(markdown).split(/^## /m).slice(1)
    .map((part) => part.split('\n')[0].trim())
    .filter((heading) => /^\d/.test(heading))
    .map((heading) => notesFor(markdown, heading))
    .filter((notes) => notes && notes.sections.length)
    .map((notes) => ({ ...notes, version: notes.version.split(/\s/)[0] }));
}

function changelog(appPath) {
  try {
    return fs.readFileSync(path.join(appPath, 'CHANGELOG.md'), 'utf8');
  } catch {
    return null;
  }
}

function read(appPath, version) {
  const text = changelog(appPath);
  return text === null ? null : notesFor(text, version);
}

function readAll(appPath) {
  const text = changelog(appPath);
  return text === null ? [] : allNotes(text);
}

/** True when `a` is a later version than `b` (plain x.y.z, as releases are). */
function newer(a, b) {
  const pa = String(a).split(/[.-]/).map(Number);
  const pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

module.exports = { notesFor, allNotes, read, readAll, newer };
