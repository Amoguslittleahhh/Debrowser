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

### Verification

`npm run smoke` — 41 checks against real renderers and measured memory, all
green. `npm run bench` for the memory comparison.
