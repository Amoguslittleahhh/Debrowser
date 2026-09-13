# Debrowser — research branch

The measurements behind the resource governor on `claude/master-build`.

This branch exists because the governor's design is not what it would have
been if it had been reasoned out rather than measured. Every obvious memory
lever available to an Electron browser turned out to be a loss, and three
separate features were removed because a run in `experiments/` contradicted
the assumption behind them. Someone will eventually want to re-add them. These
are the receipts.

The browser itself is documented on `claude/master-build`. This branch carries
the same code plus `experiments/`, so every experiment runs against the
implementation it informed.

---

## The question

An Electron browser holding twelve tabs uses around 1.5 GB. The obvious way to
reduce that is to make each renderer give memory back: force a garbage
collection when a tab goes idle, purge its heap, freeze it so it stops working.
All three are one DevTools protocol call away.

The question was how much each of them is actually worth. Nothing was measuring
it — and the first version of the governor did all three.

---

## The answer

It used **90 MB more than no governor at all**, across twelve tabs, entirely in
renderer processes.

| Lever | Expected | Measured |
|---|---|---|
| `Memory.forciblyPurgeJavaScriptMemory` | frees the tab's heap | **0 MB** beyond a normal GC, and it kills the in-page probe |
| `HeapProfiler.collectGarbage` on idle tabs | reclaims a few MB | **+9 MB** net on an ordinary page — the profiler agent costs ~6 MB and never returns it |
| Freezing every idle tab | pure win, CPU → 0 | costs a few MB per tab — it **stops** Chromium's own background reclamation |
| Doing nothing at all | — | **−10 MB** over a minute, unaided, and still falling |

The thing that beat every forced intervention was leaving the tab alone.

---

## Method

Each file in `experiments/` is a standalone Electron app that isolates one
variable and prints a number. They share `lib.js` for measurement helpers —
notably `settledRss`, which samples repeatedly before reporting, because a
single `getAppMetrics()` call catches whatever the allocator happened to be
doing at that instant and is not trustworthy to the megabyte.

Two habits did most of the work:

- **Controls.** Experiment 02 bisects a segfault across three modes. It is only
  evidence because the two innocent modes were run too and showed zero crashes;
  a bisect where everything crashes proves nothing.
- **Representative samples.** The per-tab measurement and the twelve-tab
  benchmark disagreed for a while, and both were correct. The per-tab run used
  a memory-heavy page — the one shape where forcing a collection pays. Most
  tabs are not that shape.

---

## Running them

From the repo root, with dependencies installed (`npm install`):

```bash
xvfb-run -a npx electron experiments/01-frozen-page-cdp.js --no-sandbox --disable-gpu
```

On a desktop with a display, drop `xvfb-run -a`. Drop `--no-sandbox` unless
running as root. `--disable-gpu` keeps results comparable on machines without
a GPU; it is not required.

Several take arguments:

```bash
for m in views freeze purge-then-ipc; do
  xvfb-run -a npx electron experiments/02-frozen-ipc-segfault.js --mode=$m --no-sandbox --disable-gpu
done

for p in heavy idle; do
  xvfb-run -a npx electron experiments/04-gc-instrumentation-cost.js --page=$p --no-sandbox --disable-gpu
done

for m in none gc frozen; do
  xvfb-run -a npx electron experiments/05-background-reclaim.js --mode=$m --no-sandbox --disable-gpu
done
```

Experiment 05 watches a tab for 60 seconds per mode, so the full set takes a
few minutes. The rest finish in seconds.

The end-to-end numbers come from `npm run bench`, which runs the same workload
with and without the governor and breaks the result down by process type —
because a governor that saves memory in every renderer can still lose overall
by spending it in the browser process. That breakdown is what made the 90 MB
regression visible.

---

## What each experiment established

| # | Question | Answer | Consequence in the browser |
|---|---|---|---|
| 01 | Can a frozen page answer CDP, and unfreeze? | Yes to both, including `Runtime.evaluate` | The `FROZEN` tier is safe to use. The activation hang was our own bug, not a protocol limit |
| 02 | What is segfaulting tabs on activation? | Only **IPC to a purged renderer**. Freezing, view toggling and the probe are innocent | `Tab#sendToPage` — one gate every message to a page goes through |
| 03 | What does each trim lever reclaim? | GC −5 MB; forced purge **−0 MB**, and it kills the in-page probe | `forciblyPurgeJavaScriptMemory` removed entirely |
| 04 | What does *asking* for a GC cost? | Heap profiler agent: **+6 MB per renderer**, never returned. Net −6 MB on a heavy page, **+9 MB on an ordinary one** | Forced collection removed; `COLD` performs no renderer action |
| 05 | What happens if we just leave a hidden tab alone? | Chromium reclaims further unaided (117→107 MB) than a forced GC achieves (112 MB); freezing **stops** that reclamation | Freezing reserved for tabs still burning CPU while hidden |
| 06 | What does holding a CDP session cost? | +3 MB/renderer; freeze works without `Page.enable`; page **stays frozen after detach** | `Page.enable` dropped; session detached once frozen, and again when a tab goes active |

---

## The through-line

Experiments 03, 04 and 05 together overturned the original design. It assumed
the way to make a browser use less memory is to squeeze live renderers. Every
measurement said otherwise:

- The strongest squeeze available reclaims nothing a normal collection has not
  already reclaimed, and breaks the page's instrumentation doing it.
- Asking for that collection costs more in instrumentation than the collection
  returns, on any page without an unusually large collectable heap.
- Chromium already reclaims backgrounded renderers on its own, and goes further
  than a forced collection does — so the correct action on an idle tab is **no
  action at all**.
- Freezing, which looks like a pure win, has a memory cost precisely because it
  stops that background reclamation.

What survived, and what the shipped browser does: memory savings come from
**discarding tabs** and the **process configuration** (one renderer per site,
no spare renderer, a renderer cap). CPU savings come from **freezing background
CPU burners**, **priority management**, and the **animation boost**.

Net result on twelve tabs against an 800 MB budget: **1465 MB → 793 MB**.

---

## A crash worth recording

Two of these experiments exist because tabs were dying with SIGSEGV the moment
the user clicked back to them, and the suspects were all plausible: software
rasterization, page freezing, forced purging, runtime throttling changes, the
activity probe.

It was none of the obvious ones. **Delivering IPC to a renderer whose JS memory
has been forcibly purged kills it** — the purge tears down the isolated world
the preload lives in, so the next message dereferences freed state. The page
keeps rendering perfectly until something talks to it.

That is a fault you cannot reason your way to, and it is the reason the browser
routes every message to a page through a single gate rather than trusting call
sites to remember.

---

## Note on absolute numbers

Every figure here was measured on one host (4-core, 16 GB, Linux, Electron
44.3.0, software rasterization) and will differ elsewhere. The *directions* are
what the design rests on, and those held across every re-run: purge reclaims
nothing, the heap profiler costs more than it saves on ordinary pages, unaided
background reclamation beats a forced collection, and IPC to a purged renderer
is fatal.
