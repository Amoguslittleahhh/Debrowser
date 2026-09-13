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
| memory budget | 700 MB | sized to the machine | 3000 MB |
| renderer sharing | per site | per tab | per tab |
| spare renderer | no | yes | yes |
| discard from | moderate pressure | high pressure | critical pressure |

`balanced` sizes its budget from the host's actual RAM (28-45% of total,
clamped to 512-6144 MB), because a fixed figure strands memory on a
workstation and thrashes on a netbook. Override with `--budget=1200`, or drag
the slider in the task manager.

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

All from `npm run bench` on a 4-core, 16 GB Linux host, 12 tabs (a mix of
memory-heavy, idle, animating and form pages). Reproduce with the commands
shown.

**Holding a memory budget** — `node bench/bench.js --tabs=12 --budget=800`

| | baseline | governed | delta |
|---|---|---|---|
| total resident | 1465 MB | **793 MB** | **−672 MB (−46%)** |
| per tab | 122.1 MB | 66.1 MB | −56.0 MB |
| renderer processes | 13 | 5 | −8 |

Final tab states: 1 active, 3 frozen, 8 discarded — all restoring on click,
with scroll position and unsubmitted input intact.

**Process configuration alone** — `node bench/bench.js --tabs=12 --profile=economy`

The economy profile's Chromium configuration takes the same 12 tabs from
**1465 MB to 556 MB (−62%)** before the governor does anything at all. This is
the single largest memory lever in the project.

**Cost when there is nothing to do** — `node bench/bench.js --tabs=12`

With memory far under budget the governor has no work to do, and costs
**+9 MB (0.6%)** across 12 tabs for its own instrumentation.

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
- No extensions, no bookmarks, no history UI, no downloads UI. This is a
  resource-management browser, not a Chrome replacement.
- Password and payment fields are deliberately never read into the session
  store, so a discarded tab will not restore them.
