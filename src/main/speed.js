'use strict';

/**
 * The speed benchmark: how long the moments people wait for actually take.
 *
 *   electron . --speed-test [--speed-runs=15]
 *
 * Drives the real browser through its own command dispatcher - the path a key
 * or a click takes - and times each moment from the command to the first
 * contentful paint of what was asked for, read from the page's own
 * performance timeline. Both ends are wall-clock epoch milliseconds, so the
 * time spent in the browser process, in IPC and in building renderers is all
 * inside the number, not only the page's own load.
 *
 * The fixtures are served locally, so network time is close to nothing and
 * what is left is the browser's own overhead - which is the part this project
 * can change. Each site is a fresh `tN.test` name, so a navigation is a new
 * site with a new renderer process, as typing an address usually is.
 */

const fixtureServer = require('./fixture-server');
const pages = require('./pages');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeoutMs = 10_000, stepMs = 5) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (await cond()) return true; } catch { /* not yet */ }
    await sleep(stepMs);
  }
  return false;
}

/**
 * Epoch time of the page's first contentful paint, or of its first frame if
 * it has no content to paint. Resolves once it has happened.
 */
function paintedAt(wc, timeoutMs = 10_000) {
  return Promise.race([
    wc.executeJavaScript(`new Promise((resolve) => {
      const done = (t) => resolve(performance.timeOrigin + t);
      const seen = performance.getEntriesByName('first-contentful-paint')[0];
      if (seen) { done(seen.startTime); return; }
      try {
        new PerformanceObserver((list) => {
          const e = list.getEntriesByName('first-contentful-paint')[0];
          if (e) done(e.startTime);
        }).observe({ type: 'paint', buffered: true });
      } catch {}
      // A page that paints nothing contentful still has a first frame.
      requestAnimationFrame(() => requestAnimationFrame(() =>
        setTimeout(() => done(performance.now()), 3000)));
    })`, true),
    sleep(timeoutMs).then(() => null)
  ]);
}

/** Epoch time of the next frame the page draws. */
function nextFrameAt(wc) {
  return wc.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.timeOrigin + performance.now()))))',
    true);
}

function summarise(samples) {
  const ok = samples.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!ok.length) return { n: 0 };
  const at = (p) => ok[Math.min(ok.length - 1, Math.floor(p * ok.length))];
  return {
    n: ok.length,
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    min: Math.round(ok[0]),
    failed: samples.length - ok.length
  };
}

async function runSpeed({ tabs, runCommand, log = () => {}, runs = 15 }) {
  const fixtures = await fixtureServer.start();
  let site = 1000;
  const fresh = (page) => fixtures.url(page, site++);
  const results = {};
  const record = (name, value) => { (results[name] ||= []).push(value); };

  // Warm-up: the first renderer and the first page pay one-off costs (V8
  // snapshots, font caches) that are startup's, not each navigation's.
  runCommand('new-tab', {});
  await waitFor(() => tabs.activeTab()?.isLive && !tabs.activeTab().loading);
  const warm = tabs.activeTab();
  runCommand('navigate', { url: fresh('article.html') });
  await waitFor(() => tabs.activeTab()?.wc && /article/.test(tabs.activeTab().wc.getURL()) && !tabs.activeTab().loading);
  await sleep(300);

  for (let i = 0; i < runs; i++) {
    // 1. Ctrl+T: the command, to the new tab page drawn.
    {
      const t0 = Date.now();
      runCommand('new-tab', {});
      const tab = tabs.activeTab();
      await waitFor(() => tab.isLive && tab.wc);
      // A spare new tab page (prewarm.js) painted before it was asked for; for
      // that one, the moment is its next frame once it is in the window.
      let at = await paintedAt(tab.wc);
      if (at && at < t0) at = await nextFrameAt(tab.wc);
      record('new tab (Ctrl+T) to painted', at ? at - t0 : NaN);
      await waitFor(() => !tab.loading, 3000);
      await sleep(100);

      // 2. An address typed on that new tab page: Enter, to the site's first
      //    contentful paint. A new site, so a new renderer - which is also what
      //    leaving the new tab page costs here.
      const t1 = Date.now();
      runCommand('navigate', { url: fresh('article.html') });
      await waitFor(() => tab.wc && !tab.wc.isDestroyed() && /article\.html/.test(tab.wc.getURL()), 8000);
      const at2 = await paintedAt(tab.wc);
      record('typed address on new tab page to first paint', at2 ? at2 - t1 : NaN);
      await waitFor(() => !tab.loading, 5000);
      await sleep(100);

      // 3. Another address typed in a tab already on a site: no new tab page
      //    to leave, so this is the floor 2 should be compared with.
      const t2 = Date.now();
      runCommand('navigate', { url: fresh('article.html') });
      const before = tab.wc;
      await waitFor(() => tab.wc && tab.wc.getURL().includes(`t${site - 1}.test`), 8000);
      const at3 = await paintedAt(tab.wc);
      record('typed address on a site to first paint', at3 && tab.wc === before ? at3 - t2 : (at3 ? at3 - t2 : NaN));
      await waitFor(() => !tab.loading, 5000);
      await sleep(100);

      // 4. A link on the same site.
      const t3 = Date.now();
      tab.wc.executeJavaScript('document.getElementById("next").click()').catch(() => {});
      await waitFor(() => /article-2\.html/.test(tab.wc.getURL()), 8000);
      const at4 = await paintedAt(tab.wc);
      record('same-site link to first paint', at4 ? at4 - t3 : NaN);
      await waitFor(() => !tab.loading, 5000);
      await sleep(150);

      // 5. Back: the page before, shown again.
      const t4 = Date.now();
      runCommand('back', {});
      await waitFor(() => /article\.html/.test(tab.wc.getURL()) && !/article-2/.test(tab.wc.getURL()), 8000);
      const at5 = await nextFrameAt(tab.wc).catch(() => null);
      record('back to drawn', at5 ? at5 - t4 : NaN);
      await waitFor(() => !tab.loading, 5000);

      // 6. Switching to a tab that is running: the other one.
      const t5 = Date.now();
      await tabs.activate(warm.id);
      const at6 = await nextFrameAt(warm.wc).catch(() => null);
      record('switch to an open tab to drawn', at6 ? at6 - t5 : NaN);

      // 7. Switching to a tab whose renderer was reclaimed: the one just left,
      //    discarded, then chosen again.
      await sleep(100);
      const discarded = await discardForBench(tab);
      if (discarded) {
        const t6 = Date.now();
        tabs.activate(tab.id);
        await waitFor(() => tab.isLive && tab.wc, 5000);
        const at7 = await paintedAt(tab.wc);
        record('switch to a reclaimed tab to first paint', at7 ? at7 - t6 : NaN);
        await waitFor(() => !tab.loading, 5000);
      }
      tabs.close(tab.id);
      await tabs.activate(warm.id);
      await sleep(150);
    }
  }

  // Links on a site that takes 150 ms to answer, as a real server does: clicked
  // straight away, and clicked after the pointer has rested on them - which is
  // when the browser fetches the page ahead (speculation.js).
  const slow = await slowServer(150);
  // An IP address, not a `.test` name: Chromium does not prefetch hosts that
  // are not globally unique, so a made-up name would measure nothing.
  const linkTab = tabs.create({ url: `http://127.0.0.1:${slow.port}/article.html`, activate: true, realise: true });
  await waitFor(() => linkTab.isLive && !linkTab.loading, 8000);
  // How each click is made: [label, how long the pointer rests on the link
  // first, how long the button is held]. A person holds it for 80-100 ms.
  const CLICKS = [
    ['link, clicked at once (150 ms server)', 0, 0],
    ['link, a person\'s click: button held 90 ms (150 ms server)', 0, 90],
    ['link, pointer rested 150 ms, then clicked (150 ms server)', 150, 90],
    ['link, pointer rested on it first (150 ms server)', 400, 90]
  ];
  for (let i = 0; i < runs; i++) {
    for (const [label, rest, hold] of CLICKS) {
      const hover = rest > 0;
      const tag = `k${CLICKS.findIndex((c) => c[0] === label)}r${i}`;
      runCommand('navigate', { url: `http://127.0.0.1:${slow.port}/article.html?${tag}` });
      await waitFor(() => linkTab.wc && linkTab.wc.getURL().endsWith(`?${tag}`) && !linkTab.loading, 8000);
      await sleep(150);
      const at = await linkTab.wc.executeJavaScript(
        '(() => { const r = document.getElementById("next").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
      if (hover) {
        linkTab.wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
        await sleep(rest);          // a pointer resting on the link, then the click
        if (process.env.SPEED_DEBUG) {
          const rules = await linkTab.wc.executeJavaScript('document.querySelectorAll("script[type=speculationrules]").length').catch(() => '?');
          console.log(`  [debug] rules after rest: ${rules}`);
        }
      }
      // Timed from the button coming up, which is when a click navigates.
      linkTab.wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
      linkTab.wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      if (hold) await sleep(hold);
      const t0 = Date.now();
      linkTab.wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await waitFor(() => /article-2\.html/.test(linkTab.wc.getURL()), 8000);
      const painted = await paintedAt(linkTab.wc);
      record(label, painted ? painted - t0 : NaN);
      if (hover && process.env.SPEED_DEBUG) {
        const how = await linkTab.wc.executeJavaScript('performance.getEntriesByType("navigation")[0].deliveryType').catch(() => '?');
        console.log(`  [debug] rested link delivered as "${how}"`);
      }
      await waitFor(() => !linkTab.loading, 5000);
    }
  }
  tabs.close(linkTab.id);
  slow.server.close();
  if (typeof slow.server.closeAllConnections === 'function') slow.server.closeAllConnections();

  await fixtures.close();
  const report = {};
  for (const [name, samples] of Object.entries(results)) report[name] = summarise(samples);
  return report;
}

/** A server for the article fixtures that takes `delayMs` to answer each page. */
function slowServer(delayMs) {
  const http = require('http');
  const fs = require('fs');
  const path = require('path');
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = path.basename(new URL(req.url, 'http://x').pathname);
      const file = path.join(fixtureServer.PAGES, name);
      if (!/^(article(-2)?\.html|icon\.svg)$/.test(name) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      const type = name.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8';
      setTimeout(() => { res.writeHead(200, { 'Content-Type': type }); res.end(fs.readFileSync(file)); },
        name.endsWith('.html') ? delayMs : 0);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Take a tab's renderer away the way the governor's discard does: record where
 * it was, then tear the view down. (The page-state snapshot is skipped - these
 * fixtures hold nothing typed.)
 */
async function discardForBench(tab) {
  if (!tab.isLive) return true;
  tab.setVisible(false);
  tab.captureNavigation();
  tab.teardownView();
  tab.tier = require('./config').Tier.DISCARDED;
  return !tab.isLive;
}

function print(report, startup) {
  console.log('\n=== Debrowser speed ===\n');
  if (startup) console.log(`  startup to first tab painted: ${startup} ms\n`);
  const width = Math.max(...Object.keys(report).map((k) => k.length));
  console.log(`  ${'moment'.padEnd(width)}   p50    p95    min   n`);
  for (const [name, s] of Object.entries(report)) {
    console.log(`  ${name.padEnd(width)}  ${String(s.p50 ?? '-').padStart(4)}  ${String(s.p95 ?? '-').padStart(5)}  ${String(s.min ?? '-').padStart(5)}  ${s.n}${s.failed ? ` (${s.failed} failed)` : ''}`);
  }
  console.log('\n  (milliseconds; command to first contentful paint, local fixtures)\n');
}

module.exports = { runSpeed, print, paintedAt, pages };
