'use strict';

/**
 * Task manager.
 *
 * Shows what the governor is actually doing, per tab: which tier each one is
 * in, what it is holding, and what has been reclaimed so far. A memory manager
 * that works invisibly is indistinguishable from one that is broken, so this
 * panel is the accountability surface for every decision made in governor/.
 */

const api = window.debrowser;

const el = {
  total: document.getElementById('total'),
  budget: document.getElementById('budget'),
  renderers: document.getElementById('renderers'),
  pressure: document.getElementById('pressure'),
  totalLabel: document.getElementById('total-label'),
  list: document.getElementById('tab-list'),
  stats: document.getElementById('stats'),
  close: document.getElementById('close'),
  budgetInput: document.getElementById('budget-input'),
  budgetOut: document.getElementById('budget-out')
};

const rows = new Map();
let budgetPinnedByUser = false;

const TIER_TEXT = {
  active: 'Active',
  warm: 'Background',
  cold: 'Idle · discardable',
  frozen: 'Frozen · 0% CPU',
  hibernated: 'Hibernated · compressed',
  discarded: 'Discarded · 0 MB'
};

const PRESSURE_TEXT = {
  none: 'Under budget. Tabs are demoted on the idle ladder and by the live cap.',
  moderate: 'Approaching budget. Idle tabs are being trimmed sooner.',
  high: 'Over budget. Idle tabs are being frozen and may be discarded.',
  critical: 'Well over budget. Reclaiming aggressively from the least-used tabs.'
};

function render(state) {
  el.total.textContent = `${state.totalMB} MB`;

  // Say which quantity this is. The same label sits over two different
  // measurements depending on the platform: proportional set size on Linux,
  // and summed working set everywhere else, because Windows and macOS expose no
  // cheap PSS equivalent and Electron's `getAppMetrics` reports only
  // `workingSetSize` (its `private` and `shared` fields are in the typings but
  // come back zero). Summed working set counts every page shared between
  // processes - chiefly one copy of Chromium per process - once for each of
  // them, so the figure runs roughly 2x high and climbs with process count.
  // Leaving that unsaid means a Windows user reads a number two to three times
  // the browser's real footprint with nothing to tell them.
  // 'probe' is the native helper: a true proportional figure on Windows, and
  // the footprint macOS itself charges. Both are honest totals, so neither
  // carries the over-counting warning.
  // 'mixed' is deliberately not counted as proportional: part of the total is
  // still summed working set, so the over-count warning stays up.
  // 'suspect' is the helper running, covering every process, and returning a
  // total that is not meaningfully below summed working set - so whatever it
  // is reporting, it is not a proportional figure, and claiming one would be
  // worse than the plain over-count it replaced.
  const proportional = state.accounting === 'pss' || state.accounting === 'probe';
  el.total.title = state.accounting === 'suspect'
    ? 'The native helper ran and covered every process, but its total is not ' +
      `meaningfully below summed working set (${state.probeRatio}x of it), so it is ` +
      'not delivering a proportional figure. On Windows the likely cause is that ' +
      'the share count a page carries is three bits wide and saturates at seven: ' +
      'a system DLL mapped into a hundred processes is charged at a seventh to ' +
      'each of ours rather than a hundredth. Treat this as an over-count.'
    : state.accounting === 'probe'
    ? (state.probeMechanism === 'proc_pid_rusage'
        ? 'Physical footprint, the figure macOS charges each process and shows in ' +
          'Activity Monitor. It excludes clean file-backed pages - one copy of ' +
          'Chromium in every renderer - which is where the over-counting came from. ' +
          'It does not divide shared dirty pages, so it is not proportional set size.'
        : 'Proportional set size, computed by walking each process\'s working set ' +
          'and dividing every shared page by the number of processes sharing it. ' +
          'Windows caps that share count at 7, so a page shared by more processes ' +
          'is counted slightly high.')
    : proportional
    ? 'Proportional set size: pages shared between processes are counted once, ' +
      'split across the processes sharing them. This is real physical memory.'
    : 'Summed working set. This platform offers no cheap proportional measure, ' +
      'so pages shared between processes - chiefly one copy of Chromium in each ' +
      'of them - are counted once per process. Measured at about 2x the ' +
      'proportional figure, rising with process count. The browser is holding ' +
      'meaningfully less than this number says.';
  el.totalLabel.textContent = proportional ? 'resident' : 'resident (over-counts)';

  // Private working set has no sharing to argue about, so printing it beside
  // the total turns "is this figure inflated?" from a judgement into a
  // subtraction anyone can do. It is also the column Task Manager shows, which
  // is what someone checking this by hand will have in front of them.
  if (state.privateTotalMB != null && state.rssTotalMB) {
    el.totalLabel.title =
      `${state.totalMB} MB reported · ${state.rssTotalMB} MB summed working set · ` +
      `${state.privateTotalMB} MB private. Private is what Task Manager's Memory ` +
      'column shows and involves no shared pages at all, so the gap between it and ' +
      'the total is the shared memory being attributed to this browser.';
  }

  el.budget.textContent = `${state.budgetMB} MB`;
  // The count, not a ration.
  //
  // This read "15/12" - which is true, and reads as a limit the browser is
  // failing to keep. It is neither: tabs are never rationed, and the cap is an
  // internal reclaim threshold, not a quota the user is spending. Showing it as
  // a fraction invited exactly the wrong question, so the tile shows how many
  // tabs currently hold a renderer and the tooltip explains what that means.
  el.renderers.textContent = String(state.liveTabs);
  el.renderers.title =
    `${state.liveTabs} of ${state.tabs.length} open tabs hold a renderer. ` +
    'The rest keep their place, their history and their scroll, and come back ' +
    'when you return to them. Open as many as you like.';

  el.pressure.textContent = PRESSURE_TEXT[state.pressure] || state.pressure;
  el.pressure.dataset.pressure = state.pressure;

  if (!budgetPinnedByUser) {
    el.budgetInput.value = String(state.budgetMB);
    el.budgetOut.textContent = `${state.budgetMB} MB`;
  }

  renderRows(state.tabs);

  // The explanations are off by default and live in Settings.
  //
  // This panel is a live instrument: what each tab is holding, right now, and
  // why. A paragraph of prose beside a number that changes twice a second is
  // noise in front of the thing you opened it to read. The text was worth
  // keeping rather than deleting, so it appears on request - "Explain the
  // memory figures" in Settings - and the label still says "over-counts" either
  // way, because a wrong number with no warning is the one thing that is not
  // acceptable.
  const detail = state.prefs && state.prefs.showMemoryDetail;

  if (detail && !proportional) {
    el.pressure.textContent +=
      ` Memory is counted as summed working set on this platform, which counts ` +
      `each shared page once per process - about 2x high, and more with more ` +
      `processes open. The real footprint is lower; the budget is compared ` +
      `against the same inflated figure, so it reclaims earlier rather than later.`;
  }

  const merging = state.pageMerging;
  if (detail && merging && merging.active) {
    el.pressure.textContent += ` Page merging is active (KSM): ~${merging.profitMB} MB saved system-wide. ` +
      'Deduplication is a known timing side channel - see the README.';
  }

  const s = state.stats;
  // Both counts, each under its own name.
  //
  // This said "N process(es)" and printed `rendererCount`, which counts only
  // processes of type Tab - so the browser, GPU and network processes were
  // missing from a number labelled as every process. On a fresh window it read
  // "2 process(es)" beside a total of 510MB, which makes the total look
  // impossible rather than merely high, and sends anyone reading it after the
  // wrong bug.
  let line =
    `${state.profile} profile · ${state.processCount} process(es), ` +
    `${state.rendererCount} renderer(s) · ` +
    `${s.freezes} frozen · ${s.discards} discarded · ~${s.reclaimedMB} MB reclaimed`;
  // Only shown once the heap limit rule has actually acted, so the line stays
  // quiet in the default configuration where the rule is off.
  if (s.heapCollections) {
    line += ` · ${s.heapCollections} heap collection(s), ~${s.heapReclaimedMB} MB`;
  }

  // An inert lever must be visible, not silent: "nothing has hibernated yet" and
  // "this machine cannot hibernate at all" look identical from a count alone.
  const hib = state.hibernation;
  if (hib && !hib.available) {
    el.pressure.textContent += ` Hibernation unavailable: ${hib.reason}.`;
    // Name the fix, not just the fault. "No swap" is something the user can act
    // on in one command; "unavailable" on its own is not.
    //
    // Only where the fix is the fix, though. Off Linux the mechanism is not
    // implemented at all, so a missing compressor is not what is stopping it,
    // and this line used to follow "not implemented on win32" with "enabling
    // zram or swap would turn it on" - contradicting the sentence before it and
    // sending the user after something that would not have helped.
    if (state.compression && state.compression.applicable && !state.compression.available) {
      el.pressure.textContent += ' Enabling zram or swap would turn it on.';
    }
  } else if (hib && hib.disabled) {
    el.pressure.textContent += ' Hibernation disabled: it reclaimed too little on this machine.';
  } else if (s.hibernations) {
    line += ` · ${s.hibernations} hibernated, ~${Math.round(s.hibernateReclaimedMB)} MB compressed`;
  }

  // What the reclaim cost, next to what it saved. `restore` is the one that
  // matters: it is the only reclaim in this browser the user can feel.
  const lat = state.latency || {};
  const timings = [];
  if (lat.restore) timings.push(`restore ${lat.restore.p50}/${lat.restore.p95} ms`);
  if (lat.switch) timings.push(`switch ${lat.switch.p50}/${lat.switch.p95} ms`);
  if (timings.length) line += ` · ${timings.join(', ')} (p50/p95)`;

  el.stats.textContent = line;
}

function renderRows(tabs) {
  const seen = new Set();

  // Heaviest first: the tabs worth acting on are the ones at the top.
  const ordered = [...tabs].sort((a, b) => b.rssMB - a.rssMB);

  ordered.forEach((tab, index) => {
    seen.add(tab.id);
    let row = rows.get(tab.id);
    if (!row) {
      row = createRow(tab.id);
      rows.set(tab.id, row);
    }
    const current = el.list.children[index];
    if (current !== row.root) el.list.insertBefore(row.root, current || null);
    updateRow(row, tab);
  });

  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.root.remove();
      rows.delete(id);
    }
  }
}

function createRow(id) {
  const root = document.createElement('li');
  root.className = 'row';

  const dot = document.createElement('span');
  dot.className = 'dot';

  // The site's own icon, so a list of twenty rows can be read by looking rather
  // than by reading. Same treatment as the tab strip: the letter underneath,
  // the logo over it, and the logo removed if it never loads.
  const chip = document.createElement('span');
  chip.className = 'row-chip';
  chip.setAttribute('aria-hidden', 'true');

  const main = document.createElement('div');
  main.className = 'row-main';
  const title = document.createElement('div');
  title.className = 'row-title';
  const sub = document.createElement('div');
  sub.className = 'row-sub';
  main.append(title, sub);

  const mem = document.createElement('span');
  mem.className = 'row-mem';

  const action = document.createElement('button');
  action.className = 'row-action';
  action.textContent = 'Discard';
  action.addEventListener('click', () => api.send('discard-tab', { id }));

  root.addEventListener('click', (event) => {
    if (event.target !== action) api.send('activate-tab', { id });
  });

  root.append(dot, chip, main, mem, action);
  return { root, dot, chip, title, sub, mem, action, state: {} };
}

function updateRow(row, tab) {
  const prev = row.state;

  if (prev.title !== tab.title) {
    row.title.textContent = tab.title || tab.url;
    prev.title = tab.title;
  }

  const sub = describe(tab);
  if (prev.sub !== sub) {
    row.sub.textContent = sub;
    prev.sub = sub;
  }

  if (prev.tier !== tab.tier) {
    row.dot.dataset.tier = tab.tier;
    prev.tier = tab.tier;
  }

  // Keyed on the site rather than the URL: a tab moving between pages on one
  // host keeps its letter and its colour, and rewriting them on every
  // navigation would be work for no visible change.
  const host = siteOf(tab.url);
  if (prev.host !== host) {
    row.chip.textContent = (host.replace(/^[^a-z0-9]+/i, '')[0] || '?');
    row.chip.style.setProperty('--hue', String(siteHue(host)));
    prev.host = host;
  }

  if (prev.favicon !== tab.favicon) {
    if (row.icon) { row.icon.remove(); row.icon = null; }
    // The letter is a stand-in for a logo, not a tile to draw one on: favicons
    // are transparent far more often than not, so the chip has to stop painting
    // once the real icon is up. Reset first, in case the previous page had one
    // and this one does not.
    row.chip.classList.remove('has-icon');
    const src = iconSrc(tab.favicon);
    if (src) {
      const icon = document.createElement('img');
      icon.className = 'row-icon';
      icon.alt = '';
      icon.decoding = 'async';
      icon.src = src;
      icon.addEventListener('load', () => row.chip.classList.add('has-icon'));
      icon.addEventListener('error', () => icon.remove());
      row.chip.append(icon);
      row.icon = icon;
    }
    prev.favicon = tab.favicon;
  }

  const mem = tab.tier === 'discarded' ? '—' : `${tab.rssMB} MB`;
  if (prev.mem !== mem) {
    row.mem.textContent = mem;
    prev.mem = mem;
  }

  if (prev.boosted !== tab.boosted) {
    row.mem.classList.toggle('boosted', tab.boosted);
    prev.boosted = tab.boosted;
  }

  // A visible or already-discarded tab has nothing to discard.
  const disabled = tab.visible || tab.tier === 'discarded';
  if (prev.disabled !== disabled) {
    row.action.disabled = disabled;
    prev.disabled = disabled;
  }
}

/** The site a tab is on, for the chip's letter and colour. */
function siteOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'debrowser:') return 'debrowser';
    return parsed.hostname.replace(/^www\./, '') || parsed.protocol;
  } catch {
    return '';
  }
}

function describe(tab) {
  const parts = [TIER_TEXT[tab.tier] || tab.tier];

  if (tab.boosted) parts.push('boosted for animation');
  else if (tab.visible && tab.demand === 'heavy') parts.push('animating');

  if (tab.audible) parts.push('playing audio');
  if (tab.hasDirtyInput) parts.push('unsaved input · protected');
  if (tab.sharesProcess) parts.push('shares a process');
  if (tab.cpu >= 1) parts.push(`${tab.cpu}% CPU`);

  return parts.join(' · ');
}

/* ------------------------------------------------------------------ */

el.close.addEventListener('click', () => api.send('toggle-panel'));

el.budgetInput.addEventListener('input', () => {
  budgetPinnedByUser = true;
  el.budgetOut.textContent = `${el.budgetInput.value} MB`;
});

el.budgetInput.addEventListener('change', () => {
  api.send('set-budget', { mb: Number(el.budgetInput.value) });
});

api.onState((state) => {
  applyThemePrefs(state.prefs);
  render(state);
});
