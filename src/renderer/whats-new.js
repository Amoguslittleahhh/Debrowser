'use strict';

/**
 * Release notes: every version, newest first, with its summary and one row
 * per change - the headline and the sentence that says what it fixed or added.
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

function firstSentence(text) {
  const t = String(text).trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return (m ? m[1] : t).replace(/[,:;]$/, '.');
}

/**
 * A change in two parts: its headline, and the first sentence of what it says
 * after that - enough to tell what was fixed or added without the whole
 * paragraph. An item written without a headline gives its first sentence.
 */
function line(item) {
  if (!item.head) return { head: firstSentence(item.text), detail: '' };
  return { head: item.head.trim(), detail: item.text ? firstSentence(item.text) : '' };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The label beside a change, and the colour class it takes. */
function kind(title) {
  const known = { New: 'new', Improved: 'improved', Fixed: 'fixed', Security: 'security',
    'Known issues': 'known', 'In Labs': 'labs', 'Leaving next release': 'leaving', Corrections: 'fixed' };
  return { label: title || 'Changed', cls: known[title] || 'other' };
}

function release(notes, installed) {
  const article = el('article', 'release');
  const top = el('div', 'version');
  top.append(el('h2', '', `v${notes.version}`));
  if (installed) top.append(el('span', 'installed', 'Installed'));
  // The paragraph a version opens with is its summary, set under its number.
  const opens = notes.sections.length > 1 && !notes.sections[0].title;
  const sections = opens ? notes.sections.slice(1) : notes.sections;
  const summary = opens ? notes.sections[0].items.map((i) => [i.head, i.text].filter(Boolean).join(' ')).join(' ') : '';
  // One row per change, its section named beside it, as Zen lists them.
  const list = el('ul', 'changes');
  for (const section of sections) {
    const { label, cls } = kind(section.title);
    section.items.forEach((item, i) => {
      const li = el('li', i === 0 ? 'first' : '');
      const tag = el('span', `kind ${cls}`, label);
      const text = el('span', 'text');
      const { head, detail } = line(item);
      const strong = el('strong');
      strong.append(inline(head));
      text.append(strong);
      if (detail) {
        const more = el('span', 'detail');
        more.append(' ', inline(detail));
        text.append(more);
      }
      li.append(tag, text);
      list.append(li);
    });
  }
  article.append(top);
  if (summary) {
    const p = el('p', 'summary');
    p.append(inline(summary));
    article.append(p);
  }
  article.append(list);
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
