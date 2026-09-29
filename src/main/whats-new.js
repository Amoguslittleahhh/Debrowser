'use strict';

/**
 * What changed in this version, from the CHANGELOG.md packed with the app.
 *
 * After an update the browser says so once, in a toast, and the page it opens
 * reads the same notes the release page shows - one source, so the two cannot
 * disagree. Nothing opens a tab by itself.
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

function read(appPath, version) {
  try {
    return notesFor(fs.readFileSync(path.join(appPath, 'CHANGELOG.md'), 'utf8'), version);
  } catch {
    return null;
  }
}

module.exports = { notesFor, read };
