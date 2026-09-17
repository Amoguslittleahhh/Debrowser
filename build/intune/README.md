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

## The `.intunewin` is built for you

**Download `Debrowser-<version>-win-x64-intune.intunewin` from the release and
upload it.** There is nothing to build.

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

To rebuild the bundle yourself, on Windows, with only that installer in
`.\payload`:

```
IntuneWinAppUtil.exe -c .\payload -s Debrowser-1.2.1-win-x64-intune.exe -o .\out
```

The source folder must contain **only** the installer: the tool bundles the
whole folder, so pointing it at a build directory wraps every other installer
in there — including the per-user build, which must never reach a device this
way.

### It will not build on Linux, and it is not worth trying again

`IntuneWinAppUtil.exe` is a managed .NET assembly rather than native code, so
running it under Mono is ordinary use and very nearly works. It does not finish:

```
mono IntuneWinAppUtil.exe -c payload -s setup.exe -o out -q
  INFO  Compressing the source folder 'payload' to '…/IntunePackage.intunewin'
  System.NullReferenceException
    at …ZipUtil.CreateFromDirectory (…System.IO.Packaging.CompressionOption…)
```

The tool zips through `System.IO.Packaging`, from `WindowsBase`. Mono ships that
assembly — without it the run dies earlier, on a `TypeLoadException` — but its
implementation is incomplete, and the packaging call returns null. What lands in
the output folder is a `.intunewin` of **zero bytes**, which is the failure worth
knowing about: the file appears, with the right name, and is empty.

Getting past that would mean decompiling or patching the tool. Microsoft's
licence prohibits both (§4a, §4b), so the bundle is built on a Windows runner in
CI and that is the only supported route. `.github/actions/intunewin` does it.

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
