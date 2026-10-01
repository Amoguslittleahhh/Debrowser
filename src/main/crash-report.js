'use strict';

/**
 * Problems reported without a crash server: an unexpected error in the
 * browser process is kept in `last-crash.json`, and the next start offers to
 * report it - as a GitHub issue the user reads before sending, prefilled with
 * the version, the system and the error. Nothing leaves the computer unless
 * they press Submit there.
 *
 * Addresses and the home folder are taken out first: a stack trace can carry
 * the page that was open, and a path carries the user's name.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { URLSearchParams } = require('url');

const ISSUES = 'https://github.com/amoguslittleahhh/debrowser/issues/new';
const FILE = 'last-crash.json';

function scrub(text) {
  let out = String(text || '');
  out = out.replace(/\b(?:https?|wss?|file|ftp):\/\/[^\s'")]+/gi, '<address>');
  const home = os.homedir();
  if (home) out = out.split(home).join('~');
  return out.slice(0, 4000);
}

function record(userData, err, version) {
  try {
    fs.writeFileSync(path.join(userData, FILE), JSON.stringify({
      version, at: Date.now(),
      message: scrub(err && err.message), stack: scrub(err && err.stack)
    }));
  } catch { /* nothing more can be done from here */ }
}

/** The last crash, once: read and forgotten. */
function take(userData) {
  const file = path.join(userData, FILE);
  try {
    const crash = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
    return crash && typeof crash.message === 'string' ? crash : null;
  } catch {
    return null;
  }
}

/** A new-issue link with the version info, and the crash if there was one. */
function issueUrl(versionLines, crash = null) {
  const body = [
    '### What happened',
    crash ? 'Debrowser hit an unexpected error. (Say what you were doing, if you remember.)' : '',
    '',
    '### Version info',
    '```',
    ...versionLines,
    '```',
    ...(crash ? ['', '### The error', '```', crash.stack || crash.message, '```'] : [])
  ].join('\n');
  const params = new URLSearchParams({
    labels: crash ? 'bug,crash' : 'bug',
    title: crash ? `Crash: ${crash.message.slice(0, 80)}` : '',
    body
  });
  // Long enough to carry a stack, short enough for every browser's limit.
  return `${ISSUES}?${params.toString()}`.slice(0, 7800);
}

module.exports = { record, take, issueUrl, scrub };
