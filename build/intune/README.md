# Deploying Debrowser with Microsoft Intune

> ## Experimental, and unsigned
>
> **This has never been run against a real Intune tenant.** It was written on
> Linux, in a container with no Windows, no Intune, and no way to test any of
> it. The commands and detection rules below are derived from how the Intune
> Management Extension is documented to behave, not from a deployment anyone
> watched succeed. Treat it as a starting point for someone who can test it,
> not as a supported path.
>
> **The build is not code-signed.** In a managed estate that is usually the
> blocker rather than anything here: WDAC, Smart App Control or AppLocker will
> refuse an unsigned binary installed by SYSTEM, and no amount of packaging
> works around that. If your tenant enforces any of those, sign the build
> first — see `docs/PACKAGING.md`.
>
> Pilot it on a test device in a test group. Do not push it to a ring that
> matters.

## What is different about the Intune build

`Debrowser-<version>-win-x64-intune.exe` is the same browser, packaged
differently in exactly two ways that the Intune Management Extension requires:

| | Normal installer | Intune installer |
|---|---|---|
| Scope | Per user, into `%LOCALAPPDATA%` | **Per machine**, into `Program Files` |
| Interaction | Assisted — shows its UI, asks where to install | **Silent** — no UI at all |

Both follow from the same fact: **the IME runs install commands as SYSTEM**. A
per-user installer run as SYSTEM installs into SYSTEM's own profile, where no
real user will ever find it, and an installer that waits for someone to click
Next never finishes because nobody is there to click it.

## The app knows it is managed

A machine-wide install cannot write to its own directory as an ordinary user,
so **the built-in updater turns itself off** and says so in Settings:

> installed for all users — updates are handled by whoever deployed it

That is deliberate. In a managed estate the update schedule belongs to whoever
runs the estate, and a browser quietly replacing itself from GitHub is the
opposite of what the deployment is for. Ship new versions as new Intune app
revisions.

Nothing else changes. Settings, the browsing session and saved credentials
still live in each user's own `userData`, so they are per-user, they survive an
upgrade, and one user cannot read another's.

## Where to get the `.intunewin`

**It is not in the normal releases.** Deploying a browser through Intune is a
narrow case, and a release aimed at people installing Debrowser on their own
machine has no reason to carry an artifact none of them can use — the Intune
installer needs SYSTEM, so a person cannot run it even with admin rights.

It is built on demand by the `Intune package` workflow and published as a
**pre-release**, tagged like `v1.2.1-intune-only`. Pre-releases are never
GitHub's "latest", so nobody lands on one by accident.

Keeping it off the release path also keeps the release path independent of
Microsoft's Win32 Content Prep Tool, which has to be fetched and hash-checked to
build a bundle at all. On the shared path, an upstream file moving would have
failed every platform's release over an artifact none of them contain.

**Download `Debrowser-<version>-win-x64-intune.intunewin` from that pre-release
and upload it.** There is nothing to build.

That file is what Intune deploys. A `.intunewin` is a bundle holding the
installer encrypted with AES alongside a `Detection.xml` the service reads on
upload and the Intune Management Extension decrypts on the device; a bare `.exe`
has none of that and the portal rejects it. Releases up to and including 1.2.0
shipped only the `.exe`, which could not be deployed at all.

It is produced in CI by Microsoft's
[Win32 Content Prep Tool](https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool),
pinned to a commit and checked against a known SHA-256 before it runs. That tool
is the only thing that produces the format — the encryption and the metadata are
an undocumented contract with the service, so a reimplementation would produce a
file that uploads cleanly and fails on a device.

The `.exe` ships beside it. You need it to install by hand on a pilot device,
because the copy inside the bundle is encrypted and cannot be run from it.

Every release is opened before it is published. `tools/verify-intunewin.py`
verifies the payload's HMAC, decrypts it with the keys from `Detection.xml`, and
confirms the installer named by the metadata is really inside — which is the
only way to tell, since the payload is encrypted and a bundle containing nothing
looks entirely healthy from the outside. It runs on the release job and blocks
publication. You can run it yourself on anything you download:

```
python3 tools/verify-intunewin.py Debrowser-1.2.1-win-x64-intune.intunewin
```

To rebuild the bundle yourself, on Windows, with only that installer in
`.\payload`:

```
IntuneWinAppUtil.exe -c .\payload -s Debrowser-1.2.1-win-x64-intune.exe -o .\out
```

The source folder must contain **only** the installer: the tool bundles the
whole folder, so pointing it at a build directory wraps every other installer
in there — including the per-user build, which must never reach a device this
way.

### It will not build on Linux, and the reason is not the runtime

`IntuneWinAppUtil.exe` is a managed .NET assembly rather than native code, so
running it off Windows is ordinary use and very nearly works. Two runtimes were
tried, and both fail at the same instruction:

| Runtime | Windows path semantics? | Result |
|---|---|---|
| Mono 6.8 + `WindowsBase` | no | `NullReferenceException` in `ZipUtil.CreateFromDirectory` |
| .NET 8.0.31 + `System.IO.Packaging` 8.0.0 from NuGet | no | the same exception, same method |
| wine-mono 11.0 under Wine 11 (win64 prefix) | **yes** | the same exception, same method |

The tool zips through `System.IO.Packaging`, so the first theory is that Mono's
implementation of it is incomplete. Row two kills that: on .NET 8, with
Microsoft's own supported cross-platform package supplying the namespace, it
fails identically. The next theory is that the tool builds its part URIs with
Windows path separators. Row three kills that too — under Wine the code sees
`C:\…` paths and backslashes throughout, and still fails in the same place.

What the three have in common is not the operating system and not the path
shape: it is that none of them is **.NET Framework's** `WindowsBase`. The tool
depends on some behaviour specific to that implementation, which neither Mono
nor Microsoft's own .NET Core port of `System.IO.Packaging` reproduces.

Running it needs no more than a `runtimeconfig.json` beside a copy and that one
package — the binary is never modified:

```
dotnet IntuneWinAppUtil.exe -c payload -s setup.exe -o out -q
  System.NullReferenceException
    at …ZipUtil.CreateFromDirectory(String, String, CompressionOption, Boolean, ReportProgress)
```

**The failure is quiet, which is the part worth remembering.** A `.intunewin`
appears in the output folder, correctly named, holding **zero bytes**. Any build
script that checks only whether the file exists will publish nothing and call it
a success, so `.github/actions/intunewin` asserts a plausible size instead.

That leaves exactly one untried configuration: **Wine with a genuine .NET
Framework**, which is the only way to get the real `WindowsBase` outside Windows.
It was not reachable here, and the reason is worth recording so the next attempt
starts further along.

Wine itself is fine — 64-bit is required, since the tool is PE32+ and a 32-bit
prefix reports only `Bad EXE format`. The .NET Framework installer, however, is
32-bit, so the prefix needs its WoW64 half, and on Ubuntu 24.04 that is where it
stops: WineHQ's `wine-stable` depends on an i386 chain that reaches `libgd3:i386`,
which Ubuntu no longer publishes for i386, so the package cannot install. Merging
the i386 libraries in by hand does not work either — the `wine-stable-i386`
package ships `wine-preloader` but not the 32-bit loader, and with those
directories present Wine fails to load `kernel32.dll` at all. Removing them again
restores a working 64-bit prefix, which is how that was confirmed rather than
assumed.

A distribution that still carries a full i386 archive would not hit this.

### There is a Linux packager, and it works

[LetsGoIntunePackager](https://github.com/michelbragaguimaraes/LetsGoIntunePackager)
(MIT) implements the format in Go, so it runs natively and needs neither Wine
nor .NET. It built this release's installer into a bundle **in 3.2 seconds**,
and that bundle passes every check in `tools/verify-intunewin.py` — the same
checks Microsoft's own output passes, including the HMAC and a full decrypt to
the installer inside.

Its metadata is not quite byte-faithful. `Name` drops the `.exe` that Microsoft's
tool keeps, and `ToolVersion` reports `1.8.6.0`, which is not the version it is.
Both look harmless and neither has been tested against a tenant.

**CI still uses Microsoft's tool**, and not out of caution alone: the Intune job
has to run on a Windows runner regardless, because that is where electron-builder
builds the installer. Packaging there costs nothing extra, so the Go tool would
buy no runner and only add a third-party implementation between this project and
an undocumented service contract. Where it is genuinely useful is locally — it is
the only way to produce a bundle off Windows for inspection.

Patching the tool would presumably fix it and is not an option: Microsoft's
licence prohibits decompiling and disassembling it (§4b) and working around
technical limitations in it (§4a).

## App settings in Intune

**Install command**

```
Debrowser-1.2.1-win-x64-intune.exe /S
```

**Uninstall command**

```
"C:\Program Files\Debrowser\Uninstall Debrowser.exe" /S
```

**Install behaviour:** System.
**Device restart behaviour:** No specific action.

### Detection rule

Use a file rule rather than a registry one — it is simpler and does not depend
on the uninstall key's GUID, which changes between electron-builder versions:

| Field | Value |
|---|---|
| Rule type | File |
| Path | `C:\Program Files\Debrowser` |
| File | `Debrowser.exe` |
| Detection method | String (version) |
| Operator | Greater than or equal to |
| Value | `1.2.1` |

Use the *version* comparison rather than "file exists", or the first upgrade
will detect the old build as already installed and never deploy.

### Requirements

- 64-bit Windows 10 1809 or later.
- Roughly 400 MB free, which is the unpacked size rather than the download.

## If it fails

The IME log is the first place to look:

```
C:\ProgramData\Microsoft\IntuneManagementExtension\Logs\IntuneManagementExtension.log
```

Known-plausible failures, in the order they are worth checking:

- **Exit code 1 immediately, nothing installed.** Usually WDAC, Smart App
  Control or AppLocker refusing an unsigned binary. Check the CodeIntegrity
  event log. Signing is the only real fix.
- **Reported as installed, but no user can launch it.** The per-user installer
  was deployed instead of this one, and it landed in SYSTEM's profile. Confirm
  the artifact name ends in `-intune.exe`.
- **Upgrades never apply.** The detection rule is on file existence rather than
  version.
- **Every user gets a fresh browser with no settings.** Expected, and not a
  fault: `userData` is per user by design.

## Verifying a deployment

The installed build can test itself, which is worth doing once on a pilot
device before trusting it anywhere:

```
"C:\Program Files\Debrowser\Debrowser.exe" --smoke-test
```

It runs the full suite against its own renderers and exits non-zero on failure.
