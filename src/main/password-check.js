'use strict';

/**
 * A check-up of the saved sign-ins: which passwords have appeared in a data
 * breach, which are used on more than one site, and which are weak.
 *
 * Breaches are looked up with Have I Been Pwned's range search, the way
 * Firefox, 1Password and Bitwarden do it. What leaves this machine for one
 * password is the first five characters of its SHA-1 hash - one of a million
 * buckets, each shared by hundreds of passwords - and the service answers with
 * every hash in that bucket, padded so even the answer's size says nothing.
 * The match is made here. Neither the password nor its full hash is ever sent.
 *
 * Only when the user asks, from the Passwords page.
 */

const crypto = require('crypto');

const RANGE = 'https://api.pwnedpasswords.com/range/';

const sha1 = (text) => crypto.createHash('sha1').update(text, 'utf8').digest('hex').toUpperCase();

/** Weak by what makes a password guessable: short, one kind of character, or a well-known one. */
const COMMON = /^(password|passw0rd|qwerty|qwertyuiop|letmein|welcome|iloveyou|admin|abc123|123456789?|1234567890|111111|000000|monkey|dragon|football|baseball|sunshine|princess)\d*[!.]?$/i;
function isWeak(password) {
  const p = String(password || '');
  if (p.length < 8 || COMMON.test(p)) return true;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  return p.length < 12 && kinds < 2;
}

/**
 * @param {Array<{id: string, password: string}>} logins
 * @param {(url: string, init: object) => Promise<Response>} fetchImpl
 * @returns {Promise<{results: Record<string, {breached: number, reused: boolean, weak: boolean}>, checked: boolean}>}
 */
async function checkPasswords(logins, fetchImpl) {
  const byHash = new Map();
  for (const login of logins) {
    const hash = sha1(login.password);
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(login.id);
  }

  // One request per bucket, not per password.
  const counts = new Map();
  let checked = true;
  const prefixes = [...new Set([...byHash.keys()].map((h) => h.slice(0, 5)))];
  for (const prefix of prefixes) {
    try {
      const res = await fetchImpl(RANGE + prefix, { headers: { 'Add-Padding': 'true' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const line of (await res.text()).split('\n')) {
        const [suffix, count] = line.trim().split(':');
        if (suffix && Number(count) > 0) counts.set(prefix + suffix.toUpperCase(), Number(count));
      }
    } catch {
      checked = false;               // offline: the rest of the check still stands
    }
  }

  const results = {};
  for (const [hash, ids] of byHash) {
    for (const id of ids) {
      const password = logins.find((l) => l.id === id).password;
      results[id] = { breached: counts.get(hash) || 0, reused: ids.length > 1, weak: isWeak(password) };
    }
  }
  return { results, checked };
}

module.exports = { checkPasswords, isWeak, sha1 };
