'use strict';

/**
 * Release notes: every version, newest first, one short line per change.
 * Built as DOM nodes, never as HTML: the only markup kept from the changelog
 * is `code`, which becomes a <code> element.
 *
 * The page asks something of you only while a newer version is out and not
 * yet installed; then it points to Settings → Updates. Otherwise it is just
 * the notes.
 */

const api = window.debrowser;

function inline(text) {
  const out = document.createDocumentFragment();
  String(text).split(/(`[^`]+`)/).forEach((bit) => {
    if (/^`[^`]+`$/.test(bit)) {
      const code = document.createElement('code');
      code.textContent = bit.slice(1, -1);
      out.append(code);
    } else if (bit) {
      // The changelog is typed with a spaced hyphen for a dash; set it as one.
      out.append(bit.replace(/\*\*/g, '').replace(/ - /g, ' – '));
    }
  });
  return out;
}

/** An item's headline, or the first sentence of an item written without one. */
function line(item) {
  const text = (item.head || item.text).trim();
  const first = /^(.+?[.!?])(\s|$)/.exec(text);
  return (first ? first[1] : text).replace(/[,:;]$/, '.');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function release(notes, installed) {
  const article = el('article', 'release');
  const side = el('div', 'version');
  side.append(el('h2', '', notes.version));
  if (installed) side.append(el('span', 'installed', 'Installed'));
  const body = el('div', 'changes');
  // The paragraph a version opens with sums it up at length; the lines under
  // it say the same thing shorter, so it is left to the release page.
  const sections = notes.sections.length > 1 && !notes.sections[0].title ? notes.sections.slice(1) : notes.sections;
  for (const section of sections) {
    const block = el('section');
    if (section.title) block.append(el('h3', '', section.title));
    const list = el('ul');
    for (const item of section.items) {
      const li = el('li');
      li.append(inline(line(item)));
      list.append(li);
    }
    block.append(list);
    body.append(block);
  }
  article.append(side, body);
  return article;
}

const WAITING = {
  available: (v) => `Debrowser ${v} is out.`,
  downloading: (v) => `Debrowser ${v} is downloading.`,
  ready: (v) => `Debrowser ${v} is downloaded and ready to install.`
};

async function load() {
  const data = await api.request('whats-new-notes');
  const root = document.getElementById('notes');
  const versions = (data && data.versions) || [];
  if (!versions.length) {
    root.replaceChildren(el('p', 'lead', 'The release notes aren’t in this build.'));
    return;
  }
  document.getElementById('lead').textContent = `You’re on Debrowser ${data.version}.`;

  if (data.update) {
    const say = WAITING[data.update.state] || WAITING.available;
    document.getElementById('update-text').textContent =
      `${say(data.update.version)} You’re still on ${data.version}, so its notes will be here once you update.`;
    document.getElementById('update-go').addEventListener('click', () => api.send('open-settings', { section: 'updates' }));
    document.getElementById('update').hidden = false;
  }

  root.replaceChildren(...versions.map((notes) => release(notes, notes.version === data.version)));
}

load();
