'use strict';

/* global self, Worker, SharedWorker, Blob -- this page starts workers; `self` is what exists in both */

/**
 * The private window's self-check: every surface the fingerprint layer claims
 * to normalise, read the way a site reads it, from the page and from the two
 * kinds of worker a page can start here, and compared with what it should
 * say. Nothing leaves the page.
 *
 * What it should say comes from the main process (`fingerprint-expected`), or,
 * for the hidden run at startup, from the fragment. The result is left on
 * `window.__audit` for that run to read.
 */

const api = window.debrowser;

/** Read inside a page or a worker. Kept self-contained: it is serialised. */
async function readSurfaces() {
  const d = self.navigator.userAgentData || null;
  const hi = d ? await d.getHighEntropyValues(['fullVersionList']).catch(() => null) : null;
  const out = {
    userAgent: navigator.userAgent,
    brands: d ? d.brands.map((b) => `${b.brand}/${b.version}`) : [],
    fullVersions: hi ? hi.fullVersionList.map((b) => `${b.brand}/${b.version}`) : [],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: new Date(2026, 0, 1).getTimezoneOffset(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    languages: [...(navigator.languages || [])].join(','),
    cores: navigator.hardwareConcurrency,
    gpu: 'gpu' in navigator
  };
  if (out.gpu) {
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    out.adapter = adapter ? (adapter.info && (adapter.info.vendor || adapter.info.description)) || 'an adapter' : null;
  }
  return out;
}

function inDedicatedWorker() {
  const src = `(${readSurfaces})().then((r) => postMessage(r));`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  return withTimeout(new Promise((resolve) => { w.onmessage = (e) => resolve(e.data); }));
}

function inSharedWorker() {
  const src = `onconnect = (e) => { const port = e.ports[0]; (${readSurfaces})().then((r) => port.postMessage(r)); };`;
  const w = new SharedWorker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  return withTimeout(new Promise((resolve) => { w.port.onmessage = (e) => resolve(e.data); }));
}

const withTimeout = (p, ms = 4000) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

function pageOnly() {
  const canvas = document.createElement('canvas');
  return {
    screen: `${window.screen.width}×${window.screen.height}`,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    webgl: Boolean(canvas.getContext('webgl') || canvas.getContext('webgl2'))
  };
}

/** Each check: a name, what it should be, what was read, whether they agree. */
function compare(expected, surfaces, page) {
  const checks = [];
  const add = (surface, name, want, got) =>
    checks.push({ surface, name, want: String(want), got: got === undefined ? 'unreadable' : String(got), ok: want === got });
  for (const [surface, r] of Object.entries(surfaces)) {
    if (!r) { checks.push({ surface, name: 'answered', want: 'yes', got: 'no answer', ok: false }); continue; }
    add(surface, 'User agent', expected.userAgent, r.userAgent);
    add(surface, 'Engine brand matches the user agent', true,
      r.brands.some((b) => b === `Chromium/${expected.major}`) && !r.brands.some((b) => /Electron|Debrowser/i.test(b)));
    add(surface, 'Time zone', expected.timezone, r.timezone);
    add(surface, 'UTC offset', 0, r.offset);
    add(surface, 'Locale', expected.locale, r.locale);
    add(surface, 'Languages', surface === 'shared worker' ? expected.sharedWorkerLanguages : expected.languages, r.languages);
    add(surface, 'CPU cores', expected.cores, r.cores);
    add(surface, 'Graphics adapter (WebGPU)', 'none', r.adapter ? r.adapter : 'none');
  }
  add('page', 'Screen equals the page', page.viewport, page.screen);
  add('page', 'WebGL', false, page.webgl);
  return checks;
}

function render(checks) {
  const bad = checks.filter((c) => !c.ok);
  document.getElementById('status').dataset.state = bad.length ? 'failed' : 'ready';
  document.getElementById('headline').textContent = bad.length
    ? `${bad.length} of ${checks.length} checks show something they should not`
    : `All ${checks.length} checks agree`;
  const table = document.getElementById('results');
  table.textContent = '';
  // Problems first; a list of green ticks hiding one red one is how a
  // self-check gets misread.
  for (const c of [...bad, ...checks.filter((x) => x.ok)]) {
    const tr = table.insertRow();
    const th = document.createElement('th');
    th.textContent = `${c.name} - ${c.surface}`;
    tr.appendChild(th);
    const td = tr.insertCell();
    td.className = c.ok ? 'yes' : 'part';
    td.textContent = c.ok ? c.got : `${c.got} (should be ${c.want})`;
  }
}

async function expectedValues() {
  if (location.hash.length > 1) {
    try { return JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch { /* fall through */ }
  }
  return api ? api.request('fingerprint-expected') : null;
}

(async () => {
  const expected = await expectedValues();
  if (!expected) {
    document.getElementById('headline').textContent = 'This check only runs in a private window';
    window.__audit = { error: 'not a private window' };
    return;
  }
  const surfaces = {
    page: await readSurfaces(),
    'dedicated worker': await inDedicatedWorker().catch(() => null),
    'shared worker': await inSharedWorker().catch(() => null)
  };
  const checks = compare(expected, surfaces, pageOnly());
  render(checks);
  window.__audit = { checks, problems: checks.filter((c) => !c.ok) };
})();

if (api) api.onState((state) => applyThemePrefs(state.prefs));
