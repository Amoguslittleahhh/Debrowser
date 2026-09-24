'use strict';

/**
 * The private-connection page: Tor's progress, and what it does and does not
 * hide.
 *
 * It is where an incognito window starts. Until Tor is connected nothing else
 * can load - every request fails rather than going direct - so the one useful
 * thing to show is how far along it is and, when it stops, Tor's own reason
 * rather than a spinner. Opened as the first page (`?then=newtab`), it moves
 * on to the new tab page by itself once connected.
 */

const api = window.debrowser;

const el = {
  status: document.getElementById('status'),
  headline: document.getElementById('headline'),
  pct: document.getElementById('pct'),
  bar: document.getElementById('bar'),
  detail: document.getElementById('detail'),
  problem: document.getElementById('problem'),
  retry: document.getElementById('retry'),
  guard: document.getElementById('guard'),
  normal: document.getElementById('normal'),
  facts: document.querySelector('.facts')
};

const moveOnWhenReady = new URLSearchParams(location.search).get('then') === 'newtab';
let movedOn = false;

const HEADLINES = {
  idle: 'Waiting to connect',
  starting: 'Starting Tor',
  bootstrapping: 'Connecting to Tor',
  ready: 'Connected through Tor',
  failed: 'Not connected',
  stopped: 'Tor has stopped'
};

function render(incognito) {
  if (!incognito) {
    // The ordinary browser: nothing to connect.
    el.status.hidden = true;
    el.facts.hidden = true;
    el.normal.hidden = false;
    return;
  }
  const tor = incognito.tor || { state: 'idle', progress: 0 };
  el.status.dataset.state = tor.state;
  el.headline.textContent = HEADLINES[tor.state] || 'Connecting';
  el.pct.textContent = tor.state === 'ready' ? '' : `${tor.progress || 0}%`;
  el.bar.style.width = `${tor.state === 'ready' ? 100 : (tor.progress || 0)}%`;

  const how = tor.transport && tor.transport !== 'direct' ? `Using ${tor.transport}.` : '';
  const sentence = (text) => (text && !/[.!?]$/.test(text) ? `${text}.` : text || '');
  el.detail.textContent = tor.state === 'ready'
    ? ['Every page in this window goes through Tor.', how, tor.version ? `Tor ${tor.version}.` : '']
      .filter(Boolean).join(' ')
    : [sentence(tor.summary), how].filter(Boolean).join(' ');

  const problem = tor.recommended === 'obsolete'
    ? 'The Tor network reports this version of Tor as obsolete. Update Debrowser.'
    : tor.warning;
  el.problem.hidden = !problem || tor.state === 'ready' && tor.recommended !== 'obsolete';
  el.problem.textContent = problem || '';
  // Offered when it has given up, and when it has stalled: a bootstrap stuck
  // at one step for most of a minute is not going to finish by being watched.
  el.retry.hidden = !(tor.state === 'failed' || tor.state === 'stopped' ||
                      (tor.state === 'bootstrapping' && tor.warning));

  renderGuard(incognito.killSwitch, incognito.tripwire);

  if (tor.state === 'ready' && moveOnWhenReady && !movedOn) {
    movedOn = true;
    // A beat on "Connected", so it is seen rather than flashed past.
    setTimeout(() => { location.replace('debrowser://newtab'); }, 600);
  }
}

/**
 * What stands behind the proxy settings, said plainly: the operating system,
 * or only the tripwire. The tripwire notices a stray connection and closes the
 * window; the operating system prevents it in the first place.
 */
function renderGuard(killSwitch, tripwire) {
  const strong = document.createElement('strong');
  let rest;
  if (killSwitch && killSwitch.available) {
    el.guard.dataset.level = 'os';
    strong.textContent = 'Leak protection: enforced by the operating system.';
    rest = ` ${killSwitch.mechanism}. A connection that ignored the proxy would have nowhere to go.`;
  } else {
    el.guard.dataset.level = 'tripwire';
    strong.textContent = 'Leak protection: tripwire only.';
    const why = killSwitch && killSwitch.reason ? ` The operating system's wall is not available: ${killSwitch.reason}.` : '';
    const sees = tripwire && tripwire.available === false ? ' The tripwire itself is not running.' : '';
    rest = `${why} A stray connection is detected and the window closed, rather than prevented.${sees}`;
  }
  el.guard.replaceChildren(strong, document.createTextNode(rest));
}

el.retry.addEventListener('click', () => api.send('tor-retry'));

api.onState((state) => {
  applyThemePrefs(state.prefs);
  render(state.incognito || null);
});
