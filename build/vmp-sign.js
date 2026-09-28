'use strict';

/**
 * Production VMP signing for Widevine, through castLabs EVS.
 *
 * castLabs' Electron arrives VMP-signed for development only, which Widevine's
 * test servers accept and Netflix, Disney+ and Prime Video do not - on Windows
 * and macOS they refuse a licence to an app without a production signature.
 * EVS gives one for free: the release workflow logs in with the EVS_ACCOUNT_NAME
 * and EVS_PASSWD secrets and sets DEBROWSER_VMP_SIGN=1.
 *
 * Wired as both `afterPack` and `afterSign` (electron-builder.yml), because the
 * order matters and differs: on macOS the VMP signature lives inside the
 * bundle, so it goes before code signing seals it; on Windows it is a separate
 * .sig file over the signed executable, so it goes after. Linux has no VMP.
 *
 * Without an account the build still succeeds, and still plays DRM wherever a
 * development signature is enough; it says so rather than failing a release.
 */

const { execFileSync } = require('child_process');

/**
 * Which hook signs on this platform. Windows goes after Authenticode - but
 * electron-builder skips `afterSign` altogether when nothing was signed, so an
 * unsigned Windows build is VMP-signed straight after packing instead.
 */
function phaseFor(platform) {
  if (platform === 'darwin') return 'afterPack';
  if (platform !== 'win32') return null;
  const authenticode = Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK || process.env.AZURE_TENANT_ID);
  return authenticode ? 'afterSign' : 'afterPack';
}

/**
 * The fuses, written now rather than after this hook.
 *
 * electron-builder flips them after `afterPack`, which rewrites the very
 * binary VMP just signed (the executable on Windows, the framework on macOS)
 * and voids the signature. Flipped here first, its own pass later writes back
 * identical bytes, and the signature holds.
 */
async function fusesFirst(context) {
  const { packager } = context;
  const fuses = packager.config.electronFuses;
  if (!fuses) return;
  await packager.addElectronFuses(context, await packager.generateFuseConfig(fuses));
}

async function vmpSign(phase, context) {
  const platform = context.electronPlatformName;
  if (phaseFor(platform) !== phase) return;

  if (process.env.DEBROWSER_VMP_SIGN !== '1') {
    console.warn(`  • VMP signing skipped for ${platform}: no castLabs EVS account ` +
      '(set the EVS_ACCOUNT_NAME and EVS_PASSWD secrets). Netflix, Disney+ and Prime ' +
      'Video will refuse this build on this platform.');
    return;
  }

  if (phase === 'afterPack') await fusesFirst(context);

  const python = process.platform === 'win32' ? 'python' : 'python3';
  console.log(`  • VMP signing ${context.appOutDir}`);
  try {
    execFileSync(python, ['-m', 'castlabs_evs.vmp', 'sign-pkg', context.appOutDir], { stdio: 'inherit' });
  } catch {
    // EVS signs only castLabs' binaries as shipped, and flipping any one of
    // the fuses (electron-builder.yml) makes it deny the request - measured,
    // each fuse alone. A refusal leaves the development signature, which is
    // what an unsigned build has, rather than failing the release.
    console.warn(`  • VMP signing refused for ${platform}: EVS denies a binary with fuses flipped. ` +
      'This build keeps its fuses and the development signature.');
  }
}

module.exports = { vmpSign };
