'use strict';

/**
 * This version's notes. Built as DOM nodes, never as HTML: the only markup
 * kept from the changelog is `code`, which becomes a <code> element.
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
      out.append(bit.replace(/\*\*/g, ''));
    }
  });
  return out;
}

async function load() {
  const notes = await api.request('whats-new-notes');
  const root = document.getElementById('notes');
  if (!notes || !notes.sections.length) {
    const p = document.createElement('p');
    p.className = 'lead';
    p.textContent = 'The notes for this version are not in this build.';
    root.replaceChildren(p);
    return;
  }
  document.getElementById('title').textContent =
    /^\d/.test(notes.version) ? `What’s new in ${notes.version}` : 'What’s new';
  root.replaceChildren(...notes.sections.map((section) => {
    const el = document.createElement('section');
    if (section.title) {
      const h = document.createElement('h2');
      h.textContent = section.title;
      el.append(h);
    }
    const list = document.createElement('ul');
    for (const item of section.items) {
      const li = document.createElement('li');
      if (item.head) {
        const head = document.createElement('strong');
        head.append(inline(item.head));
        li.append(head, ' ');
      }
      li.append(inline(item.text));
      list.append(li);
    }
    el.append(list);
    return el;
  }));
}

load();
