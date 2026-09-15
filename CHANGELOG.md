# Changelog

## 1.1.0

The chrome rebuilt to Chrome's layout, and a settings page.

- **The window's own title bar and the File/Edit/View/Window menu are gone.**
  That menu was Electron's default, not anything this browser defines — there
  was no File to open and no Window to manage — and it sat above the tabs
  spending a row of screen on a name the user already knows. The tab strip is
  the title bar now, as in every modern browser. The system still draws the real
  minimise/maximise/close buttons over it, so snap layouts, double-click-to-
  maximise and the accessibility behaviour that comes with them all still work;
  the strip keeps clear of them through `env(titlebar-area-*)` rather than a
  hard-coded inset, which would be wrong on one platform or the other.
- **The new-tab button follows the last tab** instead of sitting against the far
  right edge with a gulf of empty strip in between. The old rule made the tab
  container claim the whole strip; it now hugs its tabs, and hands the overflow
  back so tabs shrink rather than pushing the + off-screen.
- **Back and forward grey out** when there is nowhere to go, and the reload
  button becomes a stop button while a page loads — as a swapped icon path,
  since the old code wrote text into a button that now holds an SVG and would
  have deleted the icon on the first load.
- **A settings page**, reached from the three-dot menu or Ctrl+,. Theme (system,
  light or dark, with an explicit choice beating the OS in both directions),
  accent colour, tab width, whether the memory meter and the tier dots are
  shown, search engine, new-tab page, and the two resource limits — memory
  budget and how many tabs may hold a renderer. Preferences live in `userData`,
  which an update does not touch, and every value is validated against one
  schema that guards both the settings page and the file on disk, because that
  file reaches the governor and the Chromium command line.
- **Empty is not zero.** Clearing a resource limit means "size it to this
  machine" and returns to the automatic value; `0` for the tab cap means "no
  cap". A value pinned on the command line outranks anything saved, which is
  what the code claimed and did not do.
- **No settings that do nothing.** Session restore, automatic updates and the
  resource profile were drafted and cut: the first two are not built, and the
  third cannot take effect without a restart.
- The palette lived in three copies across the chrome, the panel and settings,
  and had already drifted — the panel's light background was a different grey
  for no reason anyone chose. It is one file now, and the theme choice reaches
  the task manager as a result.

Verification: 43 checks, all green, including four new ones — that settings
never becomes a governed tab, that the schema refuses values outside it, that
clearing a limit returns to the automatic value while a pinned flag outranks a
saved one, and that the menu builds from live state.

## 1.0.1

Two Windows reporting-and-rendering bugs, both reported from a real install.

- **Minimising the window brought it back empty.** No tab strip, no page, just
  the background colour and the native menu bar. Minimising on Windows fires
  `resize` with a client area of zero, and the layout computed from it,
  flattening every view to zero width — with nothing to restore them afterwards.
  `layout()` now refuses to compute from a minimised or zero-sized window, and
  `restore`/`show` re-run it and re-assert view visibility. Confirmed against
  the old code, which flattened the chrome from 1280px to 0; the new code holds
  it. Covered by a smoke check, since the failure cannot be reproduced under
  xvfb where there is no window manager and `minimize()` is a no-op.
- **The memory figure over-counts off Linux, and did not say so.** Windows and
  macOS have no cheap proportional measure, so the total is summed working set,
  which counts each page shared between processes — chiefly one copy of
  Chromium in each — once per process. Measured at **1.95x** the proportional
  figure across five processes, rising with process count: two open tabs could
  read as 1098 MB. The panel now labels it "resident (over-counts)" there,
  explains it on hover, and notes that the budget is compared against the same
  inflated total so the governor reclaims earlier than it needs to. No better
  number is available — Electron's `ProcessMemoryInfo` declares `private` and
  `shared`, but `getAppMetrics()` populates only `workingSetSize`.

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
