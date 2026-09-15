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
  const proportional = state.accounting === 'pss';
  el.total.title = proportional
    ? 'Proportional set size: pages shared between processes are counted once, ' +
      'split across the processes sharing them. This is real physical memory.'
    : 'Summed working set. This platform offers no cheap proportional measure, ' +
      'so pages shared between processes - chiefly one copy of Chromium in each ' +
      'of them - are counted once per process. Measured at about 2x the ' +
      'proportional figure, rising with process count. The browser is holding ' +
      'meaningfully less than this number says.';
  el.totalLabel.textContent = proportional ? 'resident' : 'resident (over-counts)';

  el.budget.textContent = `${state.budgetMB} MB`;
  el.renderers.textContent = state.maxLiveTabs
    ? `${state.liveTabs}/${state.maxLiveTabs}`
    : String(state.liveTabs);
  el.renderers.title = state.maxLiveTabs
    ? `${state.liveTabs} tabs hold a renderer, out of a cap of ${state.maxLiveTabs}. ` +
      `Beyond the cap the least-recently-used tab is discarded.`
    : 'Live renderer cap is disabled.';

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
  let line =
    `${state.profile} profile · ${state.rendererCount} process(es) · ` +
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
    if (state.compression && !state.compression.available) {
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

  root.append(dot, main, mem, action);
  return { root, dot, title, sub, mem, action, state: {} };
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
