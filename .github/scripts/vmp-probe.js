'use strict';
// One-off probe, run by release.yml when dispatched with test=vmp-probe: which
// Electron fuses castLabs EVS will still VMP-sign. Packs the Windows app once
// with no fuses and no signing hook, then for each fuse copies it, flips that
// fuse alone, and asks EVS to sign the copy.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { build } = require('electron-builder');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

(async () => {
  const yaml = require('js-yaml');
  const config = yaml.load(fs.readFileSync('electron-builder.yml', 'utf8'));
  delete config.electronFuses;
  delete config.afterPack;
  delete config.afterSign;
  await build({ win: ['dir'], publish: 'never', config });
  const cases = ['none', 'RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments',
    'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar'];
  const results = [];
  for (const name of cases) {
    const dir = path.resolve('probe', name);
    fs.cpSync('dist/win-unpacked', dir, { recursive: true });
    if (name !== 'none') {
      const want = name === 'RunAsNode' || name.startsWith('EnableNode') ? false : true;
      await flipFuses(path.join(dir, 'Debrowser.exe'), { version: FuseVersion.V1, [FuseV1Options[name]]: want });
    }
    let ok = true;
    try {
      execFileSync('python', ['-m', 'castlabs_evs.vmp', 'sign-pkg', dir], { stdio: 'inherit' });
    } catch { ok = false; }
    results.push(`${name}: ${ok ? 'SIGNED' : 'DENIED'}`);
  }
  console.log(`\nVMP PROBE\n${results.join('\n')}`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY || '/dev/null', `### VMP probe\n${results.map((r) => `- ${r}`).join('\n')}\n`);
})().catch((err) => { console.error(err); process.exit(1); });
