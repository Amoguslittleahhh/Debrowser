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
| live renderers | 4 | sized to the machine (4-12) | 24 |
| memory budget | 700 MB | sized to the machine | 3000 MB |
| discard idle tab after | 3 min | 15 min | 2 hrs |
| simultaneous loads | 2 | 3 | 6 |
| renderer sharing | per site | per site | per tab |
| spare renderer | no | no | yes |

`balanced` sizes both the live-renderer cap and the budget from the host's
actual RAM, because fixed figures strand memory on a workstation and thrash on
a netbook. Override either with `--max-live-tabs=6` / `--budget=1200`, or drag
the budget slider in the task manager.

**The live-renderer cap is the number that matters if you open tabs in
bursts.** A memory budget cannot help there: on a 16 GB machine the budget is
~6 GB, so thirty tabs never reach it and thirty renderers stay resident. The
cap bounds the footprint by tab count instead, discarding least-recently-used
first, so the handful you are actually moving between stay instant.

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

### Staying compact with many tabs

Three mechanisms, aimed at the case where tabs arrive faster than they are read:

- **A live-renderer cap.** At most N tabs hold a renderer; past that the
  least-recently-used is discarded. Bounds memory by tab count rather than
  hoping a budget is reached.
- **Load admission.** At most a few tabs load at once. Peak memory is a
  *loading* phenomenon - a page mid-load holds its parser, network buffers and
  pre-compaction heap simultaneously - so a burst of thirty tabs otherwise
  spikes far above where it settles. Queued tabs cost nothing while they wait,
  and anything you click loads immediately.
- **Lazy background tabs.** A tab opened in the background gets no renderer at
  all until first viewed. Twenty middle-clicked links cost one renderer.

### Where the savings come from

Deliberately, **not** from squeezing live renderers. The memory savings come
from discarding tabs and from the process configuration (one renderer per site,
no spare renderer, a renderer cap); the CPU savings come from freezing
background CPU burners, priority management, and the animation boost.

That is why a merely-idle tab is left completely alone — Chromium already
reclaims a backgrounded renderer on its own, and better than forcing it to.
Freezing is applied only to tabs still burning CPU out of sight, because it
costs memory rather than saving any.

---

## Measured results

From `npm run bench` on a 4-core, 16 GB Linux host. Every tab is served on its
**own site** (`t1.test`, `t2.test`, …) rather than as `file://` URLs, because
all `file://` pages are one site to Chromium's process model - measuring that
way collapses thirty tabs into two processes and reports a saving nobody would
actually see.

**Thirty tabs** — `node bench/bench.js --tabs=30`

| | baseline | governed | delta |
|---|---|---|---|
| total resident | 3081 MB | **1156 MB** | **−1925 MB (−62%)** |
| peak during load | 3083 MB | **1165 MB** | **−1918 MB** |
| per tab | 102.7 MB | 38.5 MB | −64.2 MB |
| renderer processes | 31 | 9 | −22 |
| live tabs | 30 | 8 | −22 |

The peak matters as much as the total here: the governed run never spikes on
the way up, so opening thirty tabs at once does not briefly claim 3 GB before
settling.

**Twelve tabs** — `node bench/bench.js --tabs=12`

1474 MB → **1148 MB (−22%)**. The saving is smaller because twelve tabs is
close to the cap, so most of them legitimately stay resident.

**A note on the fixture mix.** The default mix includes a form page holding
unsubmitted input, which the governor refuses to discard — so a quarter of the
tabs are immune to reclaim by design, and the governed run sits at 8 live tabs
even with a cap of 4. That is the protection working. `--mix=noforms` measures
the cap against tabs that are all reclaimable: 30 tabs → 8 live exactly,
3122 MB → 1179 MB.

**Cost when there is nothing to do.** With few tabs and memory far under
budget, the governor costs ~9 MB for its own instrumentation.

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
- The live-renderer cap means the N+1th tab you return to reloads. That is the
  trade the cap exists to make; raise `--max-live-tabs` if you would rather
  spend the memory.
- Per-tab CPU is exact only when a tab owns its renderer. With one-renderer-
  per-site (the default) several same-site tabs share one, and a page's own CPU
  is read per-document over CDP — which covers its main thread but not its Web
  Workers. A worker busy in a shared renderer is therefore not a freeze trigger.
- No extensions, no bookmarks, no history UI, no downloads UI. This is a
  resource-management browser, not a Chrome replacement.
- Password and payment fields are deliberately never read into the session
  store, so a discarded tab will not restore them.
