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
 * EVS signs only castLabs' binaries as shipped, and the fuses change them: it
 * denies every build with any fuse flipped (measured, each alone). So in
 * practice the fuses win and Widevine reports PLATFORM_TAMPERED: it still plays
 * wherever a licence server allows that (measured: castLabs' UAT server does),
 * and the strict services refuse. Removing the voided signatures was tried and
 * changes nothing - a VMP-enabled build without one is TAMPERED too.
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

/** EVS, if an account is set up. True when it signed. */
function evsSign(context) {
  if (process.env.DEBROWSER_VMP_SIGN !== '1') return false;
  // Denied for every fused build, so not asked: castLabs asks that signing
  // requests not be sent routinely for nothing.
  if (context.packager.config.electronFuses) {
    console.log(`  • VMP signing not requested for ${context.electronPlatformName}: EVS denies builds with fuses.`);
    return false;
  }
  const python = process.platform === 'win32' ? 'python' : 'python3';
  console.log(`  • VMP signing ${context.appOutDir}`);
  try {
    execFileSync(python, ['-m', 'castlabs_evs.vmp', 'sign-pkg', context.appOutDir], { stdio: 'inherit' });
    return true;
  } catch {
    // EVS signs only castLabs' binaries as shipped, and flipping any one of
    // the fuses (electron-builder.yml) makes it deny the request - measured,
    // each fuse alone. A refusal is not a failed release.
    console.warn(`  • VMP signing refused for ${context.electronPlatformName}: EVS denies a binary with fuses flipped.`);
    return false;
  }
}

async function vmpSign(phase, context) {
  const platform = context.electronPlatformName;
  if (platform !== 'win32' && platform !== 'darwin') return;

  if (phase === 'afterPack') {
    await fusesFirst(context);
    if (phaseFor(platform) === 'afterPack') evsSign(context);
    return;
  }
  // Windows with Authenticode: signed after it, over the file as shipped.
  if (phaseFor(platform) === 'afterSign') evsSign(context);
}

module.exports = { vmpSign };
