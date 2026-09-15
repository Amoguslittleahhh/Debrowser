# Changelog

## Unreleased

Updates that download only what changed.

| | Before | Now |
|---|---|---|
| **Getting a new version** | Re-download the whole ~110MB installer by hand | The browser fetches only the blocks that changed and offers to restart |
| **Your data** | — | Untouched: settings, session and saved data live in `userData`, which an installer does not replace |
| **Release pages** | Blockmaps and update manifests were generated but never uploaded | Both are attached, which is what makes a delta possible at all |

- **Differential downloads.** electron-builder writes a blockmap beside each installer describing its compressed stream in content-defined chunks, so an update fetches only the blocks that differ and reuses the rest from the installed copy. Almost all of a 110MB artifact is Chromium, which does not change between our releases.
- **The plumbing existed and was inert.** Blockmaps and `latest*.yml` manifests were already being generated into `dist/` on every build, but the workflow's per-platform artifact globs listed only the installers, so none of it ever reached a release. An installed copy had nothing to read even if it had known where to look — and it did not, because no `publish:` provider was configured, which is what writes `app-update.yml` into the package.
- **Nothing installs behind your back.** The updater checks a minute after launch rather than during it, downloads in the background, and then asks. It never installs at quit: this installer is assisted rather than one-click, so it puts its own window on screen, and doing that unannounced during a restart nobody chose would lose the session to a surprise.
- **macOS is honestly absent rather than quietly broken.** Squirrel.Mac validates that an update is signed by the same identity as the running app and refuses outright when there is none, so an unsigned build cannot self-update at all. The capability reports that by name, as does the settings page, in the same `{available, reason}` shape the hibernation backend uses — an inert feature that cannot say why is indistinguishable from a broken one. The same applies to `.deb`, `.tar.gz` and the Windows portable build, which are not updatable formats.
- **A switch in Settings.** Off means the browser never reaches the network to look for a version, which is a privacy choice as much as a bandwidth one. It is read live, so turning it off takes effect at the next check rather than the next launch.

- **Settings no longer traps the browser on it.** Opening Settings covered every tab with a view that nothing dismissed, so switching tabs appeared to do nothing and the browser looked frozen on a page with no way out. It was not frozen: it was drawing the page behind a lid with no handle. The fix is not a dismiss call in more places — it is that the browser's own pages are now *pages*, served under a real `debrowser://` scheme, with URLs, titles, tab strip entries, history, and back and forward that work. There is no lid because there is no overlay. Covered by a check that would fail against the old design.
- **A new tab page of our own**, at `debrowser://newtab`, instead of example.com. Deliberately close to empty: it is the most-opened page in the browser, and a start page of tiles and feeds would also be the most expensive one. No network requests at all — no fonts, no favicons, no suggestions — and it shows what the browser is actually for, the current total and the per-tab figure.
- **The browser's own pages are exempt from the governor.** Every tier below ACTIVE is wrong for them: freezing one stops the page servicing the controls being operated, and discarding one throws away a half-filled form and reloads as though the browser had crashed.
- **A privileged page can never become a privileged web page.** Internal pages carry the command bridge in their preload, so a link in Settings that navigated the same renderer to a site would hand that site's JavaScript the run of the browser. Navigation away from `debrowser://` is cancelled and handed to an ordinary tab, which is also what a user wants from a link in Settings. The protocol handler resolves every path and refuses anything outside the directory it serves.
- **Animations wait until the page is on screen.** A view that is not composited has its animation frames throttled hard, so an entrance animation started while a tab is realised in the background is still part-way through when the tab is finally shown — the page arrives half-faded and settles afterwards, which reads as a rendering fault. This browser realises tabs in the background routinely, so that was the common case rather than the odd one. Found by looking at a screenshot rather than by reasoning about it.

- **Personalisation beyond the accent colour.** The tab strip gets its own colour, deliberately separate: it is the largest painted area in the window, and what works as a 3px focus ring rarely works across the top of a screen. A "match the accent" option is there for anyone who would rather not choose twice. Window translucency is a slider, and on Windows 11 the system can paint its own blurred material behind the window.
- **Translucency costs essentially nothing**, which is why it is done this way. Real per-element transparency means a window with an alpha channel and a blur pass on every frame; this asks the OS compositor, which is already drawing this window and every other one on the screen, to draw it slightly differently.
- **Hardware acceleration can be turned off.** A real diagnostic setting rather than a knob: bad GPU drivers show up as flicker, blank views, or a browser that will not start, and this is the first thing to try. Chromium decides at launch, so the preferences file is now read before the app starts rather than after, and the setting says a restart is needed rather than pretending to apply.
- **Small animations, and a way to stop them.** Tabs arrive, buttons press, rows and swatches respond. Everything that moves is a transform or an opacity change on a small element, so it stays on the compositor and never causes layout — the chrome is a live renderer for the whole life of the window, and an animation that reflowed it would undo part of what the governor saves. The system's reduced-motion setting is always honoured, and there is a switch for machines not set that way.
- **The task manager stopped explaining itself.** It is a live instrument — what each tab is holding, right now, and why — and a paragraph of prose beside a number that changes twice a second is noise in front of the thing you opened it to read. The explanations moved into Settings behind "Explain the memory figures", off by default. The "over-counts" label stays visible either way, because a wrong number with no warning is the one thing that is not acceptable.
- **Mojeek replaces Brave** in the search engine list. Both crawl their own index rather than reselling Google's or Bing's results, so the list keeps an independent option; Mojeek's index is smaller, which shows on obscure queries.

- **Memory is measured natively on Windows and macOS instead of being summed and apologised for.** Summing each process's working set counts a shared page once per process that maps it, and the largest shared thing in a Chromium browser is Chromium itself, mapped into every renderer — measured at 1.95x the proportional figure across five processes and rising with process count, so two open tabs could read as 1098 MB. A small helper now ships beside the app: on Windows it walks each process's working set and divides every shared page by its share count, which is proportional set size computed the only way Windows offers; on macOS it reads `phys_footprint`, the figure the OS charges each process and Activity Monitor shows. Linux is untouched and does not build it — `smaps_rollup` already reports Pss, and a second path to the same number would be one more thing to keep honest.
- **Both new figures are approximations, and say which kind.** Windows caps a page's share count at seven, so a page shared by more processes is counted slightly high — and a Chromium browser runs close to seven processes, so that is not hypothetical. macOS's footprint excludes the clean file-backed pages that caused the over-count but does not divide shared dirty pages, so it is not proportional set size. The panel names the mechanism on hover rather than presenting either as exact.
- **The child-process machinery is now written once.** The trim helper's spawn, line protocol, timeout, restart and EPIPE handling were the subtlest code in the project and every unusual line in them exists because something broke. A second helper meant either a second copy to keep correct or extracting the first; it is extracted, and the trim path was re-verified against the real binary afterwards.
- **Two bugs the tests caught, both of which would have shipped.** `protocol.handle` registers on the default session only, and tabs run in their own partition — so the browser's own pages failed to load inside a tab while rendering perfectly in a default-session harness. And once a page loads, the tab reports the URL Chromium normalised it to, with a trailing slash, so matching "is settings already open?" by URL string stopped matching the instant the page finished loading and every subsequent open would have made another tab.

- **Saved sign-ins and payment details, encrypted by the operating system.** The browser asks after you sign in and stores nothing unless you say yes — a dialog drawn by the browser, not by the page, because the one question that must never be imitable is "shall I keep your password". Records are AES-256-GCM under a 32-byte key held by DPAPI, Keychain or libsecret; the key never exists in plaintext on disk, and whole records are encrypted rather than just the secret, so the file does not publish which services you have accounts with.
- **No weaker fallback, ever.** Where no real keystore exists the store refuses to save and says so. On Linux, Electron reports encryption as "available" while quietly using a basic-text backend that only obfuscates; that case is detected by name and refused, because saving credentials under it while telling you the OS protects them would be a lie the UI told on the browser's behalf.
- **The existing refusals are untouched.** Password and payment fields are still never read into the session store, and a page carrying one is still never photographed. That is not a contradiction: the session store is a performance mechanism you never opted into, so putting a password in it would be a decision made for you. This is the opposite — a deliberate answer to a question.
- **Passwords fill, payment details do not.** A password fills on load only when exactly one saved sign-in matches the page's origin, matched per origin rather than per domain, so a sibling subdomain gets nothing. Card numbers are filled only on a click, because a page can place a hidden or off-screen payment field and a card number is not bound to any site the way a password is.
- **Fills dispatch real input events.** Setting `value` directly leaves a field looking empty to React, Vue and Angular, which track state outside the DOM — the form would submit blank while appearing filled, which is worse than not filling it.
- **One definition of "sensitive field", where there were two that disagreed.** The screenshot gate matched the `autocomplete` attribute with an exact selector; the session snapshot matched the IDL property with `===`. Neither handled a token list, so `autocomplete="cc-number webauthn"` — which is valid — matched nothing, and such a field would have been read into the session store and its page photographed. Now tokenised, and covering CVC and expiry as well as the number.
- **The manager never receives secrets.** A row needs a site and a username; revealing one is a separate call for a single record. It is also fetched on request rather than riding the state broadcast, which reaches three views on every governor tick.

Verification: 52 checks, all green, including these — that the updater is inert outside a packaged build and names the reason. Packing was checked rather than assumed: this project's `files:` allow-list does not mention `node_modules`, so the new dependency could plausibly have been left out of the archive and crashed only on an installed copy. It is packed, and `app-update.yml` lands beside it.

## 1.1.0

The chrome rebuilt to Chrome's layout, and a settings page.

| | Before | Now |
|---|---|---|
| **Title bar** | A window title bar, and a File/Edit/View/Window menu under it | Gone. The tab strip is the title bar, with the system's own window buttons drawn over it |
| **New-tab button** | Pinned to the far right, across a gulf of empty strip | Sits after the last tab and moves with it as tabs open and close |
| **Back / forward** | Always lit, even with nowhere to go | Grey out when there is no history; reload turns into stop while a page loads |
| **Toolbar icons** | Text glyphs | Drawn icons at one stroke weight, plus a three-dot menu |
| **Settings** | None at all | Theme, accent, tab width, meter and dot visibility, search engine, new-tab page, memory budget, live-tab cap |
| **Theme** | Followed the OS, no way to override | System, light or dark — an explicit choice wins over the OS in both directions |

- **The window's own title bar and the File/Edit/View/Window menu are gone.** That menu was Electron's default, not anything this browser defines — there was no File to open and no Window to manage — and it sat above the tabs spending a row of screen on a name the user already knows. The tab strip is the title bar now, as in every modern browser. The system still draws the real minimise/maximise/close buttons over it, so snap layouts, double-click-to-maximise and the accessibility behaviour that comes with them all still work; the strip keeps clear of them through `env(titlebar-area-*)` rather than a hard-coded inset, which would be wrong on one platform or the other.
- **The new-tab button follows the last tab** instead of sitting against the far right edge with a gulf of empty strip in between. The old rule made the tab container claim the whole strip; it now hugs its tabs, and hands the overflow back so tabs shrink rather than pushing the + off-screen.
- **Back and forward grey out** when there is nowhere to go, and the reload button becomes a stop button while a page loads — as a swapped icon path, since the old code wrote text into a button that now holds an SVG and would have deleted the icon on the first load.
- **A settings page**, reached from the three-dot menu or Ctrl+,. Theme (system, light or dark, with an explicit choice beating the OS in both directions), accent colour, tab width, whether the memory meter and the tier dots are shown, search engine, new-tab page, and the two resource limits — memory budget and how many tabs may hold a renderer. Preferences live in `userData`, which an update does not touch, and every value is validated against one schema that guards both the settings page and the file on disk, because that file reaches the governor and the Chromium command line.
- **Empty is not zero.** Clearing a resource limit means "size it to this machine" and returns to the automatic value; `0` for the tab cap means "no cap". A value pinned on the command line outranks anything saved, which is what the code claimed and did not do.
- **No settings that do nothing.** Session restore, automatic updates and the resource profile were drafted and cut: the first two are not built, and the third cannot take effect without a restart.
- The palette lived in three copies across the chrome, the panel and settings, and had already drifted — the panel's light background was a different grey for no reason anyone chose. It is one file now, and the theme choice reaches the task manager as a result.

Verification: 43 checks, all green, including four new ones — that settings never becomes a governed tab, that the schema refuses values outside it, that clearing a limit returns to the automatic value while a pinned flag outranks a saved one, and that the menu builds from live state.

## 1.0.1

Two Windows reporting-and-rendering bugs, both reported from a real install.

- **Minimising the window brought it back empty.** No tab strip, no page, just the background colour and the native menu bar. Minimising on Windows fires `resize` with a client area of zero, and the layout computed from it, flattening every view to zero width — with nothing to restore them afterwards. `layout()` now refuses to compute from a minimised or zero-sized window, and `restore`/`show` re-run it and re-assert view visibility. Confirmed against the old code, which flattened the chrome from 1280px to 0; the new code holds it. Covered by a smoke check, since the failure cannot be reproduced under xvfb where there is no window manager and `minimize()` is a no-op.
- **The memory figure over-counts off Linux, and did not say so.** Windows and macOS have no cheap proportional measure, so the total is summed working set, which counts each page shared between processes — chiefly one copy of Chromium in each — once per process. Measured at **1.95x** the proportional figure across five processes, rising with process count: two open tabs could read as 1098 MB. The panel now labels it "resident (over-counts)" there, explains it on hover, and notes that the budget is compared against the same inflated total so the governor reclaims earlier than it needs to. No better number is available — Electron's `ProcessMemoryInfo` declares `private` and `shared`, but `getAppMetrics()` populates only `workingSetSize`.

## 1.0.0 — first stable release

A complete browser whose governor decides, every two seconds, how much memory and CPU each tab is allowed to hold. Everything below was measured on real renderers and real pages; levers that failed measurement were deleted rather than shipped quiet, and the ones that were deleted are recorded in `docs/MEASUREMENTS.md` on `claude/research-build`.

### The headline

**45 tabs in 365 MB — 8.1 MB per open tab**, against 822 MB (18.3 MB/tab) for the same workload with the governor off.

The cost model, fitted across every benchmark run and stable since:

```
total(n) = 238 MB fixed + 0.6 MB × tabs_open + 13.2 MB × min(tabs, live cap)
```

Read every per-tab figure with its tab count. The fixed 238 MB is Electron's, amortised across whatever is open, so per-tab memory *improves* as you open more — and below about 25 tabs nothing can reach 10 MB/tab, because the fixed cost alone exceeds it. The 13.2 MB is Chromium's per-renderer floor and does not move; the win is residency, not smaller renderers.

### What it does

- **Six tiers.** `ACTIVE → WARM → COLD → FROZEN → HIBERNATED → DISCARDED`, driven by idle time and memory pressure.
- **Invisible discard.** A tab past the live-renderer cap is discarded but stays open, keeping history, scroll and typed input, and returns behind a thumbnail of how you left it. p95 to placeholder is well inside the 50 ms budget; restore p50 is ~5 ms.
- **Hibernation** (Linux, with zram or swap and `CAP_SYS_NICE`). Freeze, then hand the renderer's cold pages to the OS compressor. Nothing is lost and there is no reload. On a 12-tab heavy-heap workload: **1409 MB → 481 MB**, seven tabs hibernated, nothing discarded, `MemAvailable` up 435 MB.
- **Animation-aware boosting.** A page that animates gets the CPU to hold its frame rate and gives it back when it stops; everything expensive in the browser stands down while it does.
- **Protections that always win.** The visible tab, audio, typed input, a tab you just left, and a tab already at its floor.

### Measured, and kept honest

- **Proportional (PSS) accounting, not summed RSS.** Summing RSS counts one copy of Chromium per renderer and overstated this project's own figures by 3x before it was corrected.
- **Zygotes counted.** `getAppMetrics()` omits Chromium's two Linux zygotes (~29 MB of fixed overhead); they are added back.
- **A system-wide figure beside every per-process one.** Pages leaving a process reappear as the compressor's own allocation at about 2:1, so a per-process reading alone overstates a trim by roughly double. The bench prints both and the ratio.
- **Capabilities report why, not just no.** "Not built", "not executable", "needs `CAP_SYS_NICE`" and "no swap to compress into" are four distinct messages, because a user who cannot tell which one they have cannot fix it.

### Known limits

- Restore replays navigation, scroll and unsubmitted input — not in-page JavaScript state. That is why typed input is protected from discard rather than restored from it.
- Password and payment fields are never read into the session store, and a page carrying one is never photographed for a thumbnail.
- Per-tab CPU is exact only when a tab owns its renderer; with one-renderer-per-site, a busy Web Worker in a shared renderer is not a freeze trigger.
- `minimal` profile disables site isolation. That is a security setting. It warns on every launch.
- No extensions, bookmarks, history UI or downloads UI.
- Windows and macOS hibernation backends are deliberately **not** implemented rather than written untested. `trimCapability()` reports `available: false` with the reason.

### Installers

- **Installers for all three platforms.** Windows gets an NSIS installer and a portable single-file `.exe`; macOS gets `.dmg` and `.zip` for both Intel and Apple silicon; Linux gets AppImage, `.deb` and `.tar.gz`. Configured in `electron-builder.yml`, built per-platform on native runners by `.github/workflows/release.yml`, which runs the 41-check suite on each platform *before* packaging it.
- **The trim helper could never have worked in a packaged build.** It was resolved relative to `__dirname`, which lands inside `app.asar` — and a binary inside an asar archive cannot be executed, because the archive is one file the runtime reads rather than a directory the kernel can exec from. Every installed copy would have reported "mem-trim not built" forever, quoting a build command that does not apply to an installed app. It now ships beside the app and is found there.
- **That "not built" message is now audience-aware**, since telling someone with an installed build to run an npm script in a source tree they do not have is the same class of wrong answer as the `setcap` misdiagnosis this release also fixes.
- **Packaged builds can verify themselves.** `--smoke-test` works from an install, because 12KB of fixture HTML ships in the asar. The project is tested on Linux and only expected to work elsewhere, so the means to check travels with it. The first packaged build failed seven checks by serving 404s with the fixtures excluded — including one that looked like a privacy regression and was not.
- The Linux-only trim helper no longer ships inside the Windows installer.

Nothing is signed, but the build is now wired for it: set `CSC_LINK` and `CSC_KEY_PASSWORD` (or the Azure Trusted Signing secrets) and the release workflow signs, with no code or config change — an empty value means "no certificate", so a fork with no secrets still builds unsigned. Signatures are RFC3161-timestamped and SHA-256 only, and the workflow prints the signature status of every `.exe` before uploading, so a release that is quietly unsigned because a secret expired does not get past CI.

`docs/PACKAGING.md` covers getting a certificate, and is worth reading before buying one: since 2023 no CA will sell a downloadable `.pfx`, and an OV certificate does not stop the SmartScreen warning by itself — only EV or Azure Trusted Signing clear it from the first release. It also records what cross-building can and cannot do (the Windows installer needs Wine *including* 32-bit; the macOS `.dmg` cannot be built off macOS; and electron-builder cannot sign a Windows binary from Linux at all, because its vendored `osslsigncode` links against an OpenSSL no current distro ships).

### Verification

`npm run smoke` — 41 checks against real renderers and measured memory, all green. `npm run bench` for the memory comparison. A packaged build can run the same suite against itself with `--smoke-test`.
