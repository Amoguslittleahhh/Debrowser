# Debrowser

A web browser built around a single idea: **a tab should hold the least memory
and CPU it can get away with, and you should never be able to tell.**

It is a complete browser application written from scratch - window, tab strip,
omnibox, session handling, task manager, and a resource governor that decides
what every tab is allowed to hold - built on Chromium via Electron for the web
platform itself. Writing a new HTML/CSS/JS engine would not have served the
goal here: the requirement is that *real websites run properly*, and a
hand-rolled engine would fail that on the first site you tried.

The interesting part is `src/main/governor/`.

---

## Installing it

Prebuilt installers are produced by `.github/workflows/release.yml` on a tagged
push, or on demand from the Actions tab, and attached to the release.

| | Download | Then |
|---|---|---|
| **Windows** | `Debrowser-1.0.0-win-x64.exe` | Run it. SmartScreen will warn — see below. |
| **Windows** (no install) | `...-win-x64-portable.exe` | Run it from anywhere. Installs nothing. |
| **macOS** | `Debrowser-1.0.0-mac-arm64.dmg` (or `-x64` on Intel) | Drag to Applications, then right-click → Open the first time. |
| **Linux** | `Debrowser-1.0.0-linux-x86_64.AppImage` | `chmod +x` and run. |
| **Debian/Ubuntu** | `Debrowser-1.0.0-linux-amd64.deb` | `sudo apt install ./Debrowser-*.deb` |

**None of it is signed.** Windows SmartScreen shows "Windows protected your PC"
(More info → Run anyway) and macOS Gatekeeper refuses the first launch
(right-click → Open, once). Those warnings are accurate: no certificate vouches
for these binaries.

The build is wired for signing — set two repository secrets and the release
workflow signs, with no code change. Getting the certificate is the hard part,
and worth reading `docs/PACKAGING.md` before spending money on one: since 2023
no CA will sell you a downloadable `.pfx`, and an OV certificate does **not**
stop the SmartScreen warning on its own — only EV or Azure Trusted Signing
clear it from the first release.

**Hibernation needs one more step on Linux**, and only on the `.deb` or
`.tar.gz`:

```bash
sudo setcap cap_sys_nice+ep /opt/Debrowser/resources/tools/mem-trim
```

It cannot work from an AppImage at all — a file capability cannot be set on a
file inside a read-only mount. The task manager says so by name rather than
quietly doing nothing.

### Check the build you downloaded

Every packaged build carries the full test suite and can run it against its own
renderers, on your machine:

```
Debrowser.exe --smoke-test              # Windows
/opt/Debrowser/debrowser --smoke-test   # Linux
```

114 checks on real pages. Worth doing here rather than taking it on trust: this
project is tested on Linux and only *expected* to work on Windows and macOS.

---

## Running from source

```bash
npm install
npm start                  # balanced
npm run start:economy      # less memory, isolation intact
npm run start:minimal      # least memory - DISABLES SITE ISOLATION, read below
npm run start:merged       # + page merging (KSM) - side-channel risk, read below
npm run start:performance  # most headroom

npm run smoke              # 89-check end-to-end test against real renderers
npm run bench              # memory benchmark
```

Needs Node 18+ and runs on Windows, macOS and Linux. `npm run smoke` drives a
real browser, so it wants a display; on a headless Linux box or in CI use
`npm run smoke:headless`, which wraps it in `xvfb-run` and adds `--no-sandbox`
for running as root in a container. **A normal desktop install must never pass
`--no-sandbox`** — it is in the headless script only because Chromium refuses to
start sandboxed as root.

### What works on which platform

| | Linux | macOS | Windows |
|---|---|---|---|
| Browser, tabs, session restore, task manager | yes | yes | yes |
| Idle ladder: warm → cold → frozen → discarded | yes | yes | yes |
| Live-renderer cap, thumbnails, hover-prefetch | yes | yes | yes |
| Animation boost, background nice-down | yes | yes | yes |
| Proportional (PSS) memory accounting | yes | falls back to RSS | falls back to RSS |
| `HIBERNATED` tier — compress a tab's cold pages | with zram/swap **and** `CAP_SYS_NICE` | no public API | not implemented |
| Page merging (KSM) | opt-in, needs root | no | no |

Where a lever is unavailable the browser says so by name in the task manager
rather than silently doing nothing, and everything above it on the ladder still
works — the headline residency win comes from the live-renderer cap and
invisible discard, which are on everywhere.

> **Tested on Linux.** Every OS-specific path is guarded and returns a neutral
> value off-Linux rather than failing, and all of them were re-checked for this
> release — but the app has not been *executed* on Windows or macOS, so treat
> those as expected-to-work rather than verified. If something breaks there, it
> is a bug and not a designed limitation.

### Profiles

| | `minimal` | `economy` | `balanced` | `performance` |
|---|---|---|---|---|
| **site isolation** | **off** | on | on | on |
| live renderer cap | off | 4 | **sized to the machine** | 24 |
| memory budget | 600 MB | 700 MB | sized to the machine | 3000 MB |
| discard idle tab after | 5 min | 3 min | 15 min | 2 hrs |
| simultaneous loads | 2 | 2 | 3 | 6 |
| renderer sharing | per site | per site | per site | per tab |
| V8 optimize-for-size | yes | yes | yes | yes |

> **`minimal` disables site isolation.** That is a security setting, not a
> performance one: site isolation is what stops a malicious page — or a
> third-party ad frame inside a page you trust — from reading another site's
> memory, and it is the browser's main defence against Spectre-class and
> cross-site leak attacks. Turning it off saves real memory (below) and the
> browser will not do it on your behalf; it prints a warning on every launch.
> Use it for browsing you trust, on a machine where you need the memory.

**The cap is on how many tabs hold a renderer, not on how many you can open.**
There is no limit on tab count and there never will be — the goal is to make
each tab cheap, not to ration them. Past the cap the least-recently-used tab is
discarded: it stays open in the strip, keeps its history, scroll position and
anything you typed, and returning to it reloads the page behind a picture of how
you left it. Sized from host RAM (4 live at ≤4 GB, 6 at 8 GB, 8 at 16 GB, 12
above); `--max-live-tabs=0` turns it off, `--max-live-tabs=N` sets it.

`balanced` sizes its budget from the host's actual RAM. Override with
`--budget=1200`, or drag the slider in the task manager.

### Keyboard

`Ctrl/Cmd+T` new tab · `+W` close · `+R` reload · `+L` address bar ·
`+D` bookmark · `+H` history · `+J` downloads · `+Shift+O` bookmarks ·
`+M` task manager · `+,` settings · `+P` print · `F11` full screen ·
`F12` or `Ctrl+Shift+I` developer tools

All of these work while a page has the keyboard, not only while the chrome
does — `+L` is the exception, and the one place that is written down is
`pageShortcut` in `main.js`, which says why.

---

## What it actually does

Every tab sits in one of six tiers. The governor moves tabs between them on a
2-second tick, driven by how long they have been out of sight and how close the
browser is to its memory budget.

| Tier | What it means | Cost to undo |
|---|---|---|
| `ACTIVE` | Visible. Never throttled, never touched. | — |
| `WARM` | Hidden recently. Chromium throttles its timers. | Nothing |
| `COLD` | Hidden a while. No renderer action; now a discard candidate. | Nothing |
| `FROZEN` | Task queues stopped, CPU → ~0, memory and DOM intact. | One CDP round trip |
| `HIBERNATED` | Frozen, and its cold pages handed to the OS memory compressor. | ~4–12 ms of page faults |
| `DISCARDED` | Renderer destroyed. ~0 MB. | A reload, behind a thumbnail |

Against that sit the protections, which always win:

- The visible tab is **never** frozen, discarded, or deprioritised.
- Nothing that stalls a renderer runs while anything is animating.
- A tab playing audio is never frozen or discarded.
- A tab holding text you typed is never discarded — it is frozen, and its
  cold pages compressed, instead.
- A tab you left moments ago is never discarded, at any pressure.
- A tab with developer tools open is never frozen or discarded.
- A tab already near its floor is left alone entirely.

### Animation-aware boosting

A page that is animating gets the CPU it needs to hold its frame rate, and
gives it back the moment it stops.

- **Engage fast, release slow.** Boost applies on the first tick that sees
  animation, because being late is a visible stutter at the start of every
  transition. It releases only after a quiet period long enough to ride through
  the gap between two bursts, so priority never drops mid-motion.
- **Two signals, fused.** An in-page probe reports CSS animations, Web
  Animations and media playback. It runs in an isolated world, so it cannot see
  a script-driven `requestAnimationFrame` loop — renderer CPU covers that blind
  spot, and the stronger signal wins.
- **Everything expensive stands down.** While the foreground tab animates, the
  governor defers all freezing and discarding anywhere in the browser. This is
  the difference between a memory saver and a janky one.
- **Priority actually moves.** Background renderers are niced *down*, which
  needs no privileges on any platform, so the animating tab wins the CPU by
  everyone else standing aside.

### Keeping each tab cheap

The aim is that opening a lot of tabs is affordable, not that you are stopped
from doing it. What makes a tab cheap:

- **One renderer per site.** Fifteen tabs on the same site share one process
  instead of taking fifteen. This is the largest per-tab lever there is, and it
  is exactly the case that comes up when you open a lot of tabs at once: 30
  same-site tabs cost ~12.6 MB each, against ~20.8 MB each across 30 different
  sites. Site isolation — the boundary between *different* sites — is untouched;
  what is traded is crash isolation between tabs of the same site.
- **V8 biased toward small heaps** (`--optimize-for-size`). A 13-20% per-tab
  reduction on a DOM-heavy page, depending on the run, for a modest JIT cost.
  The only flag of its kind that survived measurement - seven others did not.
- **No spare renderer.** Chromium keeps one warm to save ~100 ms on the next
  navigation; it costs a whole process.
- **Lazy background tabs.** A tab opened in the background gets no renderer at
  all until first viewed, so twenty middle-clicked links cost one renderer.
- **Load admission.** At most a few tabs load at once, because peak memory is a
  loading-time phenomenon — a page mid-load holds its parser, network buffers
  and pre-compaction heap simultaneously. Queued tabs cost nothing while they
  wait, and anything you click loads immediately.

### Hibernation: the lever for tabs that must not be discarded

A tab holding text you typed, or a half-drawn canvas, is never discarded — the
protections cap it at `FROZEN`, and there it holds its **whole** footprint for as
long as the browser runs. Freezing saves nothing on its own; measured here, it
*costs* about 3 MB. So those tabs, the ones most worth reclaiming from, were the
ones nothing could touch.

Hibernation freezes the tab and then asks the OS to take its cold pages, which
the kernel's compressor holds at roughly 2:1. The process stays alive and its
state is untouched, so waking it is a few milliseconds of page faults rather than
a reload. Measured net of what the compressor itself allocates:

| private before | returned to the system | wake |
|---|---|---|
| 37 MB | 10.9 MB | 4.0 ms |
| 83 MB | 32.5 MB | 3.9 ms |
| 194 MB | 94.4 MB | 3.0 ms |
| 303 MB | 146.1 MB | 12.0 ms |

Roughly 29–49% of a renderer's private memory, rising with size. Note *net*: the
pages reappear as the compressor's own allocation, so a per-process reading alone
overstates this by about double — the figures above subtract it.

**Linux only, and it needs two things your system probably does not have yet:**

```bash
npm run build:memtrim
sudo setcap cap_sys_nice+ep tools/mem-trim   # process_madvise on another process
sudo swapon /dev/zram0                       # somewhere to compress into
```

Without either, the tier is inert and the task manager says which piece is
missing rather than showing a silent zero. Windows would reach the same effect
through `SetProcessWorkingSetSizeEx` and needs no elevation at all, which makes
it the *better* platform for this — it is not implemented because it could not be
tested here, and shipping a plausible-looking call nobody has run is worse than
saying so. macOS has no public API to force its compressor.

Unlike page merging, this is on by default where available and carries no
warning. The distinction is real: KSM shares identical pages *between* processes
and other programs, which is a cross-site inference channel; paging to a
compressor keeps each process's data to itself, leaving only a timing signal on
the compression ratio of your own memory.

### Where the savings come from

Not from squeezing live renderers — that was measured repeatedly and does not
work. Forcing a garbage collection on an idle tab costs more in instrumentation
than it reclaims, and `forciblyPurgeJavaScriptMemory` reclaims nothing at all
while breaking the page. Chromium already reclaims a backgrounded renderer on
its own, and goes further than forcing it does, so an idle tab is left alone.

What does work: **not paying for a renderer you do not need** (lazy background
tabs, no spare renderer, one renderer per site, the live-renderer cap) and
**making the renderer you do need smaller** (`--optimize-for-size`). Freezing is
applied only to tabs still burning CPU out of sight, because it costs memory
rather than saving any — measured again with whole-renderer freezing, which
changes nothing (`docs/MEASUREMENTS.md`).

The largest single lever turned out to be residency rather than renderer size.
A hidden tab used to cost almost exactly what a visible one costs, and the
per-renderer floor is not movable — so what moved the number was discarding more
of them, once discarding stopped being something you could see.

---

## Measured results

From `npm run bench` on a 4-core, 16 GB Linux host. Where a table says "all
live", nothing was discarded and no cap applied; the governed figures say so.

### How this is measured

In **proportional set size**, not RSS. This matters enough to state plainly:
every figure this project reported before was summed RSS, which counts pages
shared between processes — chiefly the Chromium binary, mapped into every
renderer — once per process. On six tabs of a trivial page:

```
summed RSS   810 MB        <- what was previously reported
summed PSS   247 MB        <- actual physical memory
```

So earlier claims here overstated both the problem and the improvement by
roughly 3x. PSS divides each shared page by the number of processes mapping it,
so summing it corresponds to real memory. It is a Linux figure
(`/proc/pid/smaps_rollup`); on macOS and Windows the code falls back to RSS and
labels itself as doing so.

### Per tab

| page | PSS per tab | private per tab |
|---|---|---|
| trivial page | 19.8 MB | 10.0 MB |
| DOM-heavy page (4000 nodes, retained arrays) | 33.0 MB | 21.3 MB |

The private figure is the marginal cost of one more tab; the rest is that tab's
share of one copy of Chromium.

### Thirty tabs

All live, nothing discarded, no cap — one site per tab, which is what real
browsing looks like to Chromium's process model:

| | total | per tab | renderers |
|---|---|---|---|
| 30 different sites | **624 MB** | 20.8 MB | 31 |
| 30 tabs on one site | 377 MB | 12.6 MB | 2 |

Then with the governor and the live-renderer cap doing their job:

| | total | per tab | renderers |
|---|---|---|---|
| 30 tabs, cap 6 | **330 MB** | 11.0 MB | 7 |
| 30 tabs, cap 4 | **311 MB** | 10.4 MB | 5 |
| 30 tabs, cap 3 | **291 MB** | 9.7 MB | 4 |
| 40 tabs, cap 4 | **304 MB** | **7.6 MB** | 5 |

Read that last row carefully, because it is the most useful thing in this file:
**forty tabs cost less per tab than thirty do.** About 238 MB exists before the
first tab does — browser, GPU, network and zygote processes — and it is divided
across whatever is open, so the per-tab figure falls as you open more. Below
roughly 25 tabs it cannot reach 10 MB at any setting, because that fixed cost
alone exceeds it. The number is meaningless without its tab count.

> Figures published before the accounting fix in `docs/MEASUREMENTS.md` are low
> by about 29 MB: `app.getAppMetrics()` omits Chromium's zygote processes, and
> everything here went through it. The two all-live rows above are corrected;
> the same-site row carries the correction rather than a fresh run.

### What site isolation costs (the `minimal` profile)

Most real pages carry cross-site subframes — ads, embeds, social buttons — and
with strict isolation each one gets its own renderer. Measured on a fixture with
six cross-site frames per page:

| 12 tabs of an embed-heavy page | renderers | total |
|---|---|---|
| `balanced` (isolation on) | 19 | 486 MB |
| `minimal` (isolation off) | 13 | **414 MB (−15%)** |

On tabs with *no* subframes, disabling isolation saves nothing — each top-level
site still needs its own process. The saving comes entirely from collapsing
subframes, which is why it only shows up on a fixture that has them. Adding a
renderer process limit on top forces cross-site reuse as well, taking 12 tabs of
a DOM-heavy page from 463 MB to 376 MB (−19%) at 4 renderers.

### What `--optimize-for-size` is worth

| | per tab | total (30 tabs) |
|---|---|---|
| V8 default | 37.9 - 41.2 MB | 614 MB |
| optimize-for-size | **33.0 MB** | **591 MB** |

13-20% on a DOM-heavy page depending on the run; ~4% across a mixed workload,
where lighter pages have less heap to shrink. Toggle with
`--no-optimize-for-size` to re-measure.

### Flags that did not survive measurement

Tested per-tab, in PSS, and rejected:

| flag | result |
|---|---|
| `--enable-low-end-device-mode` | saves the same as optimize-for-size and does not stack (33.5 MB combined vs 33.0 MB alone), while shrinking image caches and disabling visible features |
| `--max-semi-space-size` (2 / 16 / unset) | no difference at any value; it had been shipping here on an unmeasured assumption, which summed RSS could not have detected |
| `--num-raster-threads=1` | **worse** — 40.4 MB against 37.9 MB |
| `--disable-features=BackForwardCache` | no difference |
| `webPreferences.spellcheck: false` | no difference (0.1 MB) |
| `--disable-features=Translate,OptimizationHints,MediaRouter` | no difference, slightly worse |

### Page merging across the renderer pool (opt-in)

`tools/ksm-launch.c` marks the browser's process tree eligible for **kernel
same-page merging**, so identical anonymous pages across renderers collapse onto
one physical copy.

This is the applicable form of the page-merging idea in
[Mesh](https://arxiv.org/abs/1902.04738). Mesh merges pages *within* a process by
finding spans whose occupied slots do not overlap, which needs the allocator's
knowledge of object layout — unreachable without replacing PartitionAlloc inside
Chromium. KSM attacks the same waste from the other side: across processes, by
content equality. A browser runs many renderers over identical code and similar
structures, so a lot of their pages are byte-identical.

Measured, 8 DOM-heavy tabs on distinct sites, two runs each:

| | per-tab PSS | per-tab private | whole app |
|---|---|---|---|
| plain | 30.8 / 30.9 MB | 21.3 / 21.3 MB | 375 / 376 MB |
| merged | **25.1 / 25.6 MB** | **15.2 / 15.4 MB** | **325 / 332 MB** |

**−12% total, −28% of per-tab private memory.** KSM's own accounting agrees
independently (`general_profit` ≈ 40 MB, `pages_sharing` ≈ 12 000 pages collapsed
onto ~1 500), which is why this is stated as causal rather than as a difference
between two runs.

```bash
sudo sh -c 'echo 1 > /sys/kernel/mm/ksm/run'   # enable the kernel scanner
npm run start:merged
```

> **Why this is opt-in and warns at every launch.** Memory deduplication is a
> known timing side channel: writing to a merged page triggers copy-on-write and
> is measurably slower, which lets code in one page test whether specific content
> exists elsewhere in memory — including in other applications, since KSM merges
> system-wide. A browser runs untrusted code by design, which is the worst case
> for this class of attack. The same principle is demonstrated for memory
> *compression* in [Schwarzl et al.](https://arxiv.org/abs/2111.08404), and
> remote-timer work shows such channels are exploitable without local access.
> KSM is off by default on essentially every distribution and needs root to
> enable — treat that as the design telling you something.

### Optimal heap limits: implemented, and off by default

`src/main/governor/heap-limit.js` implements the square-root heap limit rule from
[Kirisame, Shenoy & Panchekha, *Optimal Heap Limits for Reducing Browser Memory
Use*](https://arxiv.org/abs/2204.10455) (OOPSLA 2022), whose MemBalancer
prototype reports ~16% less memory at constant GC time by patching V8:

```
M = L + sqrt(L * g / (c * s))
```

It is implemented faithfully — including the paper's note that *c* may be
weighted per heap, so hidden tabs get a tighter limit since their GC pauses are
invisible — and it is **disabled by default, on a measured negative result**:

- **V8's heap is not where the memory is.** A settled DOM-heavy page reports
  ~2 MB of committed heap against ~21 MB of private memory. Even a perfect
  collection leaves ~90% of the tab untouched; the rest is DOM, Blink structures
  and malloc, which no garbage collector reaches.
- **V8 already does it.** A backgrounded heap is collected on its own within
  ~10 s, so forcing it earlier mostly just does sooner what happens anyway.
  Across 20 tabs, with and without, the settled total differed by 1 MB.

The gap between that and the paper's 16% is the implementation, not the rule:
they set a real V8 heap limit, which changes *how V8 schedules its own
collections*. Nothing in Electron's API or the DevTools protocol can set that
limit, so the rule can only be used here as a trigger for collections we request
ourselves — which is both more expensive (a debugger session, ~2.4 MB per tab)
and strictly later. Enable with `--heap-limit` if your tabs allocate heavily in
the background, where the steady-state rule has something to act on.

---

## Cross-platform

Everything OS-specific is confined to `src/main/platform.js`: process priority
(nice values on Linux/macOS, priority classes on Windows), memory sizing from
host RAM, and the Chromium switch list. The policy in `governor/` is written
once and behaves identically everywhere.

The Chromium flag list is deliberately short — nothing goes in it unless it is
both verifiable and load-bearing.

---

## Layout

```
src/main/
  governor/     the resource policy: tick loop, tiers, boost, metrics
  tabs/         tab lifecycle, discard/restore, session capture
  platform.js   everything OS-specific
  cdp.js        DevTools protocol wrapper
  window.js     window layout: chrome, tab views, side panel
src/preload/    activity probe (pages) and the chrome bridge
src/renderer/   the browser UI, written from scratch
  theme.css     the design system: type, colour, space, elevation, motion
test/pages/     benchmark and test fixtures
bench/          memory benchmark harness
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design in depth.

The measurements behind the design decisions — including the levers that were
tried, measured and removed — live on the `claude/research-build` branch.

---

## Limits worth knowing

- Restoring a discarded tab replays navigation history, scroll offset and
  unsubmitted form input. It does **not** restore in-page JavaScript state — a
  half-finished canvas drawing or an open WebSocket does not survive. That is
  why unsubmitted input is protected from discard rather than restored from it.
- Form restore keys off element `id`. Fields without one are captured but not
  replayed, since an index-based path is not stable across a reload.
- Per-tab memory is quoted **per open tab**, and that figure depends on how many
  tabs are open. Roughly 238 MB of browser, GPU, utility and zygote processes
  exists before the first tab does, and it is amortised across whatever is open,
  so the per-tab number *improves* as you open more: ~10.4 MB/tab at 30 tabs and
  ~7.6 MB/tab at 40, at the same live cap. Below about 25 tabs it cannot reach
  10 MB at any setting, because the fixed cost alone exceeds it. Always read the
  figure with its tab count.
- That fixed overhead is Electron's, not this project's. A bare Electron app
  with one blank view already holds 82 MB in its browser process, and collapsing
  the GPU, network and zygote processes was measured: every variant either saved
  nothing or stopped the browser rendering. See `docs/MEASUREMENTS.md`.
- The live-renderer cap is **on** by default, scaled to the machine. It bounds
  how many tabs hold a renderer, never how many can be open: past the cap the
  least-recently-used tab is discarded, and returning to it reloads the page
  behind a picture of how you left it. `--max-live-tabs=0` turns it off.
- **The interface is set in Aptos, then Calibri, then whatever the system has.**
  Neither can be bundled — both are Microsoft's and not redistributable — so the
  stack degrades, and it names Carlito before the system default: Carlito is
  metric-compatible with Calibri, is under the Open Font License, and on Linux is
  one `apt install fonts-crosextra-carlito` away. With it the layout is identical
  to the pixel; without it you get your own platform's UI face and nothing looks
  broken. Two measured consequences are built into the rest of the styling:
  Calibri's x-height is about 10% shorter than the faces desktop UI usually
  assumes, so the base size is 14px rather than 13, and it ships exactly two
  weights, so emphasis here is carried by colour and size rather than by a
  semibold that does not exist.
- **Site icons are fetched by the browser, without cookies, and never stored.**
  A tab, a history row and a task-manager row all show the real favicon, with
  the site's initial on a colour derived from its hostname underneath it — what
  you see while the icon loads, and what stays for the many sites that serve
  none. Measured: Chromium reports an icon address for *every* page, falling
  back to `<origin>/favicon.ico` even when the page declares nothing, so an
  address is always available and often 404s; the letter is the answer to that
  rather than a broken image.
  The fetch does **not** happen in the page. An `<img>` pointed at a site is
  loaded by the page showing it, with that session's cookies — so a history
  list would send a cookie-bearing request to every site on screen, announcing
  that you are reading your history. The views ask `debrowser://icon` instead
  and the browser process fetches it with credentials omitted; the pages'
  content policies allow no other image source, so that is enforced rather than
  intended. Only two addresses are fetchable: the well-known `/favicon.ico`,
  and one Chromium reported for a page actually loaded — because a *website*
  can reference `debrowser://` subresources (measured), and without that
  restriction the route would be a fetch proxy pointed wherever a page liked.
  History keeps an icon address only for sites whose icon is somewhere other
  than the default, because the default one can be worked out from the page's
  own address.
- **History is plain JSON in your profile directory, not a secret store.** It is
  the one record here that is deliberately readable: encrypting a list of the
  pages you visited would hide it from you and from nobody else, since anything
  that can read the file can also reach the key. It keeps one row per page
  rather than one per visit — with a counter and the last time — so it stays
  proportional to the number of distinct pages seen, and it is capped at ten
  thousand of them. `debrowser://history` searches it, forgets single entries,
  clears all of it, and has the switch that stops it recording; turning that off
  leaves what is already stored alone, because not adding to a record and
  deleting one are different decisions.
- Developer tools are Chromium's own, opened detached. The tab being inspected
  is held at `WARM` for as long as they are open — never frozen, never
  discarded — because freezing a page stops the task queues the inspector is
  driving. That is one resident renderer for as long as you are debugging.
- A restored tab is covered by a thumbnail while it reloads. Pages carrying a
  password or payment field are never photographed, the images live in the OS
  temp directory, and they are deleted on close, on quit and again on startup.
- Minimising and restoring the window used to bring it back empty on Windows —
  no tab strip, no page, just the background colour. Minimising fires a resize
  with a client area of zero, and laying out from that wrote zero-width bounds
  over every view with nothing to put them back. Fixed in 1.0.1: the layout
  refuses to compute from a minimised or zero-sized window, and re-runs on
  restore.
- **The memory figure is measured per platform, and each measure is named.**
  Linux reads a real proportional figure (Pss) from `smaps_rollup`. Windows and
  macOS have no such thing, so a small native helper ships beside the app and
  is asked instead — the browser no longer sums working set and warns you about
  it. Two caveats, both reported rather than hidden: on Windows the figure is a
  true proportional set size, computed by walking each process's working set
  and dividing every shared page by its share count, but that count is three
  bits wide and saturates at seven — a page shared by more than seven processes
  is counted slightly high, and a Chromium browser runs close to that many. On
  macOS the figure is `phys_footprint`, the number the OS charges each process
  and shows in Activity Monitor; it excludes the clean file-backed pages that
  caused the over-counting, but it does not divide shared dirty pages, so it is
  not proportional set size and is not described as though it were. If the
  helper is missing or refused, the old summed-working-set figure returns with
  its "over-counts" label intact.
- Per-tab CPU is exact only when a tab owns its renderer. With one-renderer-
  per-site (the default) several same-site tabs share one, and a page's own CPU
  is read per-document over CDP — which covers its main thread but not its Web
  Workers. A worker busy in a shared renderer is therefore not a freeze trigger.
- **An Intune-shaped Windows installer exists and is experimental.** It is
  per-machine and silent, because the Intune Management Extension runs install
  commands as SYSTEM. It has never been run against a real tenant — it was built
  with no access to Windows or Intune — and being unsigned is likely to be the
  actual blocker in any estate enforcing WDAC or Smart App Control. See
  `build/intune/README.md`. A machine-wide install turns its own updater off,
  since it cannot write to its install directory and update scheduling belongs
  to whoever deployed it.
- **Updates are differential on Windows and on the Linux AppImage, and absent
  on macOS.** Only the changed blocks of the installer are downloaded rather
  than the whole ~110MB, almost all of which is Chromium and identical between
  releases. macOS is not a missing feature but a signing prerequisite:
  Squirrel.Mac validates that an update is signed by the same identity as the
  running app and refuses when there is none, and this build is unsigned. The
  `.deb`, `.tar.gz` and Windows `portable` builds are not updatable formats.
  Settings, the browsing session and saved data live in `userData`, which an
  installer does not touch.
- No extensions, no bookmarks, no history UI, no downloads UI. Chrome extension
  support is intended and not built. Settings covers appearance, search and the
  two resource limits; anything not listed there is not a setting yet, which is
  deliberate - a control that does nothing is worse than a short page.
- `legacy/debrowser.hta` ports the residency model to MSHTML for machines that
  can only run an HTA. It is a curiosity, not a supported browser: unsandboxed,
  untested, and unable to do anything this project measures per-tab. See
  `legacy/README.md`.
- Password and payment fields are deliberately never read into the session
  store, so a discarded tab will not restore them. Saving one is a separate,
  explicit act: the browser asks after you sign in, and stores nothing unless
  you say yes. Records are AES-256-GCM under a key held by the OS keystore —
  DPAPI, Keychain or libsecret — and if no real keystore is available the store
  **refuses to save** rather than falling back to something weaker. Passwords
  fill automatically only when exactly one saved sign-in matches the page's
  origin; payment details are never filled without a click, because a page can
  hide a card field and a card number is not bound to any one site.
