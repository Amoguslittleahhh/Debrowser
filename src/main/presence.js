'use strict';

/**
 * "Prove it is you" before a saved secret is shown or filled.
 *
 * The credential store already encrypts records under a key the OS holds, so
 * the file is useless to someone copying it off the disk. What it does not
 * protect against is the simplest attack there is: someone sitting at an
 * unlocked machine opening Settings and pressing Show. That is what this is
 * for - a presence check at the moment of reveal, not another layer of
 * encryption.
 *
 * ## The rule everything here is built around
 *
 * **Failure denies.** Every path that is not an explicit, observed success
 * returns false: a helper that will not start, a check that throws, a timeout,
 * an unrecognised answer. A presence check that fails open is not a presence
 * check, it is a delay - and the failure mode of getting this backwards is
 * that the protection silently stops existing while still being advertised in
 * Settings.
 *
 * ## What is real here and what is not
 *
 * macOS is real and complete: Electron exposes Touch ID directly
 * (`systemPreferences.promptTouchID`), so there is no native code and nothing
 * to guess at.
 *
 * Windows is in two halves, and only one of them has ever run. Windows Hello
 * lives in WinRT's `UserConsentVerifier`, and the verification call needs a
 * window handle through a COM interop interface that has no PowerShell
 * equivalent - so it is reached by compiling a small C# shim with `Add-Type` at
 * runtime, the same way Microsoft's own samples do it. All of it was written on
 * Linux, in a container with no Windows.
 *
 * The availability probe has now run on a real machine, and failed: it used a
 * type from an assembly Windows PowerShell does not load by default, while the
 * prompt half loaded it. So Hello reported itself unavailable on a machine that
 * had it. Both halves share one prelude now, and both say which PowerShell they
 * were talking to when they fail.
 *
 * The prompt itself is still unexecuted, and CI cannot help: a Hello prompt
 * needs an interactive desktop session and hardware no runner has. It stays
 * marked experimental in the capability, which is what Settings shows.
 *
 * Linux has no equivalent to report, and says so.
 */

const { systemPreferences } = require('electron');
const { spawn } = require('child_process');

/** Longest a person is asked to wait at a prompt before it is treated as refused. */
const PROMPT_TIMEOUT_MS = 60_000;

/** Longest the availability probe may take. It answers immediately or not at all. */
const PROBE_TIMEOUT_MS = 8_000;

let cachedCapability = null;

/**
 * Load the assembly that makes a WinRT async operation awaitable from .NET.
 *
 * `System.Runtime.WindowsRuntime` is where `AsTask()` and the
 * `System.WindowsRuntimeSystemExtensions` class that carries it live. Windows
 * PowerShell does not load it by default, and a type in an unloaded assembly is
 * simply not there - which is what "Unable to find type
 * [System.WindowsRuntimeSystemExtensions]" means, and what this probe reported
 * on the first Windows machine it ever ran on. The prompt half loaded it and
 * the probe half did not, so availability failed while the code it guards was
 * fine.
 *
 * `LoadWithPartialName` first because it is the one that reliably resolves this
 * assembly by simple name in Windows PowerShell; deprecated, and the documented
 * alternative for exactly this case. `Load` is the fallback.
 *
 * The version is reported on failure because there is one way to be here that
 * no amount of loading fixes: PowerShell 7 runs on .NET 5+, which dropped WinRT
 * projection entirely, so the assembly does not exist for it to find. That
 * should not happen - `powershell.exe` is always Windows PowerShell 5.1 - but
 * "should not happen" is why the next person gets a version number instead of a
 * mystery.
 *
 * @param {string} prefix - the label the caller's parser expects on the line
 */
function winrtPrelude(prefix) {
  return `
$ErrorActionPreference = 'Stop'
$winrt = $null
try { $winrt = [System.Reflection.Assembly]::LoadWithPartialName('System.Runtime.WindowsRuntime') } catch { }
if (-not $winrt) {
  try { $winrt = [System.Reflection.Assembly]::Load('System.Runtime.WindowsRuntime') } catch { }
}
if (-not $winrt) {
  Write-Output ("${prefix}:Error:System.Runtime.WindowsRuntime could not be loaded (PowerShell " +
    $PSVersionTable.PSVersion + " " + $PSVersionTable.PSEdition + ")")
  exit
}
`;
}

/**
 * PowerShell that asks Windows whether Hello is usable *right now*.
 *
 * `CheckAvailabilityAsync` is a plain static and needs no window, which is why
 * this half can be probed from a script while the prompt cannot. Its result is
 * an enum; only `Available` (0) means a gesture can actually be requested.
 * `DeviceNotPresent`, `NotConfiguredForUser`, `DisabledByPolicy` and
 * `DeviceBusy` are all "no", and each is worth reporting by name because they
 * have completely different fixes.
 */
const WINDOWS_PROBE = `
${winrtPrelude('AVAILABILITY')}
try {
  [void][Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType=WindowsRuntime]
  $task = [Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()
  $method = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0].MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
  $result = $method.Invoke($null, @($task))
  $result.Wait(5000) | Out-Null
  Write-Output ("AVAILABILITY:" + $result.Result.ToString())
} catch {
  Write-Output ("AVAILABILITY:Error:" + $_.Exception.Message)
}
`;

/**
 * Human wording for each availability answer.
 *
 * Named rather than collapsed into "unavailable" because the difference is the
 * difference between "turn Hello on in Settings" and "this machine has no
 * hardware for it", and the user can act on one of those.
 */
const AVAILABILITY_REASON = {
  DeviceNotPresent: 'this machine has no Windows Hello hardware',
  NotConfiguredForUser: 'Windows Hello is not set up for this account',
  DisabledByPolicy: 'Windows Hello is disabled by policy on this machine',
  DeviceBusy: 'the Windows Hello device is busy'
};

/**
 * What presence checking can do on this machine.
 *
 * Cached after the first answer: the probe spawns a process, this is asked
 * whenever Settings renders, and the answer does not change while the browser
 * is running - enrolling a fingerprint is not something that happens mid-session
 * without the user knowing.
 *
 * @returns {Promise<{available:boolean, mechanism:string|null, experimental:boolean, reason:string|null}>}
 */
async function capability() {
  if (cachedCapability) return cachedCapability;

  if (process.platform === 'darwin') {
    const can = typeof systemPreferences.canPromptTouchID === 'function' &&
      systemPreferences.canPromptTouchID();
    cachedCapability = can
      ? { available: true, mechanism: 'Touch ID', experimental: false, reason: null }
      : { available: false, mechanism: null, experimental: false,
          reason: 'Touch ID is not available on this Mac' };
    return cachedCapability;
  }

  if (process.platform === 'win32') {
    const answer = await runPowerShell(WINDOWS_PROBE, PROBE_TIMEOUT_MS);
    const line = /AVAILABILITY:(.+)/.exec(answer || '');
    const value = line ? line[1].trim() : '';

    if (value === 'Available') {
      cachedCapability = {
        available: true,
        mechanism: 'Windows Hello',
        // Said plainly rather than buried: the prompt has never been run.
        experimental: true,
        reason: null
      };
    } else if (value.startsWith('Error:')) {
      cachedCapability = { available: false, mechanism: null, experimental: false,
        reason: `Windows Hello could not be queried: ${value.slice(6).trim()}` };
    } else {
      cachedCapability = { available: false, mechanism: null, experimental: false,
        reason: AVAILABILITY_REASON[value] || 'Windows Hello is not available on this machine' };
    }
    return cachedCapability;
  }

  cachedCapability = { available: false, mechanism: null, experimental: false,
    reason: `this system has no way to confirm it’s you (${({ linux: 'Linux', darwin: 'macOS', win32: 'Windows' })[process.platform] || process.platform})` };
  return cachedCapability;
}

/**
 * The C# shim, compiled on the machine when a prompt is needed.
 *
 * `UserConsentVerifier.RequestVerificationAsync` is a WinRT static that a
 * desktop process cannot call: without a CoreWindow it throws, and the
 * documented route is `IUserConsentVerifierInterop`, a COM interface taking the
 * window handle. There is no PowerShell syntax for a COM interop cast of that
 * shape, so a few lines of C# are compiled with `Add-Type` - which is how
 * Microsoft's own desktop samples do it, and needs no compiler installed
 * because the .NET Framework one ships with Windows.
 *
 * The handle is interpolated as a decimal integer that has already been checked
 * to be a number by the caller, so nothing user-controlled reaches the source.
 */
function windowsPromptScript(hwnd, message) {
  // Only a quote can break out of the C# string literal, and the message is
  // ours rather than the user's - but it is escaped anyway, because "this
  // string is always ours" is the assumption that stops being true later.
  const safeMessage = String(message).replace(/["\\]/g, '').slice(0, 200);
  return `
${winrtPrelude('VERIFY')}
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading.Tasks;
using Windows.Security.Credentials.UI;

public static class DebrowserHello {
  [ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C")]
  [InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
  interface IUserConsentVerifierInterop {
    IAsyncOperation<UserConsentVerificationResult> RequestVerificationForWindowAsync(
      IntPtr appWindow, string message, [In] ref Guid riid);
  }

  public static int Verify(IntPtr hwnd, string message) {
    var factory = (IUserConsentVerifierInterop)(object)
      WindowsRuntimeMarshal.GetActivationFactory(typeof(UserConsentVerifier));
    Guid riid = typeof(IAsyncOperation<UserConsentVerificationResult>).GUID;
    var op = factory.RequestVerificationForWindowAsync(hwnd, message, ref riid);
    var task = op.AsTask();
    task.Wait();
    return (int)task.Result;
  }
}
"@ -ReferencedAssemblies $winrt.Location

  $code = [DebrowserHello]::Verify([IntPtr]${hwnd}, "${safeMessage}")
  Write-Output ("VERIFY:" + $code)
} catch {
  Write-Output ("VERIFY:Error:" + $_.Exception.Message)
}
`;
}

/**
 * Ask the person in front of the machine to prove it is them.
 *
 * @param {string} reason - shown in the system prompt
 * @param {Electron.BaseWindow|null} window - the window the prompt belongs to
 * @returns {Promise<boolean>} true only on an observed success
 */
async function verify(reason, window = null) {
  const cap = await capability();
  if (!cap.available) return false;

  if (process.platform === 'darwin') {
    try {
      await systemPreferences.promptTouchID(reason);
      return true;
    } catch {
      // Cancelled, failed, or unavailable after all. All of them are "no".
      return false;
    }
  }

  if (process.platform === 'win32') {
    let hwnd = 0;
    try {
      const buffer = window && !window.isDestroyed() ? window.getNativeWindowHandle() : null;
      // A 64-bit handle in an 8-byte buffer. Read as a BigInt and passed as
      // decimal: going through Number would lose precision on a high handle,
      // and a wrong handle is a prompt attached to nothing.
      if (buffer && buffer.length >= 8) hwnd = buffer.readBigUInt64LE(0).toString();
      else if (buffer && buffer.length >= 4) hwnd = String(buffer.readUInt32LE(0));
    } catch {
      return false;
    }
    if (!/^\d+$/.test(String(hwnd)) || String(hwnd) === '0') return false;

    const answer = await runPowerShell(windowsPromptScript(hwnd, reason), PROMPT_TIMEOUT_MS);
    // 0 is Verified. Every other code - DeviceNotPresent, RetriesExhausted,
    // Canceled - is a refusal, and so is no answer at all.
    return /VERIFY:0\s*$/m.test(String(answer || ''));
  }

  return false;
}

/**
 * Run a PowerShell script and return its stdout, or null.
 *
 * `-NoProfile` because a user profile script can print anything it likes into
 * stdout and this parses stdout. `-NonInteractive` so a script that decides to
 * ask a question fails rather than hanging until the timeout.
 */
function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }

    let out = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (out.length > 64 * 1024) finish(out);   // never grow without bound
    });
    child.stdout.on('error', () => finish(null));
    child.stderr.on('error', () => { /* ignored; stdout carries the answer */ });
    child.on('error', () => finish(null));
    child.on('close', () => finish(out));
  });
}

/** Test seam: forget the cached answer. */
function reset() {
  cachedCapability = null;
}

module.exports = { capability, verify, reset };
