#!/usr/bin/env node
'use strict';
/**
 * Exercise probe.hta's verdict logic against synthetic reports.
 *
 * The probe decides GO / MAYBE / STOP with regexes over a space-padded report,
 * and a wrong GO would send the WebView2 work building on a foundation that is
 * not there. Wine cannot run an .hta - its mshta.exe is a stub - so this is the
 * only way to execute that logic without Windows.
 *
 * Extracts the script straight out of probe.hta rather than from a copy, so it
 * always tests the file that ships.
 *
 *   node legacy/verdict-test.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const hta = fs.readFileSync(path.join(__dirname, 'probe.hta'), 'utf8');
const match = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(hta);
if (!match) {
  console.error('could not find the script block in probe.hta');
  process.exit(1);
}

let verdictClass = '';
let verdictText = '';
const out = { value: '' };
const verdictEl = {
  set className(v) { verdictClass = v; },
  set innerHTML(v) { verdictText = v; },
  style: {}
};

// Enough of the HTA surface for the logic under test, and no more.
const ctx = {
  document: {
    getElementById: (id) => (id === 'out' ? out : verdictEl)
  },
  window: { setTimeout: () => {} },
  navigator: { userAgent: 'stub' },
  ActiveXObject: function () { throw new Error('no activex here'); },
  Date, RegExp, String, Math, console
};
vm.createContext(ctx);
vm.runInContext(match[1], ctx);

const pad = (k) => { let s = k; while (s.length < 30) s += ' '; return s; };
const report = (runtime, loader, addType) => [
  `${pad('WebView2 runtime')} = ${runtime}`,
  `${pad('WebView2Loader.dll')} = ${loader}`,
  `${pad('Add-Type compiles')} = ${addType}`
].join('\n');

const LOADER = 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\...\\WebView2Loader.dll';
const cases = [
  ['everything present',        report('142.0.3296.68', LOADER, 'ok (ping=42)'),           'go'],
  ['runtime, but no loader',    report('142.0.3296.68', 'NOT FOUND ANYWHERE', 'ok (ping=42)'), 'wait'],
  ['no runtime',                report('NOT FOUND', 'NOT FOUND ANYWHERE', 'ok (ping=42)'),  'stop'],
  ['cannot compile C#',         report('142.0.3296.68', LOADER, 'FAIL: blocked by policy'), 'stop'],
  ['neither',                   report('NOT FOUND', 'NOT FOUND ANYWHERE', 'FAIL: CLM'),     'stop']
];

let passed = 0;
for (const [name, body, expected] of cases) {
  ctx.lines = body.split('\n');
  ctx.verdict();
  const ok = verdictClass === expected;
  if (ok) passed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} -> ${verdictClass}` +
              (ok ? '' : `  (expected ${expected})\n        said: ${verdictText}`));
}

console.log(`\n  ${passed}/${cases.length} verdict cases correct`);
process.exit(passed === cases.length ? 0 : 1);
