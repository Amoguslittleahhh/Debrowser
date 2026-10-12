# Packaging

Installers are built by [electron-builder](https://www.electron.build/), configured
in `electron-builder.yml`. Every non-obvious line in that file has a comment
saying why; this document covers the things that are about the *process* rather
than the config.

## Building

```bash
npm ci
npm run dist:linux     # AppImage + .deb + .rpm  (builds the trim helper first; .rpm needs rpmbuild)
npm run dist:win       # NSIS installer
npm run dist:mac       # .dmg + .zip  — macOS only, see below
npm run dist           # whatever the host can do
npm run pack           # unpacked tree only, for a quick look
```

Output lands in `dist/`.

## What each platform gets

| Platform | Artifact | Notes |
|---|---|---|
| Windows | `Debrowser-Windows-Setup.exe` | NSIS installer, per-user (no UAC prompt) |
| macOS | `Debrowser-macOS-{x64,arm64}.dmg` | Needs a macOS host to build |
| macOS | `Debrowser-macOS-{x64,arm64}.zip` | What updates install from; "arm64" in the name is how the updater tells them apart |
| Linux | `Debrowser-Linux.AppImage` | `chmod +x`, run. Offers to add itself to the apps menu, or to install the package below for the system it is on |
| Linux | `Debrowser-Linux.deb` | Debian, Ubuntu, Mint. Installs to `/opt/Debrowser` |
| Linux | `Debrowser-Linux.rpm` | Fedora, RHEL, openSUSE. Installs to `/opt/Debrowser` |

Names carry the system, not the version, so a release lists one obvious file
per system and `releases/latest/download/<name>` never goes stale; the list
lives in `src/main/setup/downloads.json`, which the release notes' download
table and the download page (`tools/changelog-site.js`) are built from. The
other files on a release are machinery: `latest*.yml` and the `.blockmap`s for
updates, `InRelease` and `Packages.gz` for apt, `SHA256SUMS.txt` and the SBOM.

## Cross-building, and where it stops

Building for a platform you are not on works partway, and the boundaries are
worth knowing before you plan a release around them.

| Building | on Linux | on macOS | on Windows |
|---|---|---|---|
| Linux artifacts | yes | partial | no |
| Windows `.exe` | **yes, with Wine** | with Wine | yes |
| …signed | **no** (see below) | yes | yes |
| macOS `.zip` | yes (unsigned) | yes | no |
| macOS `.dmg` | **no** | yes | no |

Two hard stops in the table above, both discovered by hitting them:

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

A third, which only bites once you try to sign:

- **electron-builder cannot sign a Windows binary from Linux on a current
  distro.** It ships its own `osslsigncode` inside `winCodeSign-2.6.0`, and that
  binary is linked against `libcrypto.so.1.1` — OpenSSL 1.1, which Ubuntu 24.04
  and every other current distro replaced with OpenSSL 3. The build gets as far
  as `signing file=…` and then dies with

  ```
  osslsigncode: error while loading shared libraries: libcrypto.so.1.1
  ```

  Signing on Windows (`signtool.exe`) and in CI on `windows-latest` is
  unaffected. If you really need to sign from Linux, build unsigned and then
  sign the finished `.exe` with the distro's own `osslsigncode`, which works
  fine — that is how the self-signed demonstration further down was produced.

The way around all of this is `.github/workflows/release.yml`, which builds each
platform on its own runner. That is the only path that produces a real dmg, and
the only one that can ever sign or notarize.

## Signing the Windows build

Builds are unsigned by default. The repository is wired so that supplying
credentials is the *only* step — nothing in the config or the workflow needs
editing — but the credentials themselves are the hard part, and the landscape
changed in a way that makes most older advice wrong.

### What you cannot do any more

**You cannot buy a code-signing certificate and download a `.pfx`.** Since June
2023 the CA/Browser Forum has required the private key for any publicly-trusted
code-signing certificate to live on certified hardware — a FIPS 140-2 Level 2
token, or a CA's cloud HSM. Every "buy a cert, export a .pfx, set `CSC_LINK`"
tutorial written before then describes something no CA will sell you now.

So the file-based path below is real, but only for a certificate you already
hold, an internal CA, or a self-signed certificate. New certificates arrive
either on a USB token posted to you or behind a cloud signing API.

### Signing does not immediately stop the SmartScreen warning

Worth internalising before spending money, because it surprises people who have
just paid. SmartScreen trusts *reputation*, not signatures:

| | Cost | SmartScreen |
|---|---|---|
| Unsigned | — | Warns, forever |
| **OV** certificate | ~$200–400/yr | Still warns at first. Reputation accrues over downloads and time. |
| **EV** certificate | ~$300–600/yr | Clean from the first release |
| **Azure Trusted Signing** | ~$10/month | Clean from the first release |

An OV certificate buys a publisher name in the dialog and a reputation clock
that starts ticking. It does not buy a clean first run. If the point of signing
is that your users stop seeing the scary dialog, OV is not the thing to buy.

### What to actually get

**For an individual: Azure Trusted Signing.** It is Microsoft's own service, it
is priced per month rather than per year, it signs through an API so there is no
USB token to keep plugged into a build machine, and — the part that matters —
it validates *individuals*, not just registered companies. Identity verification
requires a history (roughly three years of verifiable identity) and takes some
days. EV certificates from a traditional CA generally require a legal business
entity with a D-U-N-S number, which is the wall most solo developers hit.

**For a company:** an EV certificate from a traditional CA is the conventional
answer and gives the same clean first run.

### Turning it on

Neither path needs a code change. Set repository secrets and the existing
workflow signs.

**Azure Trusted Signing** — secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET` (from an Azure AD app registration granted the *Trusted
Signing Certificate Profile Signer* role), plus repository **variables**
`AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`. The workflow
switches to the Azure step automatically once `AZURE_CLIENT_ID` exists.

**A certificate file** — secrets `WINDOWS_CERT_BASE64` (the `.pfx`, base64
encoded) and `WINDOWS_CERT_PASSWORD`. The workflow passes the first as
`WIN_CSC_LINK` rather than `CSC_LINK`, which matters more than it looks: an
empty `CSC_LINK` is *not* treated as "no certificate" on macOS — electron-builder
resolves it as a path and fails with `not a file` — so setting it for every
platform breaks the macOS build on a repository that has no certificate at all.
`WIN_CSC_LINK` is read only by the Windows signer.

```bash
base64 -w0 certificate.pfx    # paste the output as the secret
```

Locally, the same thing without CI:

```bash
export WIN_CSC_LINK=/path/to/certificate.pfx   # or its base64
export CSC_KEY_PASSWORD='…'
npm run dist:win
```

An empty value is treated as "no certificate", so a fork with no secrets still
builds — unsigned, exactly as before.

### Check that it worked

The workflow prints the signature status of every `.exe` before uploading,
because a release that is quietly unsigned (an expired secret, a typo'd
variable) is the failure worth catching. By hand, on Windows:

```powershell
Get-AuthenticodeSignature .\Debrowser-1.0.0-win-x64.exe | Format-List
```

`Status: Valid` is what you want. `NotSigned` means the credentials never
reached electron-builder; `UnknownError` usually means the chain does not
terminate in a trusted root — which is what a self-signed certificate looks
like.

Anywhere, including Linux:

```bash
osslsigncode verify Debrowser-1.0.0-win-x64.exe
```

### Self-signed certificates

You can make one in a minute, and it will produce a technically valid signature:

```bash
openssl req -x509 -newkey rsa:3072 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/CN=Your Name/O=Your Org/C=US" \
  -addext "keyUsage=digitalSignature" -addext "extendedKeyUsage=codeSigning"
openssl pkcs12 -export -out cert.pfx -inkey key.pem -in cert.pem -passout pass:…
```

This was done against `Debrowser-1.0.0-win-x64.exe` while writing this page. The
result verified cleanly on every count that does not involve a CA — SHA-256
digest matched, a genuine RFC3161 countersignature came back from DigiCert's
timestamp authority — and then failed with exactly one error:

```
Verify error: self-signed certificate
Signature verification: failed
```

Which is the whole story. **Signing is free; trust is the thing that costs
money.** A self-signed certificate is useful for testing the pipeline, and for
internal distribution where you can install the certificate into Trusted Root on
the target machines. For anyone else's computer it changes nothing — SmartScreen
will warn exactly as it does now.

### Timestamping

Already configured (`rfc3161TimeStampServer` in `electron-builder.yml`) and
worth knowing about: a signature without a timestamp stops validating the day
the certificate expires. With one, Windows keeps trusting binaries signed while
the certificate was valid. For a release you are not going to re-cut, that is
the difference between "still works in three years" and "silently unsigned".

## Signing on the other platforms

- **macOS.** Not signed and not notarized, so Gatekeeper refuses the first
  launch outright. Right-click → Open (once), or
  `xattr -cr /Applications/Debrowser.app`. Proper signing needs an Apple
  Developer account ($99/yr): `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. `hardenedRuntime` and the
  entitlements in `build/entitlements.mac.plist` are already configured for it.
  Unlike Windows, there is no reputation clock — notarizing works immediately.
- **Linux.** Signed with one key of the project's own (free, made once; see
  below). The `.rpm` is signed itself, because dnf and zypper check package
  signatures. The `.deb` is not - nothing on Ubuntu checks a downloaded `.deb`'s
  signature, and App Center warns "Potentially unsafe" about every package from
  outside its store, Chrome's included - so what is signed there is the apt
  repository, which is what checks every update.

### The Linux repositories

Each package's install script adds a repository, so updates arrive with the
rest of the system's and the package manager refuses any not signed by the key
the package carries (`/usr/share/debrowser/archive-keyring.asc`). Betas are never
"latest", so they are in neither.

- **apt** (Debian, Ubuntu, Mint, Pop!_OS, elementary): every stable release
  carries a signed index of its own `.deb` (`InRelease`, `Release`,
  `Release.gpg`, `Packages`, `Packages.gz`). The source points at
  `releases/latest/download/`, which GitHub redirects to the newest stable
  release's files, so the repository is always that release.
- **dnf and zypper** (Fedora, RHEL and its rebuilds, openSUSE): a signed index
  (`repodata/`, with `repomd.xml.asc`) on the project's GitHub Pages site at
  `/rpm/`, rebuilt by `pages.yml` from the newest release, its entries pointing
  at that release's `.rpm`. Pages rather than the release, because dnf wants a
  `repodata/` folder and a release's files cannot be in folders.

No server, nothing to host, nothing to pay for. Until there is a key, nothing
changes: the packages are not signed, there are no indexes, and the packages add
no repository. Turning it on, once, on any Linux machine (free; the key never
expires unless you choose otherwise):

```sh
gpg --batch --passphrase '' --quick-gen-key "Debrowser packages" rsa4096 sign never
gpg --armor --export-secret-keys "Debrowser packages"   # → the LINUX_SIGNING_KEY secret
gpg --armor --export "Debrowser packages" > build/linux/archive-keyring.asc   # → commit this
```

RSA rather than ed25519: rpm 4.14 - RHEL 8, openSUSE Leap 15 - cannot check an
ed25519 signature.

1. Settings → Secrets and variables → Actions → New repository secret:
   `LINUX_SIGNING_KEY`, the whole private key block, `-----BEGIN` to `-----END`.
2. Commit `build/linux/archive-keyring.asc` (public; it is what installs check
   against).
3. Keep a copy of the private key somewhere safe and offline. Losing it means a
   new key, and every existing install would need the new one by hand.

The release job refuses to publish if the secret's key is not the committed one,
and the Pages job indexes only packages signed with it. The private key is seen
only by those two jobs, never the build job, which runs dependency install
scripts. Its passphrase is empty because nothing could type one in CI; the
secret store is what protects it.

Removing the repository file (`/etc/apt/sources.list.d/debrowser.sources`,
`/etc/yum.repos.d/debrowser.repo` or `/etc/zypp/repos.d/debrowser.repo`) turns
those updates off for good on that machine; installing again does not add it
back. Uninstalling the package removes it.

Arch and other distributions use the AppImage, which updates itself. On the
systems above, once the repositories are signed, the AppImage offers to install
their package instead (`src/main/setup/linux-system.js`): it downloads this
version's `.deb` or `.rpm`, checks it against the release's `latest-linux.yml`,
installs it through pkexec and the package manager, and starts again from
`/opt/Debrowser`.

### What software centres show

`build/linux/before-pack.js` writes Debrowser's AppStream entry for each build,
twice from one description, into both the `.deb` and the `.rpm`: as installed
metainfo (`/usr/share/metainfo/dev.debrowser.app.metainfo.xml`, read by GNOME
Software and Discover) and as a one-app catalogue (`/usr/share/swcatalog/yaml/debrowser.yml`).
Ubuntu's App Center reads only catalogues, and its page for a catalogue app
takes the publisher from the developer name, the licence from the project
licence and "last updated" from the newest release - so once Debrowser is
installed, App Center lists it under Manage with all three. The icon is
installed at every hicolor size from `build/linux/icons/`
(`electron tools/make-icon.js --linux-only` redraws them). Check the metainfo
with `appstreamcli validate --pedantic`.

A downloaded `.deb` opened in App Center, before it is installed, still shows
the package name (`debrowser` - Debian package names are lowercase only),
"Unknown publisher", licence "unknown" and "last updated Unknown". That page is
built from the file alone, and App Center fills those fields in with fixed
values for every `.deb` (`deb/local_deb_model.dart` in App Center; PackageKit's
apt backend reports every licence as "unknown"). No package contents or
signature changes it. Only the Snap Store gives a downloaded app a named
publisher there.

## Hibernation in a packaged build

The `HIBERNATED` tier needs `native/helpers/mem-trim`, and two things about it change
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
| `.rpm` | yes, after one command | Same |
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

## The macOS smoke gate is advisory

`release.yml` runs the 89-check suite on each platform before packaging it. On
Linux and Windows a failure blocks the build. On macOS it is reported and does
not.

That is a deliberate concession, not an oversight. The suite drives a real
browser and asserts on measured CPU and memory, which makes it timing-sensitive
by construction, and on GitHub's macOS runners it failed intermittently on a
*different* check each run while passing every time on Linux and Windows. Four
distinct causes were found and fixed from its output:

- a tier assertion that waited for `=== COLD` when the tab passes *through* COLD,
  so a 200ms poll could miss it entirely;
- "was this tab quiet?" asked *after* freezing, which zeroes CPU by construction
  and so reports every frozen tab as quiet — including the ones frozen for being
  busy;
- CPU sampled every 150ms when `percentCPUUsage` is a rate computed between
  calls, which returned 0.00% for a page whose worker was plainly spinning;
- an `npm ci` that reported success while Electron's binary never landed.

Every one of those was a real defect in the test, and each fix revealed the next.
None was a defect in the browser — the macOS build packages and runs fine, and
the same suite passes on macOS on many runs. Rather than keep a release blocked
on a gate whose failures are about its own sensitivity to a fast, contended
runner, the macOS leg reports and continues.

Making it blocking again is the fix, and the honest version of "advisory" is
loud: the workflow prints the outcome to the job summary and raises a warning
annotation when it fails, so a silently-degrading macOS build is still visible.

## Release process

1. Bump `version` in `package.json`, and add the section to `CHANGELOG.md`.
   Do **not** hard-wrap that section: it becomes the release body, GitHub
   reflows it, and a wrap landing inside a hyphenated compound renders with a
   stray hyphen. See `CLAUDE.md`.
2. Commit, tag `vX.Y.Z`, push the tag.
3. `.github/workflows/release.yml` builds all three platforms on native
   runners, runs the smoke suite on each **before** packaging, and publishes
   the release with the artifacts attached.

The release body is that version's `## ` section alone, extracted by
`.github/scripts/release-notes.py`, plus a footer crediting the owner and the
bot. Publishing the whole changelog would make every download page repeat the
notes for versions the reader already has.

The workflow can also be run by hand from the Actions tab
(`workflow_dispatch`). With the `tag` input filled in it creates the tag and
the release from the runner, which is the only route available when the tag
cannot be pushed from a workstation — a protected-tag ruleset, or a token
scoped to branches only. Left empty, it builds and uploads artifacts without
creating a release, which is useful for testing a build on a platform you do
not own.

Releases are published, not drafts. That is deliberate rather than an
oversight: `electron-updater` cannot see a draft release, so a draft release is
invisible to every installed copy.

To correct the notes on a release that already exists, run the **Update release
notes** workflow with the version number. It rewrites that release's body and
touches nothing else — no rebuild, no change to the tag, the assets or the
date. Re-running the release workflow against an old tag would attach the
*current* version's installers to it, which is worse than bad prose.

## Deploying with Intune

`build/intune/README.md` covers it, including the `.intunewin` step, the install
and uninstall commands, and the detection rule. Two things belong here as well,
because they are packaging facts rather than deployment ones:

- The Intune artifact is built by a **second electron-builder pass**
  (`npm run dist:intune`), writing to `dist-intune/` so it cannot overwrite
  `dist/latest.yml`. That manifest describes the updatable build, and publishing
  this one's would tell every ordinary install to fetch an installer it cannot
  run. The config is generated from `electron-builder.yml` rather than written
  separately, so the two cannot drift.
- It differs only in being **per-machine and silent**, because the Intune
  Management Extension runs install commands as SYSTEM.

**It is experimental and has never been tested against a real tenant.** It was
written with no access to Windows or Intune.

## Updates

Installed copies update themselves through `electron-updater`, against the
GitHub releases of this repository. The provider is recorded in
`electron-builder.yml` under `publish:`, which is what puts `app-update.yml`
inside the package; without it an installed build has nowhere to look and fails
at runtime on a machine nobody is watching.

**Downloads are differential.** electron-builder writes a `.blockmap` beside
each installer describing its compressed stream in content-defined chunks, so
the updater fetches only the blocks that changed and reuses the rest from the
copy already installed. A full artifact is ~110MB and almost all of it is
Chromium, which does not change between releases.

Both the blockmaps and the `latest*.yml` manifests must reach the release, or
the updater has nothing to read. They are generated into `dist/` automatically;
what was missing for a long time was uploading them, since the workflow's
per-platform `artifacts` globs listed only the installers themselves.

| Target | Updates | Why |
|---|---|---|
| Windows NSIS | yes, differential | blockmap beside the installer |
| Linux AppImage | yes, differential | blockmap embedded in the binary |
| macOS | **no** | Squirrel.Mac validates that the update is signed by the same identity as the running app, and refuses when there is none. This build is unsigned. |
| `.deb`, `.rpm` | through the repository | the package manager owns those files; the apt and dnf/zypper repositories carry the updates |

The first release carrying blockmaps cannot itself be delivered as a delta —
there is no previous blockmap to diff against. Deltas begin with the release
after it.
