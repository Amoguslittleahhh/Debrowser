# Packaging

Installers are built by [electron-builder](https://www.electron.build/), configured
in `electron-builder.yml`. Every non-obvious line in that file has a comment
saying why; this document covers the things that are about the *process* rather
than the config.

## Building

```bash
npm ci
npm run dist:linux     # AppImage + .deb + .tar.gz  (builds the trim helper first)
npm run dist:win       # NSIS installer + portable .exe
npm run dist:mac       # .dmg + .zip  — macOS only, see below
npm run dist           # whatever the host can do
npm run pack           # unpacked tree only, for a quick look
```

Output lands in `dist/`.

## What each platform gets

| Platform | Artifact | Notes |
|---|---|---|
| Windows | `Debrowser-1.0.0-win-x64.exe` | NSIS installer, per-user (no UAC prompt) |
| Windows | `Debrowser-1.0.0-win-x64-portable.exe` | Single file, runs from anywhere, installs nothing |
| macOS | `Debrowser-1.0.0-mac-{x64,arm64}.dmg` | Needs a macOS host to build |
| macOS | `Debrowser-1.0.0-mac-{x64,arm64}.zip` | Unzip, drag to Applications |
| Linux | `Debrowser-1.0.0-linux-x86_64.AppImage` | `chmod +x`, run. No install. |
| Linux | `Debrowser-1.0.0-linux-amd64.deb` | Debian/Ubuntu. Installs to `/opt/Debrowser`. |
| Linux | `Debrowser-1.0.0-linux-x64.tar.gz` | Extract and run |

## Cross-building, and where it stops

Building for a platform you are not on works partway, and the boundaries are
worth knowing before you plan a release around them.

| Building | on Linux | on macOS | on Windows |
|---|---|---|---|
| Linux artifacts | yes | partial | no |
| Windows `.exe` | **yes, with Wine** | with Wine | yes |
| macOS `.zip` | yes (unsigned) | yes | no |
| macOS `.dmg` | **no** | yes | no |

Two hard stops, both discovered by hitting them:

- **The Windows NSIS installer needs Wine, including 32-bit support.** The
  installer *stub* is a 32-bit executable — deliberately, so it runs on any
  Windows — and electron-builder executes it once during the build to generate
  the uninstaller. On Debian/Ubuntu that means `wine64` is not enough:

  ```bash
  sudo dpkg --add-architecture i386
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends wine64 wine32:i386
  ```

  Without the 32-bit half the build fails with
  `failed to load L"\\??\\C:\\windows\\syswow64\\ntdll.dll"`, which does not
  obviously mean "install wine32".

- **The macOS `.dmg` cannot be built off macOS.** It needs `hdiutil` and `sips`,
  which only exist there. The `.zip` *does* build on Linux and contains the same
  `.app`, so use `npx electron-builder --mac zip` on Linux — asking for the
  default target set gets you both zips and then an error on the dmg.

The way around all of this is `.github/workflows/release.yml`, which builds each
platform on its own runner. That is the only path that produces a real dmg, and
the only one that can ever sign or notarize.

## Signing — none of it is signed

This matters to whoever runs the result, so it is stated rather than buried.

- **Windows.** No code-signing certificate, so SmartScreen shows
  "Windows protected your PC" on first run. More Info → Run anyway. The warning
  is accurate: nothing vouches for this binary. Signing needs an OV or EV
  certificate, set via `CSC_LINK` and `CSC_KEY_PASSWORD`.
- **macOS.** Not signed and not notarized, so Gatekeeper refuses the first
  launch outright. Right-click → Open (once), or
  `xattr -cr /Applications/Debrowser.app`. Proper signing needs an Apple
  Developer account: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. `hardenedRuntime` and the
  entitlements in `build/entitlements.mac.plist` are already configured for it.
- **Linux.** Nothing to sign; the `.deb` is unsigned, which is normal outside a
  repository.

An unsigned macOS build produced *on Linux* is doubly worth flagging: it has
never been through `codesign` at all, so it is strictly for trying the app, not
for distributing to anyone else.

## Hibernation in a packaged build

The `HIBERNATED` tier needs `tools/mem-trim`, and two things about it change
once the app is packaged.

**It cannot live inside `app.asar`.** An asar archive is a single file the
runtime reads, not a directory the kernel can exec from, so the helper is copied
to the app's resources directory instead and `helperPath()` in
`src/main/platform.js` looks for it there. Getting this wrong does not crash
anything — it reports "mem-trim not built" in every installed copy forever,
with a build instruction that does not apply to an installed app.

**Which Linux format you install decides whether hibernation can work at all:**

| Format | Hibernation | Why |
|---|---|---|
| `.deb` | yes, after one command | The helper lands at a real path that `setcap` can be applied to |
| `.tar.gz` | yes, after one command | Same |
| AppImage | **no** | The helper lives inside a read-only mount; a file capability cannot be set on it |

For the `.deb`:

```bash
sudo setcap cap_sys_nice+ep /opt/Debrowser/resources/tools/mem-trim
```

It also needs somewhere to compress into — zram or swap. With neither, the
kernel accepts `MADV_PAGEOUT` and reclaims nothing. The task manager reports
which of the two is missing by name; see the README.

The C source ships next to the binary in every Linux package, so anyone can read
or rebuild the thing they are about to grant `CAP_SYS_NICE` to.

## Verifying a build

Every packaged build can run the full suite against its own renderers:

```bash
# Windows
Debrowser.exe --smoke-test
# macOS
/Applications/Debrowser.app/Contents/MacOS/Debrowser --smoke-test
# Linux
/opt/Debrowser/debrowser --smoke-test
```

41 checks, on real pages, in the build that will actually run. This is why 12KB
of test fixtures ships inside the asar: the project is tested on Linux and only
*expected* to work elsewhere, so the means to check has to travel with it.

It is also not theoretical. The first packaged build here failed seven checks
because the fixtures had been excluded and the fixture server was returning
404s — one of those failures looked exactly like a privacy regression (a
password page being screenshotted) and was not.

## Release process

1. Bump `version` in `package.json`, update `CHANGELOG.md`.
2. Commit, tag `vX.Y.Z`, push the tag.
3. `.github/workflows/release.yml` builds all three platforms on native
   runners, runs the smoke suite on each **before** packaging, and attaches
   everything to a **draft** release.
4. Check the draft, then publish.

The workflow can also be run by hand from the Actions tab
(`workflow_dispatch`), which builds and uploads the artifacts without creating
a release — useful for testing a build on a platform you do not own.
