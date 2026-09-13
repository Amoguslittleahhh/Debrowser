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

  const merging = state.pageMerging;
  if (merging && merging.active) {
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

api.onState(render);
