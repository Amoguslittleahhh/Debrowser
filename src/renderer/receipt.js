'use strict';

/** The week's receipt, drawn from the browser's seven daily totals. */

const api = window.debrowser;
const $ = (id) => document.getElementById(id);
const size = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

async function load() {
  const res = await api.request('receipt-week');
  const week = (res && res.week) || [];
  const sum = (key) => week.reduce((n, d) => n + (d[key] || 0), 0);

  const totals = [
    [size(sum('freedMB')), 'memory freed'],
    [sum('slept').toLocaleString(), 'tabs put to sleep'],
    [sum('blocked').toLocaleString(), 'ads and trackers blocked'],
    [(sum('cleaned') + sum('stopped')).toLocaleString(), 'links cleaned or sites stopped']
  ];
  $('totals').replaceChildren(...totals.map(([n, what]) => {
    const card = document.createElement('div');
    card.className = 'total';
    const big = document.createElement('span');
    big.className = 'n';
    big.textContent = n;
    const label = document.createElement('span');
    label.className = 'what';
    label.textContent = what;
    card.append(big, label);
    return card;
  }));

  const freed = sum('freedMB');
  $('lead').textContent = freed >= 1
    ? `Tabs you were not using gave back ${size(freed)} of memory this week – room your computer had for everything else.`
    : 'Nothing to show yet. As tabs you leave go to sleep, what they give back adds up here.';

  const most = Math.max(1, ...week.map((d) => d.freedMB || 0));
  const days = week.map((d, i) => {
    const el = document.createElement('div');
    el.className = i === week.length - 1 ? 'day today' : 'day';
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = d.freedMB ? size(d.freedMB) : '';
    const wrap = document.createElement('div');
    wrap.className = 'bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = `${Math.round((d.freedMB / most) * 100)}%`;
    bar.style.animationDelay = `${i * 30}ms`;
    wrap.append(bar);
    const label = document.createElement('span');
    label.className = 'd';
    label.textContent = i === week.length - 1 ? 'Today'
      : new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
    el.append(v, wrap, label);
    return el;
  });
  $('chart').replaceChildren(...days);
  $('chart').setAttribute('aria-label', week.map((d) => `${d.date}: ${size(d.freedMB)}`).join(', '));
}

api.onState((state) => applyThemePrefs(state.prefs));
load();
window.addEventListener('focus', load);
