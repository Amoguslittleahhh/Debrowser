// Reconcile app.getAppMetrics() against a direct /proc sweep of the same tree.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { footprintMB } = require(path.join(__dirname, '..', 'src/main/memory'));
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const { BaseWindow, WebContentsView } = require('electron');
  const w = new BaseWindow({ width: 800, height: 600, show: false });
  const v = new WebContentsView(); w.contentView.addChildView(v);
  await v.webContents.loadURL('about:blank');
  await new Promise(r => setTimeout(r, 9000));

  const metrics = app.getAppMetrics();
  const types = {};
  let apiTotal = 0;
  for (const p of metrics) {
    const mb = footprintMB(p.pid, (p.memory?.workingSetSize || 0) / 1024);
    types[p.type] = (types[p.type] || 0) + mb;
    apiTotal += mb;
  }
  const apiPids = new Set(metrics.map(p => p.pid));

  // Direct sweep: every descendant of this process.
  const kids = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
        if (kids.has(ppid) && !kids.has(Number(d))) { kids.add(Number(d)); changed = true; }
      } catch {}
    }
  }
  let procTotal = 0; const missing = [];
  for (const pid of kids) {
    try {
      const roll = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      const pss = [...roll.matchAll(/^Pss:\s+(\d+) kB/gm)].reduce((s, m) => s + Number(m[1]), 0) / 1024;
      procTotal += pss;
      if (!apiPids.has(pid)) {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        const t = (cmd.match(/--type=([a-z-]+)/) || [0, 'main'])[1];
        missing.push(`${t} ${pss.toFixed(1)}MB`);
      }
    } catch {}
  }
  console.log('__RECON__' + JSON.stringify({
    apiTotal: Math.round(apiTotal), procTotal: Math.round(procTotal),
    types: Object.fromEntries(Object.entries(types).map(([k, v]) => [k, Math.round(v)])),
    apiProcs: metrics.length, procProcs: kids.size, missing
  }));
  app.quit();
});
