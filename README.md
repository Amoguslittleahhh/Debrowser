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

## A second round: bounding memory by tab count

The first round of measurements was about *how much a live renderer can be made
to give back*, and the answer was "almost nothing, and asking costs more than
you get". That left an obvious gap, which a real usage pattern exposed: someone
who opens tabs in bursts.

For them the memory budget is the wrong instrument entirely. It is sized to the
host, so on a 16 GB machine it sits near 6 GB — and thirty tabs at ~100 MB each
never reach it. Every policy in the governor correctly concluded there was
nothing to do while memory climbed to 3.1 GB.

| | baseline | governed | delta |
|---|---|---|---|
| total resident, 30 tabs | 3081 MB | 1156 MB | **−62%** |
| peak during load | 3083 MB | 1165 MB | **−62%** |
| renderer processes | 31 | 9 | −22 |
| live tabs | 30 | 8 | −22 |

What fixed it was a cap on *how many tabs may hold a renderer*, enforced by
discarding least-recently-used first — bounding the footprint by the thing that
actually varies. Plus load admission, because peak memory is a loading-time
phenomenon and a burst otherwise spikes well above where it settles.

### The measurement that was lying

The first honest version of this number was 648 MB, and it was wrong.

Every fixture in `test/pages/` is a `file://` URL, and **all `file://` pages are
a single site** as far as Chromium's process model is concerned. With
one-renderer-per-site enabled, thirty fixture tabs collapsed into two processes.
The benchmark was measuring a configuration nobody browses in, and reporting a
saving of 79%.

Serving the same fixtures over HTTP on distinct hostnames (`t1.test`, `t2.test`,
… via `--host-resolver-rules`) put the real number at 1156 MB — still a 62%
saving, but from the cap rather than from process sharing, which for thirty
*different* sites does nothing at all. `experiments/` and the smoke suite both
use distinct origins now, and `--origins=file` keeps the old behaviour available
for comparison.

The general lesson is the same one that produced experiment 04: a per-tab figure
measured on one page shape does not generalise. There, a heavy page made forced
GC look like a win. Here, same-site fixtures made process sharing look like one.

### A regression the fidelity fix exposed

Turning on one-renderer-per-site broke per-tab CPU, and the smoke suite caught
it: a busy tab and a completely idle tab both reported 0.25%.

Sharing a process's CPU out proportionally asserts that every tab in a shared
renderer is equally busy. So a single busy tab made the governor freeze its
quiet neighbours — and freezing costs memory. Per-tab CPU now comes from the
per-document `TaskDuration` metric, differenced over wall time.

That fix has a known edge: `TaskDuration` covers a page's main thread, not its
Web Workers. A worker-busy tab in a *shared* renderer is therefore not
attributable to one tab and does not trigger a freeze. Freezing the wrong page
is worse than freezing nothing, so the conservative failure mode was chosen
deliberately — and `busy.html` exists to keep that honest, since it does its
work in a worker precisely to probe this boundary.

---

## A third round: the numbers themselves were wrong

The request changed: make each tab cheaper, rather than limit how many tabs can
be live. Chasing that found something worse than a missing optimisation.

**Every memory figure this project had produced was summed RSS**, and RSS counts
pages shared between processes — chiefly the Chromium binary, mapped into every
renderer. Summing it across processes counts one copy of Chromium once per
renderer. Six tabs of a trivial page:

```
summed RSS   810 MB      <- what had been reported
summed PSS   247 MB      <- actual physical memory
per tab      85.7 MB RSS  ->  19.8 MB PSS  (10.1 MB private)
```

Three to four times over-stated, depending on the workload. Two consequences,
one of them worse than embarrassing:

- Every claim about footprint and saving was inflated by that factor.
- The governor compared that figure against its memory budget, so it believed
  it was over budget at a third of the real usage and reclaimed far harder than
  necessary. The measurement error was *driving policy*.

The browser now reads `/proc/<pid>/smaps_rollup` for proportional set size on
Linux and falls back to RSS elsewhere, labelling which it used. A smoke check
asserts the proportional total is well below the naive RSS sum, because this is
an easy fix to revert by accident and the only symptom is numbers that look big.

### The error was also hiding a bad flag

Under RSS, every flag configuration reads 85–113 MB per tab and the differences
disappear into shared-page noise. That is precisely how
`--max-semi-space-size` survived in the codebase: it had been added on a
plausible argument about V8 scavenger semi-spaces, never measured, and RSS could
not have detected that it did nothing.

Measured in PSS, on a DOM-heavy page, per tab:

| configuration | per-tab PSS |
|---|---|
| none | 37.9 – 41.2 MB |
| `--js-flags=--optimize-for-size` | **33.0 MB** (−13% to −20%) |
| `--enable-low-end-device-mode` | 32.9 MB — same saving, does not stack (33.5 MB combined) |
| `--max-semi-space-size=2` / `=16` | 38.4 MB — no effect at any value |
| `--num-raster-threads=1` | 40.4 MB — **worse** |
| `--disable-features=BackForwardCache` | no effect |
| `spellcheck: false` | no effect (0.1 MB) |
| `--disable-features=Translate,OptimizationHints,MediaRouter` | no effect |

One flag of eight does anything. Low-end-device-mode reaches the same floor but
shrinks image caches and disables visible features to get there, so it is not
worth paying for a saving already obtained.

### Where per-tab memory actually goes

About 10 MB of a light tab's marginal cost is Chromium's own per-renderer
baseline — no flag tested here reduces it. The remaining lever is **not paying
for a renderer at all**: one renderer per site (30 same-site tabs cost 11.6 MB
each against 19.7 MB across 30 different sites), no spare renderer, and lazy
background tabs.

Thirty tabs, all live, nothing discarded: **592 MB** across 30 sites, **348 MB**
on one site.

---

## A fourth round: applying the literature, including what did not apply

Three papers were handed over. One was directly actionable, one describes the
trade this browser makes by hand, and one cannot be reached from here. Saying
which is which matters more than claiming all three were used.

**Optimal Heap Limits for Reducing Browser Memory Use** (Kirisame, Shenoy &
Panchekha, OOPSLA 2022, arXiv:2204.10455) is the on-point one. A heap limit
trades memory against GC time, and the obvious rules are not *compositional*:
with several heaps, one multiplier produces a memory allocation across them that
does not minimise total GC time. Their result is

```
M = L + sqrt(L * g / (c * s))
```

with L live memory, g allocation rate, s collection speed, and c shared by every
heap. Every term but c is local, so each tab computes its own limit and the
allocation across tabs still comes out optimal — coordination without
communication. Their MemBalancer prototype patches V8 and reports ~16% less
memory at constant GC time.

Implemented in `src/main/governor/heap-limit.js`, weighting c per tab as the
paper permits so hidden tabs get tighter limits. **Then disabled by default, on
measurement:**

- V8's heap is not where a renderer's memory is. A settled DOM-heavy page
  reports ~2 MB committed heap against ~21 MB private — a perfect collection
  leaves ~90% of the tab untouched, the rest being DOM, Blink and malloc.
- V8 already collects a backgrounded heap within ~10 s, so forcing it earlier
  mostly does sooner what happens anyway. Across 20 tabs: 1 MB difference.

The gap from 16% is the implementation, not the rule. They set a real V8 heap
limit and thereby change how V8 schedules *its own* collections. Nothing in
Electron or the DevTools protocol can set that limit, so here the rule can only
fire collections we request — strictly later, and costing a debugger session.
Getting there took three bugs, each of which silently made the rule inert:
screening on PSS (which falls as more processes share the binary, so every tab
fell under the threshold); comparing the limit against `JSHeapUsedSize` when M
bounds the committed *size*; and having no trigger for load-time garbage, which
is a one-time backlog rather than steady-state growth.

**Mesh** (Powers, Tench, Berger & McGregor, arXiv:1902.04738) compacts C/C++
heaps without moving pointers, using virtual memory to merge sparse pages. It
addresses exactly the fragmentation that makes up part of that 21 MB of
non-V8 private memory — but applying it means replacing PartitionAlloc inside
Chromium, not configuring a browser built on it. Not applied, and not claimed.

**TME-Box** (Unterguggenberger et al., arXiv:2407.10740) gets scalable
in-process isolation from Intel TME-MK memory encryption keys. It is the most
interesting of the three for this project conceptually, because it answers the
exact dilemma the `minimal` profile resolves by hand: isolation costs a process
per principal, and a browser pays that per site. Hardware that isolated
principals *within* a process would make the security/memory trade disappear. It
needs specific Intel hardware plus compiler and kernel support, so it is
unreachable from an Electron app. Not applied.

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
| 07 | Is summed RSS a truthful footprint? | No — overstates by 3-4x | PSS accounting throughout; budget compared against it |
| 08 | Which flags reduce what one tab costs? | One of eight: `--optimize-for-size` | Shipped; `--max-semi-space-size` removed |
| 06 | What does holding a CDP session cost? | +3 MB/renderer; freeze works without `Page.enable`; page **stays frozen after detach** | `Page.enable` dropped; session detached once frozen, and again when a tab goes active |

Round two was measured with `npm run bench` rather than with a dedicated
experiment, because the question - what does thirty tabs cost - is exactly what
the benchmark already asks. Its per-process-type breakdown and its `liveDetail`
output (which says *why* each surviving renderer survived) were what made the
answers legible.

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
