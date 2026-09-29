#!/usr/bin/env node
'use strict';

/**
 * The release archive: CHANGELOG.md as a small static site.
 *
 *   node tools/changelog-site.js [outDir]      (default: site/)
 *
 * An index of every released version, newest first, each with its date and a
 * line saying what it was about; a page per version; and an Atom feed. Dates
 * come from the version's git tag, so the workflow checks out with tags.
 * `## Unreleased` is not published - it has not happened yet.
 *
 * The renderer covers what the changelog uses and nothing more: headings,
 * paragraphs, lists (nested by indent), tables, fenced code, and inline code,
 * bold, italics and links. Everything else is escaped as text.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = 'https://github.com/amoguslittleahhh/debrowser';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  return String(text).split(/(`[^`]+`)/).map((bit) => {
    if (/^`[^`]+`$/.test(bit)) return `<code>${esc(bit.slice(1, -1))}</code>`;
    return esc(bit)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|[#./][^)\s]*)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:]|$)/g, '$1<em>$2</em>');
  }).join('');
}

/** Markdown (the changelog's subset) to HTML. */
function render(md) {
  const lines = String(md).replace(/\r/g, '').split('\n');
  const out = [];
  let para = [];
  const lists = [];   // stack of indents
  let item = null;    // text of the open list item
  const flushItem = () => { if (item !== null) { out.push(`${inline(item)}`); item = null; } };
  const closeLists = (indent = -1) => {
    flushItem();
    while (lists.length && lists[lists.length - 1] > indent) { out.push('</li></ul>'); lists.pop(); }
  };
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); closeLists();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\|/.test(line)) {
      flushPara(); closeLists();
      const rows = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r, n) => !(n === 1 && /^[|\s:-]+$/.test(r)));
      out.push('<table>', `<thead><tr>${cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`,
        ...body.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`), '</tbody></table>');
      continue;
    }
    const h = /^(#{2,4}) (.*)$/.exec(line);
    if (h) {
      flushPara(); closeLists();
      const level = h[1].length + 1;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    const li = /^(\s*)[-*] (.*)$/.exec(line);
    if (li) {
      flushPara();
      const indent = li[1].length;
      if (!lists.length || indent > lists[lists.length - 1]) { flushItem(); out.push('<ul><li>'); lists.push(indent); }
      else { closeLists(indent); out.push('</li><li>'); }
      item = li[2];
      continue;
    }
    if (!line.trim()) { flushPara(); if (item !== null) flushItem(); continue; }
    if (lists.length && /^\s/.test(line)) {
      if (item !== null) item += ` ${line.trim()}`; else out.push(`<p>${inline(line.trim())}</p>`);
      continue;
    }
    closeLists();
    para.push(line.trim());
  }
  flushPara(); closeLists();
  return out.join('\n');
}

/** Each released version: its number, title, notes and a one-line summary. */
function versions(md) {
  return String(md).split(/^## /m).slice(1).map((part) => {
    const [heading, ...rest] = part.split('\n');
    const body = rest.join('\n').trim();
    const version = heading.split(/\s/)[0];
    const heads = [...body.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1].replace(/[.,:]$/, ''));
    const first = body.split('\n\n').find((p) => p && !/^[#|`-]/.test(p)) || '';
    const summary = heads.length
      ? heads.slice(0, 3).join(' · ') + (heads.length > 3 ? ` and ${heads.length - 3} more` : '')
      : first.replace(/\s+/g, ' ').split(/(?<=\.)\s/)[0];
    return { version, title: heading.trim(), body, summary };
  }).filter((v) => /^\d+\.\d+\.\d+/.test(v.version));
}

function tagDate(version) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cI', `v${version}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

const CSS = `
:root { --bg: #fbfaf7; --text: #1d1c1a; --dim: #6b6862; --line: #e6e2da; --accent: #2f857b; --code: #f1eee8; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --text: #ecebe8; --dim: #9c9890; --line: #2c2b29; --accent: #5cb8ad; --code: #23221f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: min(760px, 100% - 32px); margin: 0 auto; padding: 48px 0 80px; }
a { color: var(--accent); }
h1 { font-size: 28px; letter-spacing: -0.02em; margin: 0 0 4px; }
h2 { font-size: 20px; margin: 40px 0 8px; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); margin: 32px 0 8px; }
.meta, .summary { color: var(--dim); }
ul { padding-left: 20px; } li { margin: 6px 0; }
code { background: var(--code); padding: 0 4px; border-radius: 4px; font-size: 0.92em; }
pre { background: var(--code); padding: 12px; border-radius: 8px; overflow-x: auto; } pre code { padding: 0; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; font-size: 14px; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
.index { list-style: none; padding: 0; } .index li { border-top: 1px solid var(--line); padding: 14px 0; margin: 0; }
.index a { font-weight: 600; text-decoration: none; }
nav { margin-bottom: 24px; }
`;

const page = (title, body, { root = '', head = '' } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${head}<link rel="stylesheet" href="${root}style.css"></head>
<body><main>${body}</main></body></html>
`;

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');

function build(outDir, md) {
  const list = versions(md).map((v) => ({ ...v, date: tagDate(v.version) }));
  fs.mkdirSync(path.join(outDir, 'v'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'style.css'), CSS.trim() + '\n');

  const feedLink = '<link rel="alternate" type="application/atom+xml" title="Debrowser releases" href="feed.xml">';
  fs.writeFileSync(path.join(outDir, 'index.html'), page('Debrowser releases', `
<h1>Debrowser releases</h1>
<p class="meta">Every version, newest first · <a href="feed.xml">Atom feed</a> · <a href="${REPO}/releases">Downloads</a></p>
<ul class="index">
${list.map((v) => `<li><a href="v/${esc(v.version)}.html">${esc(v.version)}</a> <span class="meta">${fmtDate(v.date)}</span><div class="summary">${inline(v.summary)}</div></li>`).join('\n')}
</ul>`, { head: feedLink }));

  for (const v of list) {
    fs.writeFileSync(path.join(outDir, 'v', `${v.version}.html`), page(`Debrowser ${v.version}`, `
<nav><a href="../index.html">All releases</a></nav>
<h1>Debrowser ${esc(v.title)}</h1>
<p class="meta">${fmtDate(v.date)}${v.date ? ' · ' : ''}<a href="${REPO}/releases/tag/v${esc(v.version)}">Release and downloads</a></p>
${render(v.body)}`, { root: '../' }));
  }

  const updated = list.find((v) => v.date)?.date || new Date(0).toISOString();
  fs.writeFileSync(path.join(outDir, 'feed.xml'), `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Debrowser releases</title>
<id>${REPO}/releases</id>
<link href="${REPO}/releases"/>
<updated>${updated}</updated>
${list.map((v) => `<entry>
<title>Debrowser ${esc(v.version)}</title>
<id>${REPO}/releases/tag/v${esc(v.version)}</id>
<link href="${REPO}/releases/tag/v${esc(v.version)}"/>
<updated>${v.date || updated}</updated>
<summary>${esc(v.summary)}</summary>
<content type="html">${esc(render(v.body))}</content>
</entry>`).join('\n')}
</feed>
`);
  return list;
}

if (require.main === module) {
  const out = process.argv[2] || 'site';
  const list = build(out, fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'));
  console.log(`${list.length} versions written to ${out}/`);
}

module.exports = { render, versions, build };
