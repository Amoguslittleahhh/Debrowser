#!/usr/bin/env node
'use strict';

/**
 * The release feed's choices, checked without a network: which release counts
 * as new for each channel, what a stale cache is, and how a release body is
 * read back into notes.
 *
 *     node test/release-feed.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReleaseFeed, pick, compare, bodyNotes } = require('../src/main/release-feed');

const releases = [
  { tag: 'v2.5.0-beta.1', prerelease: true, draft: false, body: '' },
  { tag: 'v2.4.0', prerelease: false, draft: false, body: '' },
  { tag: 'v2.6.0', prerelease: false, draft: true, body: '' },
  { tag: 'v1.2.1-intune-only', prerelease: true, draft: false, body: '' },
  { tag: 'v2.3.0', prerelease: false, draft: false, body: '' }
];

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); } catch (err) { failed++; console.log(`  FAIL  ${name} — ${err.message}`); }
}

check('versions compare by number, a beta before its release', () => {
  assert(compare('2.10.0', '2.9.9') > 0);
  assert(compare('2.5.0-beta.1', '2.5.0') < 0);
  assert(compare('2.5.0-beta.2', '2.5.0-beta.1') > 0);
  assert.strictEqual(compare('v2.4.0', '2.4.0'), 0);
});

check('stable ignores drafts, prereleases and odd tags', () => {
  const s = pick(releases, { channel: 'stable', current: '2.3.0' });
  assert.strictEqual(s.latest.version, '2.4.0');
  assert.deepStrictEqual(s.newer, ['2.4.0']);
});

check('beta sees the prerelease', () => {
  const s = pick(releases, { channel: 'beta', current: '2.4.0' });
  assert.strictEqual(s.latest.version, '2.5.0-beta.1');
  assert.deepStrictEqual(s.newer, ['2.5.0-beta.1']);
});

check('nothing is new on the newest version', () => {
  assert.deepStrictEqual(pick(releases, { channel: 'stable', current: '2.4.0' }).newer, []);
});

check('a release body is read without its header and footer', () => {
  const body = 'Debrowser 2.4.0 · abc1234 · 2026-10-16\n\n| System | File |\n|---|---|\n\n### New\n\n- **A thing.** It works.\n\n### Fixed\n\n- **Another.** Better.\n\n---\n\nSHA-256 ...\nReleased by **someone**.';
  const notes = bodyNotes(body, '2.4.0');
  assert.strictEqual(notes.version, '2.4.0');
  assert.deepStrictEqual(notes.sections.map((s) => s.title), ['New', 'Fixed']);
  assert.strictEqual(notes.sections[0].items[0].head, 'A thing.');
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
const file = path.join(dir, 'release-feed.json');
let calls = 0;
const fakeFetch = (status, list) => async (url, init) => {
  calls++;
  return { status, ok: status === 200, json: async () => list, headers: { get: () => '"etag-1"' }, init };
};
let clock = 1_000_000;

(async () => {
  const feed = new ReleaseFeed({ file, fetch: fakeFetch(200, releases.map((r) => ({ tag_name: r.tag, draft: r.draft, prerelease: r.prerelease, body: r.body }))),
    channel: () => 'stable', current: '2.3.0', now: () => clock });
  await feed.refresh();
  check('a first refresh asks and saves', () => { assert.strictEqual(calls, 1); assert(fs.existsSync(file)); });
  await feed.refresh();
  check('a fresh answer is not asked again', () => assert.strictEqual(calls, 1));
  clock += 61 * 60 * 1000;
  await feed.refresh();
  check('an hour later it asks again', () => assert.strictEqual(calls, 2));
  const updated = new ReleaseFeed({ file, fetch: fakeFetch(304, null), channel: () => 'stable', current: '2.4.0', now: () => clock });
  await updated.refresh();
  check('a new installed version asks again straight away, without the old ETag', () => {
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(updated.status().newer, []);
  });
  const broken = new ReleaseFeed({ file, fetch: async () => { throw new Error('offline'); }, channel: () => 'stable', current: '2.3.0', now: () => clock });
  const ok = await broken.refresh({ force: true });
  check('a failed check keeps the last answer', () => { assert.strictEqual(ok, false); assert.strictEqual(broken.status().latest.version, '2.4.0'); });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
