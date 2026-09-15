# Changelog

## 1.0.0 — first stable release

A complete browser whose governor decides, every two seconds, how much memory
and CPU each tab is allowed to hold. Everything below was measured on real
renderers and real pages; levers that failed measurement were deleted rather
than shipped quiet, and the ones that were deleted are recorded in
`docs/MEASUREMENTS.md` on `claude/research-build`.

### The headline

**45 tabs in 365 MB — 8.1 MB per open tab**, against 822 MB (18.3 MB/tab)
for the same workload with the governor off.

The cost model, fitted across every benchmark run and stable since:

```
total(n) = 238 MB fixed + 0.6 MB × tabs_open + 13.2 MB × min(tabs, live cap)
```

Read every per-tab figure with its tab count. The fixed 238 MB is Electron's,
amortised across whatever is open, so per-tab memory *improves* as you open
more — and below about 25 tabs nothing can reach 10 MB/tab, because the fixed
cost alone exceeds it. The 13.2 MB is Chromium's per-renderer floor and does
not move; the win is residency, not smaller renderers.

### What it does

- **Six tiers.** `ACTIVE → WARM → COLD → FROZEN → HIBERNATED → DISCARDED`,
  driven by idle time and memory pressure.
- **Invisible discard.** A tab past the live-renderer cap is discarded but
  stays open, keeping history, scroll and typed input, and returns behind a
  thumbnail of how you left it. p95 to placeholder is well inside the 50 ms
  budget; restore p50 is ~5 ms.
- **Hibernation** (Linux, with zram or swap and `CAP_SYS_NICE`). Freeze, then
  hand the renderer's cold pages to the OS compressor. Nothing is lost and
  there is no reload. On a 12-tab heavy-heap workload: **1409 MB → 481 MB**,
  seven tabs hibernated, nothing discarded, `MemAvailable` up 435 MB.
- **Animation-aware boosting.** A page that animates gets the CPU to hold its
  frame rate and gives it back when it stops; everything expensive in the
  browser stands down while it does.
- **Protections that always win.** The visible tab, audio, typed input, a tab
  you just left, and a tab already at its floor.

### Measured, and kept honest

- **Proportional (PSS) accounting, not summed RSS.** Summing RSS counts one
  copy of Chromium per renderer and overstated this project's own figures by
  3x before it was corrected.
- **Zygotes counted.** `getAppMetrics()` omits Chromium's two Linux zygotes
  (~29 MB of fixed overhead); they are added back.
- **A system-wide figure beside every per-process one.** Pages leaving a
  process reappear as the compressor's own allocation at about 2:1, so a
  per-process reading alone overstates a trim by roughly double. The bench
  prints both and the ratio.
- **Capabilities report why, not just no.** "Not built", "not executable",
  "needs `CAP_SYS_NICE`" and "no swap to compress into" are four distinct
  messages, because a user who cannot tell which one they have cannot fix it.

### Known limits

- Restore replays navigation, scroll and unsubmitted input — not in-page
  JavaScript state. That is why typed input is protected from discard rather
  than restored from it.
- Password and payment fields are never read into the session store, and a
  page carrying one is never photographed for a thumbnail.
- Per-tab CPU is exact only when a tab owns its renderer; with one-renderer-
  per-site, a busy Web Worker in a shared renderer is not a freeze trigger.
- `minimal` profile disables site isolation. That is a security setting. It
  warns on every launch.
- No extensions, bookmarks, history UI or downloads UI.
- Windows and macOS hibernation backends are deliberately **not** implemented
  rather than written untested. `trimCapability()` reports
  `available: false` with the reason.

### Installers

- **Installers for all three platforms.** Windows gets an NSIS installer and a
  portable single-file `.exe`; macOS gets `.dmg` and `.zip` for both Intel and
  Apple silicon; Linux gets AppImage, `.deb` and `.tar.gz`. Configured in
  `electron-builder.yml`, built per-platform on native runners by
  `.github/workflows/release.yml`, which runs the 41-check suite on each
  platform *before* packaging it.
- **The trim helper could never have worked in a packaged build.** It was
  resolved relative to `__dirname`, which lands inside `app.asar` — and a binary
  inside an asar archive cannot be executed, because the archive is one file the
  runtime reads rather than a directory the kernel can exec from. Every
  installed copy would have reported "mem-trim not built" forever, quoting a
  build command that does not apply to an installed app. It now ships beside the
  app and is found there.
- **That "not built" message is now audience-aware**, since telling someone with
  an installed build to run an npm script in a source tree they do not have is
  the same class of wrong answer as the `setcap` misdiagnosis this release also fixes.
- **Packaged builds can verify themselves.** `--smoke-test` works from an
  install, because 12KB of fixture HTML ships in the asar. The project is tested
  on Linux and only expected to work elsewhere, so the means to check travels
  with it. The first packaged build failed seven checks by serving 404s with the
  fixtures excluded — including one that looked like a privacy regression and
  was not.
- The Linux-only trim helper no longer ships inside the Windows installer.

Nothing is signed, but the build is now wired for it: set `CSC_LINK` and
`CSC_KEY_PASSWORD` (or the Azure Trusted Signing secrets) and the release
workflow signs, with no code or config change — an empty value means "no
certificate", so a fork with no secrets still builds unsigned. Signatures are
RFC3161-timestamped and SHA-256 only, and the workflow prints the signature
status of every `.exe` before uploading, so a release that is quietly unsigned
because a secret expired does not get past CI.

`docs/PACKAGING.md` covers getting a certificate, and is worth reading before
buying one: since 2023 no CA will sell a downloadable `.pfx`, and an OV
certificate does not stop the SmartScreen warning by itself — only EV or Azure
Trusted Signing clear it from the first release. It also records what
cross-building can and cannot do (the Windows installer needs Wine *including*
32-bit; the macOS `.dmg` cannot be built off macOS; and electron-builder cannot
sign a Windows binary from Linux at all, because its vendored `osslsigncode`
links against an OpenSSL no current distro ships).

### Verification

`npm run smoke` — 41 checks against real renderers and measured memory, all
green. `npm run bench` for the memory comparison. A packaged build can run the
same suite against itself with `--smoke-test`.
