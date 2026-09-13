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

## Running it

```bash
npm install
npm start                  # balanced
npm run start:economy      # least memory
npm run start:performance  # most headroom

npm run smoke              # 21-check end-to-end test, headless
npm run bench              # memory benchmark
```

On Linux without a display, prefix with `xvfb-run -a`. Running as root (in a
container) additionally needs `--no-sandbox`, which the npm scripts already
pass; a normal desktop install must not use it.

### Profiles

| | `economy` | `balanced` | `performance` |
|---|---|---|---|
| live renderer cap | 4 | **off** | off |
| memory budget | 700 MB | sized to the machine | 3000 MB |
| discard idle tab after | 3 min | 15 min | 2 hrs |
| simultaneous loads | 2 | 3 | 6 |
| renderer sharing | per site | per site | per tab |
| V8 optimize-for-size | yes | yes | yes |

**There is no cap on how many tabs stay live by default.** The goal is to make
each tab cheap, not to ration them. A cap exists as an opt-in ceiling for small
machines, or for anyone who would rather spend reload latency than memory —
`--max-live-tabs=8`, or the economy profile.

`balanced` sizes its budget from the host's actual RAM. Override with
`--budget=1200`, or drag the slider in the task manager.

### Keyboard

`Ctrl/Cmd+T` new tab · `+W` close · `+R` reload · `+L` address bar ·
`+M` task manager

---

## What it actually does

Every tab sits in one of five tiers. The governor moves tabs between them on a
2-second tick, driven by how long they have been out of sight and how close the
browser is to its memory budget.

| Tier | What it means | Cost to undo |
|---|---|---|
| `ACTIVE` | Visible. Never throttled, never touched. | — |
| `WARM` | Hidden recently. Chromium throttles its timers. | Nothing |
| `COLD` | Hidden a while. No renderer action; now a discard candidate. | Nothing |
| `FROZEN` | Task queues stopped, CPU → ~0, memory and DOM intact. | One CDP round trip |
| `DISCARDED` | Renderer destroyed. ~0 MB. | A reload |

Against that sit the protections, which always win:

- The visible tab is **never** frozen, discarded, or deprioritised.
- Nothing that stalls a renderer runs while anything is animating.
- A tab playing audio is never frozen or discarded.
- A tab holding text you typed is never discarded — it is frozen instead.
- A tab you left moments ago is never discarded, at any pressure.
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
  same-site tabs cost 11.6 MB each, against 19.7 MB each across 30 different
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

### Where the savings come from

Not from squeezing live renderers — that was measured repeatedly and does not
work. Forcing a garbage collection on an idle tab costs more in instrumentation
than it reclaims, and `forciblyPurgeJavaScriptMemory` reclaims nothing at all
while breaking the page. Chromium already reclaims a backgrounded renderer on
its own, and goes further than forcing it does, so an idle tab is left alone.

What does work: **not paying for a renderer you do not need** (lazy background
tabs, no spare renderer, one renderer per site) and **making the renderer you do
need smaller** (`--optimize-for-size`). Freezing is applied only to tabs still
burning CPU out of sight, because it costs memory rather than saving any.

---

## Measured results

From `npm run bench` on a 4-core, 16 GB Linux host, with every tab **live** —
nothing discarded, no cap.

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

### Thirty tabs, all live

| | total | per tab | renderers |
|---|---|---|---|
| 30 different sites | **592 MB** | 19.7 MB | 31 |
| 30 tabs on one site | **348 MB** | 11.6 MB | 2 |

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
- Per-tab memory is close to its floor. About 10 MB of the marginal cost of a
  light tab is Chromium's own per-renderer baseline, which no flag tested here
  reduces. Beyond that, the remaining lever is sharing renderers between
  same-site tabs, which is already on.
- The live-renderer cap is off by default. If you enable it, the N+1th tab you
  return to reloads — that is the trade it exists to make.
- Per-tab CPU is exact only when a tab owns its renderer. With one-renderer-
  per-site (the default) several same-site tabs share one, and a page's own CPU
  is read per-document over CDP — which covers its main thread but not its Web
  Workers. A worker busy in a shared renderer is therefore not a freeze trigger.
- No extensions, no bookmarks, no history UI, no downloads UI. This is a
  resource-management browser, not a Chrome replacement.
- Password and payment fields are deliberately never read into the session
  store, so a discarded tab will not restore them.
