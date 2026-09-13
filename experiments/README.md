# Experiments

The measurements that shaped `src/main/governor/`.

These are kept because the governor's design is not what it would have been if
it had been reasoned out rather than measured. Every one of the "obvious"
memory levers in an Electron browser turned out to be a loss, and three
separate features were removed because a run in this directory contradicted
the assumption behind them. Someone will eventually want to re-add them; these
are the receipts.

Each file is a small standalone Electron app that isolates one variable and
prints a number. They share `lib.js` for measurement helpers — notably
`settledRss`, which samples repeatedly before reporting, because a single
`getAppMetrics()` call catches whatever the allocator happened to be doing at
that instant and is not trustworthy to the megabyte.

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

## What each one established

| # | Question | Answer | Consequence in the browser |
|---|---|---|---|
| 01 | Can a frozen page answer CDP, and unfreeze? | Yes to both, including `Runtime.evaluate` | The `FROZEN` tier is safe to use. The activation hang was our own bug, not a protocol limit |
| 02 | What is segfaulting tabs on activation? | Only **IPC to a purged renderer**. Freezing, view toggling and the probe are innocent | `Tab#sendToPage` — one gate every message to a page goes through |
| 03 | What does each trim lever reclaim? | GC −5 MB; forced purge **−0 MB**, and it kills the in-page probe | `forciblyPurgeJavaScriptMemory` removed entirely |
| 04 | What does *asking* for a GC cost? | Heap profiler agent: **+6 MB per renderer**, never returned. Net −6 MB on a heavy page, **+9 MB on an ordinary one** | Forced collection removed; `COLD` performs no renderer action |
| 05 | What happens if we just leave a hidden tab alone? | Chromium reclaims further unaided (117→107 MB) than a forced GC achieves (112 MB); freezing **stops** that reclamation | Freezing reserved for tabs still burning CPU while hidden |
| 06 | What does holding a CDP session cost? | +3 MB/renderer; freeze works without `Page.enable`; page **stays frozen after detach** | `Page.enable` dropped; session detached once frozen, and again when a tab goes active |

## The through-line

Experiments 03, 04 and 05 together overturned the original design. It assumed
the way to make a browser use less memory is to squeeze live renderers. Every
measurement said otherwise:

- The strongest squeeze available (`forciblyPurgeJavaScriptMemory`) reclaims
  nothing that a normal collection has not already reclaimed, and breaks the
  page's instrumentation doing it.
- Asking for that collection costs more in instrumentation than the collection
  returns, on any page without an unusually large collectable heap.
- Chromium already reclaims backgrounded renderers on its own, and goes
  further than a forced collection does — so the correct action on an idle tab
  is **no action at all**.
- Freezing, which looks like a pure win, has a memory cost precisely because
  it stops that background reclamation.

The 12-tab benchmark is what made this visible: the governor was using ~90 MB
*more* than no governor at all, entirely in renderer processes. Per-tab
measurement had said the opposite, because it had been run on a heavy page —
the one shape where forcing a collection pays. Both numbers were correct; the
sample was not representative.

What survived: the memory savings come from **discarding tabs** and from the
**process configuration** (one renderer per site, no spare renderer, a renderer
cap), not from squeezing live renderers. The CPU savings come from **freezing
background CPU burners**, **priority management**, and the **animation boost**.

Reproduce the headline numbers with `npm run bench` on `claude/master-build`.

## Note on absolute numbers

Every figure here was measured on one host (4-core, 16 GB, Linux, Electron
44.3.0, software rasterization) and will differ elsewhere. The *directions*
are what the design rests on, and those held across every re-run: purge
reclaims nothing, the heap profiler costs more than it saves on ordinary
pages, unaided background reclamation beats a forced collection, and IPC to a
purged renderer is fatal.
