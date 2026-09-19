# Phase 0 measurements

Numbers behind the residency work. Host: linux x64, 4 cores, 16075 MB RAM,
Electron 44.3.0, software rasterization. PSS unless stated.

## M1 — fixed overhead and marginal renderer cost  (gate: proceed if fixed < 250MB)

Host: linux x64, 4 cores, 16075 MB RAM. Governor OFF, distinct origins, mix=noforms.

## The fit

    1 tab    221 MB    2 renderers   {Browser:88, GPU:22, Utility:28, Tab:83}
    2 tabs   235 MB    3 renderers   {Browser:89, GPU:21, Utility:27, Tab:97}
    4 tabs   262 MB    5 renderers   {Browser:88, GPU:21, Utility:26, Tab:127}
    8 tabs   316 MB    9 renderers   {Browser:88, GPU:19, Utility:26, Tab:182}
   16 tabs   421 MB   17 renderers   {Browser:95, GPU:19, Utility:25, Tab:283}
   30 tabs   605 MB   31 renderers   {Browser:105,GPU:19, Utility:26, Tab:455}

Two independent least-squares fits agree closely:
  tabs 1-8   : total = 207.7 MB + n x 13.5 MB
  tabs 16-30 : total = 210.7 MB + n x 13.1 MB

**Marginal cost is ~13.2 MB/tab, not 19.8 MB.** The 19.8 figure in the README is
total/tabs, which folds in fixed overhead. The plan's arithmetic used 19.8 as a
per-renderer cost; that was wrong and the real number is better.

## ACCOUNTING BUG: getAppMetrics() omits the zygotes

Reconciled `app.getAppMetrics()` against a direct /proc descendant sweep on a
minimal harness (about:blank, one WebContentsView):

    getAppMetrics total : 167 MB across 4 processes
    /proc sweep total   : 196 MB across 6 processes
    seen by /proc only  : zygote 14.4MB | zygote 14.5MB

**Every memory figure this repo has published is low by ~29 MB**, because
`memory.js`/`bench.js`/`smoke.js` all enumerate via `getAppMetrics()`. Same class
of error as the RSS-vs-PSS correction. Corrected headline figures:

    30 tabs, all live:  605 -> ~634 MB total,  19.7 -> ~21.1 MB/tab
    fixed overhead   :  209 -> ~238 MB

## Not part of the browser

`node ./node_modules/.bin/electron` (the npm launcher shim) measures 43 MB in a
/proc sweep. It is NOT in getAppMetrics and does not exist in a packaged app.
Correctly excluded; do not count it.

## Composition of fixed overhead (4 tabs, /proc, PSS)

    browser-main        86.3 MB   (67.4 private)   <- largest single item
    utility(network)    26.8 MB
    zygotes             25.1 MB   (2 processes)
    gpu-process         20.3 MB   (even with --disable-gpu)
    chrome UI renderer  ~20 MB

A bare Electron app (about:blank, no Debrowser code) shows Browser=82 MB. So the
browser process is Electron's floor, not this project's code, and is not
meaningfully optimisable from here.

## Gate outcome: PROCEED, but the target is tighter than planned

    budget at 30 tabs                 300 MB
    true fixed overhead              -238 MB
    per-tab browser-side cost (x30)   -18 MB   (Browser grew 88->105 over 29 tabs)
    ----------------------------------------
    left for live renderers            44 MB   =  3-4 live renderers at 13.2 MB

Fixed overhead is ~79% of the entire budget. The plan assumed a live set of 6-8;
the honest number is **3-5**, and that is only if fixed overhead is left alone.

**Implication for the plan:** residency alone no longer reaches <10 MB/tab
comfortably. Fixed overhead is now co-equal with residency as a target, and the
plan under-weighted it. Candidates not currently in the plan: the network utility
(27 MB), the GPU process (20 MB with GPU already disabled), and whether both
zygotes are needed.


---

## M7 — can fixed overhead be reduced?  NEGATIVE RESULT

6 tabs, governor off, 2 reps each, distinct origins.

    variant                total   renderers   breakdown
    baseline               313 MB      7       {Browser:87, GPU:20, Utility:26, Tab:157, zygote:23}
    in-process-gpu         312 MB      7       {Browser:98, Utility:26, Tab:160, zygote:28}
    no-zygote              177 MB      0       {Browser:103, GPU:37, Utility:37}
    network-in-process     315 MB      7       {Browser:88, GPU:20, Utility:25, Tab:158, zygote:23}
    all three              165 MB      0       {Browser:119, Utility:46}

## Every lever fails

**--in-process-gpu: -1 MB, i.e. nothing.** The GPU process disappears but the
browser process grows by almost exactly what it held (87 -> 98MB). The work moves;
it does not go away. Costs GPU crash isolation for no memory.

**--enable-features=NetworkServiceInProcess: +2 MB, and the flag did not apply.**
The Utility process is still present at 25MB in the variant run. Wrong feature
name for this Chromium, or not honoured. Either way, no effect.

**--no-zygote: appears to save 136 MB, actually renders nothing.** Confirmed by
sweeping /proc directly during a run: the only processes are main (103MB),
gpu-process (36MB) and utility (36MB) - **zero renderer processes**. The bench
reports liveTabs:3 because the Tab objects exist, while liveRenderers:0 because
no renderer was ever launched. A browser that displays no pages is not a memory
optimisation. `--no-zygote` is unusable here.

**"all three" is the same broken configuration** and its -148MB is the same
artefact.

## Conclusion

Fixed overhead is **not reducible by collapsing auxiliary processes**. The three
candidates identified from M1's breakdown - GPU 20MB, network utility 27MB,
zygotes 25MB - are each either load-bearing or merely relocate their cost into
the browser process.

Combined with M1's finding that a bare Electron app with one about:blank view
already shows Browser=82MB, the conclusion is that **~238MB of fixed overhead is
Electron's floor on this platform** and this project cannot move it.

## What this does to the target

    total(n) = 238 fixed + 0.6n browser-side-per-tab + 13.2 x min(n, liveCap)

With a live cap of 4, per-tab = 0.6 + 290.8/n:

        20 tabs   15.1 MB/tab
        30 tabs   10.3 MB/tab
        32 tabs    9.7 MB/tab   <- crosses under 10
        40 tabs    7.9 MB/tab
        50 tabs    6.4 MB/tab

**The chosen metric improves with tab count**, because fixed overhead amortises.
So "<10MB per open tab" is reachable from roughly 32 tabs upward and is NOT
reachable at 20 tabs or fewer, at any live cap. That is a property of the metric,
not a failure of the design, and it must be stated wherever the figure is quoted.

---

## M5 — does freezing a whole renderer trigger Chromium's purge?  NEGATIVE RESULT

Three same-site tabs (heavy.html) in one renderer under `--process-per-site`,
all hidden, renderer PSS sampled every 15s for 60s after the freeze.

    case        frozen   before            after 60s         delta
    none         0/3     73.9 PSS / 52.7   72.2 / 50.8       -1.7 MB
    one          1/3     73.8 PSS / 51.8   75.4 / 52.8       +1.6 MB
    all          3/3     73.5 PSS / 51.5   75.0 / 52.4       +1.5 MB

Chromium's `MemoryPurgeManager` schedules a renderer purge when *all* of that
renderer's pages are frozen, so with process-per-site on, freezing one tab of a
shared renderer should never earn the purge. The hypothesis was that the repo's
recorded "freezing costs ~5MB" was really the cost of freezing without ever
earning the purge.

**It is not.** Freezing all three pages performs identically to freezing one
(+1.5 vs +1.6MB), and both are ~3.2MB worse than leaving the renderer alone.
Whole-renderer freezing buys nothing, and the existing rule - freeze only tabs
still burning background CPU - is correct as it stands.

Gate was ">= 3MB/tab to keep". Actual is 0. Lever dropped.

Note on validity: the harness window is never shown, so every renderer is
backgrounded throughout. That could mask a purge that only fires on a
transition. It does not affect the comparison being drawn, since both arms run
under identical conditions and differ only in how many pages were frozen.

---

## M8 — is hover-prefetch worth it?

Six reps, A/B over the same fixture pages. Timed from the activation call until
the page has finished loading - the window a user spends looking at a
placeholder.

    cold        p50 139.5 ms   (min 122.5, max 183.2)
    prefetched  p50   0.5 ms   (min   0.5, max   0.7)

**Read this carefully; the headline overstates it.** The fixture is served from
localhost and loads in ~140ms, which is *shorter than the 150ms dwell*. So the
page had already finished loading before the click landed, and activation had
nothing left to wait for. That is not what a real page will do.

The honest statement of the benefit: the saving is bounded by the dwell, not by
the page load. A page that takes 800ms will still take about 650ms after a 150ms
head start - a real improvement, and not the near-elimination this measurement
shows. Any figure quoted from this experiment must carry that caveat.

The cost side cannot be measured by `npm run bench`, which never moves a pointer
and so never speculates at all. It is bounded by construction instead: one
speculation in flight at a time, refused under any memory pressure, refused
while anything is animating, refused at the live-renderer cap, routed through
the same concurrent-load limit as any other realise, and expired by the idle
ladder if the user does not act on it. The smoke suite asserts the one-at-a-time
rule and the expiry.

---

## M4 / M4b — does trimming a hidden renderer return memory? YES (after two false negatives)

`process_madvise(MADV_PAGEOUT)` over a hidden, frozen renderer's private
anonymous regions, with 4GB of lzo-rle zram configured and `CAP_SYS_NICE` held.

### The result that counts

Renderer holding a 254MB live JS heap (`test/pages/bigheap.html`):

                     PSS     private  | sys avail    zram stored / physical
    before trim    327.5      303.4   |  15089 MB      0.0  /   0.0 MB
    10s after       57.9       33.7   |  15238 MB    264.2  / 123.6 MB

    private freed from process : 269.7 MB
    zram physical growth       : 123.6 MB   (compression 2.1:1)
    NET system reclaim         : 146.1 MB
    MemAvailable moved         : +149 MB    (independent corroboration)
    resume cost                : 12 ms

The net figure is what matters: 269.7MB left the process and 123.6MB of it
reappeared as zram's own allocation, so the system got 146MB back. System-wide
MemAvailable agreeing to within 3MB is the check that distinguishes a real
saving from pages merely moving into the compressor's accounting - without it
this would look like a 270MB win.

A 2.1:1 ratio is what varied object data does. An earlier sanity check hit
39:1 because the test buffers were a single repeated byte; a fixture that
flatters the mechanism is worse than no fixture, which is why
`bigheap.html` builds deliberately varied records.

### Two false negatives first, both mine

The first two runs reported ~1MB reclaimed and were both invalid.

**The probe was broken.** V8 reserves an enormous virtual address range for its
heap cages - measured at **1446.7 GiB** in one renderer. The probe walked
`/proc/<pid>/maps` and handed every private anonymous region to
`process_madvise`, which returns at most `0x7FFFF000` bytes per call. The
reservations consumed the entire per-call cap before reaching a single resident
page: analysis of the renderer's smaps showed the cap was hit after **0 of 214
regions**, covering **0 MiB of 281 MiB** resident. The syscall returned success
each time.

**And the compressor had gone away.** zram's `disksize` reset to 0 between setup
and execution, so there was no swap to page into either. Two independent faults
producing the same null result, which is why it read as convincing.

Fixed by reading `smaps` rather than `maps` and advising only regions with
`Rss > 0`, batched under the syscall cap - 115 regions and 917MB advised rather
than 214 regions and 1.4TiB. The harness now refuses to emit a figure at all
unless zram is active, so this cannot silently recur.

**The lesson worth keeping:** a syscall returning success is not evidence it did
anything. Both `advised=` and a system-wide counter had to be read before the
result meant anything.

---

## M4c — the reclaim curve, and where the gate belongs

Same harness as M4b across heap sizes. "NET" is private freed from the process
minus zram's own physical growth, i.e. what the system actually got back.

    private before   NET reclaim   % of private   resume
        37 MB           10.9 MB         29%        4.0 ms
        63 MB           22.6 MB         36%        4.6 ms
        83 MB           32.5 MB         39%        3.9 ms
       144 MB           66.7 MB         46%        4.9 ms
       194 MB           94.4 MB         49%        3.0 ms
       303 MB          146.1 MB         48%       12.0 ms

Net reclaim is close to linear in private memory - **roughly 29-49%, rising with
size and plateauing near 48%** - and the resume cost is flat at 4-12ms across the
whole range, an order of magnitude inside the 150ms guard rail.

**There is no dead zone.** The plan assumed light tabs would not pay and the gate
would have to sit high. That assumption came from M4's broken probe, which
reported ~1MB on a 37MB-private renderer; the same tab measured with the fixed
probe returns **10.9MB**, which is most of the 13.2MB marginal cost of a tab.
A gate around 30MB private is defensible - below that the absolute return falls
under ~9MB - but it is a floor on pointless work, not a threshold separating
tabs that pay from tabs that do not.

**One flake, worth recording.** The first 150MB run reported 3.6MB net. Two
re-runs returned 95.6MB and 93.2MB, so the low reading was noise rather than a
non-monotonicity in the curve, and the curve above uses the mean of the repeats.
A single anomalous point in a monotonic series is worth re-running before it is
explained.

### What this does and does not change

It does not move the headline. Discard still reclaims far more - a discarded tab
is ~0.2MB against ~48% of a hibernated one - and the residency work already
reaches 8.1MB per open tab at 45 tabs.

Where it matters is the **protected set**: tabs holding unsubmitted input, a live
canvas, an open socket. Those cannot be discarded without losing state, so
without this tier they hold their full footprint indefinitely. Hibernation
returns ~half of that, losslessly, for a 4-12ms resume - and it is the only lever
that works on them at all.

A code review caught that this did not actually happen: every "do not destroy
this tab" protection capped at FROZEN, one rank above HIBERNATED, so the tier was
unreachable for exactly the tabs it was built for. With the protections capped at
HIBERNATED instead, `--mix=bigheap` at 12 tabs measures:

```
                     baseline    governed
total resident        1409 MB      481 MB      -928 MB  (-65.9%)
system available     14125 MB    14560 MB      +435 MB
compressor holding         -       267 MB   from 576 MB stored
tab states                      {"active":1,"discarded":4,"hibernated":7}
```

The independent `MemAvailable` reading is the one that makes it trustworthy: 576
MB left the renderers and 267 MB came back as zram's own allocation, so the net
is real and roughly half the per-process figure - the 2:1 accounting trap, seen
directly.

### The capability probe was testing the wrong process

`mem-trim`'s `caps` command answered "can this machine trim?" by trimming
**itself**. Since Linux 6.13 `process_madvise` skips the `CAP_SYS_NICE` check
when the target mm is the caller's own, so on any current kernel that self-test
succeeds whether or not the capability is held - while every real trim, which
targets a renderer, returns `EPERM`. Measured on this host (6.18), with the
capability dropped:

```
old helper, capsh --drop=cap_sys_nice   ->  caps linux 1     (wrong)
new helper, capsh --drop=cap_sys_nice   ->  caps linux 0
new helper, capability held             ->  caps linux 1
```

The helper now forks a child, waits for it to dirty a page, and trims *that* -
the same syscall down the same permission path as a real trim - and reports
failure if zero bytes were advised, since a call that never happened is not a
demonstration that trimming works.

### …and then reported the wrong remedy

Third time for the same class of fault, found by deliberately breaking the
helper four different ways and reading what `trimCapability()` said. Every
unreachable-helper path funnelled into one message, so a binary that was merely
not executable was reported as a missing kernel capability — a confident remedy
(`sudo setcap …`) for a problem the user did not have:

```
                                    before                    after
binary missing        "needs CAP_SYS_NICE: setcap…"   "not built (npm run build:memtrim)"
binary not executable  (crashed the browser)          "could not start helper: …EACCES"
capability dropped    "needs CAP_SYS_NICE: setcap…"   "needs CAP_SYS_NICE: setcap…"
healthy               available                       available
```

The "crashed the browser" row is not hyperbole and was not hypothetical: a write
to a helper that has died raises EPIPE, which Node delivers as an asynchronous
`'error'` event rather than throwing from `write()`, so the `try`/`catch` around
the write never saw it — and an `'error'` event with no listener terminates the
process. A dead memory-trim helper took the whole browser with it.

The rule this keeps re-teaching: a capability report is only worth having if each
distinct failure produces a distinct, *checkable* message. Collapsing them costs
nothing until someone follows the advice.

---

## Hibernation in the benchmark — 605MB without discarding anything

`npm run bench -- --tabs=6 --mix=bigheap`, six application-weight tabs (120-200MB
of live JS each):

                    baseline   governed    delta
    total resident   1084 MB     479 MB   -605 MB  (-55.8%)
    per tab          180.7 MB    79.8 MB
    renderers              7          7        0
    tab states       all live    { active: 1, hibernated: 5 }

**Nothing was discarded.** All seven renderers stayed alive with their page state
intact; the saving is entirely pages moved into the compressor. This is the first
workload here where reclaim cost no reload at all.

### Why the other mixes show the tier never firing

A run on `noforms` reports `{ active: 1, discarded: 12, cold: 5, frozen: 2 }` and
no hibernation at all. That is the gate working, not a failure: those fixtures
hold roughly 10-36MB private, and the 30MB floor correctly excludes them because
the measured return at that size (~10MB) is not worth a syscall and a resume
stall on a tab that could simply be discarded for more.

It is worth stating because the two readings look contradictory. Hibernation is
not a general-purpose lever - it is for tabs heavy enough to be worth compressing
and protected enough that discarding them is not allowed. `--mix=bigheap` exists
so that case is reproducible rather than asserted.

The headline workload is unaffected either way: 30 tabs on the default cap
measured 363MB / 12.1MB per tab with the tier live, against 362MB / 12.1MB
before it existed.

---

## Lever 4 — parking hidden views. NEGATIVE RESULT, not built

Eight tabs of `heavy.html`, one visible, measured with every hidden view
attached to the window and again with each removed via `removeChildView`:

    8 tabs, views attached   total 364 MB   {Browser:82, GPU:19, Utility:25, Tab:215}
    hidden views parked      total 363 MB   {Browser:81, GPU:19, Utility:26, Tab:215}
    re-attached              total 364 MB   {Browser:81, GPU:19, Utility:26, Tab:215}

**1MB across eight tabs**, and `GPU` does not move at all. The gate was a
measurable drop in `breakdown.GPU`; there is none. Chromium already releases a
widget's compositor tiles when it is hidden, which `setVisible(false)` does, so
by the time a view is parked there is nothing left in it to release.

Re-attaching returned to the original figure exactly, so `addChildView` /
`removeChildView` churn does not leak - the mechanism works, it just has nothing
to reclaim.

Not built. It would have added a detach/re-attach path, a first-paint hazard on
re-attach, and a `layout()` special case for views not in the tree, in exchange
for 0.125MB per tab.

One caveat on scope: this host runs with `--disable-gpu`, so compositing is
software. A machine doing real GPU compositing may hold per-view surfaces that
this cannot see. If anyone revisits it, that is the configuration to measure -
and `breakdown.GPU` is still the number to watch.

---

## 8a — is there a per-open-tab cost worth bounding?  NO. The model was wrong.

The premise: `Tab#captureNavigation` stores `nav.getAllEntries()` unbounded, and
the model said each open tab costs 0.6MB in the browser process forever - the one
term that never amortises, worth 60MB at 100 tabs. Both halves turned out to be
wrong, and the second one matters.

### Navigation history is not the cost

    history depth    retained
        5 entries      4.7 KB      (934 B/entry)
       20 entries     18.8 KB      (934 B/entry)
       50 entries     46.8 KB      (934 B/entry)

Linear at 934 bytes per entry, so a realistic 20-deep history is 19KB - three
percent of the 600KB the hypothesis needed.

### A discarded tab leaves ~950KB, and 99.6% of it is not ours

    baseline (no tabs)      86.9 MB
    30 tabs live           101.2 MB
    30 tabs discarded      114.7 MB    <- MORE than when they were live

    residue per discarded tab : 949 KB
    of which our stored state :   4 KB

Discarding thirty renderers made the browser process *grow* by 13.5MB. That
looks alarming and is not: cycling a second identical batch through grew it by
**-0.2MB**, so the residue is allocator slack reused by the next tab, not a leak.

### The asymptote does not exist

Built 60 tabs one at a time, discarding each immediately, so open tabs rose
while live renderers stayed at zero:

     0 tabs      85.7 MB
    15 tabs      98.9 MB     901 KB/tab
    30 tabs     100.4 MB     102 KB/tab
    45 tabs     101.0 MB      41 KB/tab
    60 tabs     100.2 MB     -55 KB/tab

**The cost is a one-time allocator warm-up of ~13MB that saturates by about 30
tabs, then flat.** The browser process holds ~100MB whether sixty discarded tabs
are open or thirty.

### The corrected model

    was:  total(n) = 238 fixed + 0.6 MB x tabs_open + 13.2 MB x min(n, cap)
    is:   total(n) = 238 fixed (including ~13MB browser high-water, saturating
                     by ~30 tabs)  +  13.2 MB x min(n, cap)

The `0.6 MB x tabs_open` term was an artefact: M1 measured it with the governor
off, so all thirty of those tabs were **live**, and it captured Chromium's
per-live-WebContents cost rather than the residue of a discarded one.

Per-tab memory therefore falls toward zero as tabs are opened rather than
converging on a floor - which is why 45 tabs measured 8.1MB/tab and 100 would be
around 3.4. **Opening more tabs is already free**, and there is nothing here to
bound. 8a is closed with no change made: capping navigation history would save
4KB against a per-tab cost that is already approximately zero.

The whole of the remaining cost is now the 238MB intercept.

---

## 8b / 8c — the fixed overhead is irreducible. The investigation is closed.

### 8b — are the caches sized from host RAM?  No.

Six tabs, governor off, two reps each, on a 16GB host:

    variant                  total    delta
    baseline                 316 MB       0
    disk-cache=1MB           316 MB       0
    media-cache=1MB          315 MB      -1
    v8 code cache off        316 MB       0
    main-process V8 tuning   316 MB       0
    all four                 316 MB       0

Every variant inside ±1MB, which is noise. Chromium's caches are not sized from
available RAM in any way these flags reach, and tuning the *browser* process's
own V8 (`--optimize-for-size`, `--max-old-space-size=64`) does nothing either.

### 8c — the true per-process floor: not measurable

`--single-process` collapses every renderer into the browser process, which
would have bounded what 8b could ever have been worth. It does not run: the
harness produces no result at all, the same failure as `--no-zygote` in M7.

### The conclusion

Three independent attacks on the 238MB of fixed overhead, all measuring zero:

    M7   collapse the GPU, network and zygote processes   nothing, or broken
    8b   bound the caches inside them                     nothing
    8c   collapse everything into one process             will not run

Combined with M1's finding that a bare Electron app with one `about:blank` view
already holds 82MB in its browser process, **the fixed overhead is Electron's
and cannot be reduced from outside Chromium.** It is not a lever this project
has failed to pull; it is not a lever.

With 8a showing there is no per-open-tab cost either, the model reduces to:

    total(n) = 238 MB fixed + 13.2 MB x min(n, liveCap)

Every term in that expression is now at a measured floor. **This browser is
finished on memory.** What remains is not optimisation but a different
architecture - a lighter engine, which M6 already argued costs the CDP control
surface the whole governor depends on.

---

## Compression, revisited: what is left to compress, and what can be trusted

The question was whether a homemade compression system could beat what is here.
Four candidates, measured before any of them was built.

### 1. The session state a discarded tab keeps — 1 KB per tab. Not worth it.

`bench/bench.js` now reports it on every run rather than leaving it to be
guessed at, which is how the 0.6MB/tab of the old model got its imagined
mechanism. Thirty tabs, one site each, after the ladder has discarded most of
them:

    retained: 31 KB of session state for 30 tabs (1 KB per tab,
              biggest 1 KB, 29 navigation entries, 29 with page state)

Compressing that perfectly would save 30 KB out of a 372 MB browser. This
confirms 8a above by a second route: the navigation history and form state a
discarded tab holds are not a cost worth attacking, and now nobody has to take
that on trust — the figure prints beside the memory total.

### 2. The history store — real, but only at the ceiling.

10,000 entries (the cap) of realistic URLs and titles, measured in Node:

    raw JSON                        2.03 MB   (213 B/entry)
    live objects                    4.61 MB   heap
    deflate-raw L1                  0.17 MB   11.96x    3.3 ms
    deflate-raw L6                  0.14 MB   14.88x   11.6 ms
    deflate-raw L6 + dictionary     0.14 MB   14.91x   11.5 ms
    brotli q4                       0.14 MB   15.04x   10.2 ms
    brotli q9                       0.07 MB   29.41x   56.2 ms
    inflate                                             1.5 ms

So a full history costs **4.6 MB of heap** and could be held in 0.14 MB — a
~4.5 MB saving, at a 1.5 ms decompression whenever the history page searches
it. Two reasons it is not built. It is 1.2% of a 372 MB browser at the *cap*,
and a history of 500 entries — what a normal profile holds — costs 0.2 MB, so
the lever pays nothing for almost everyone and its complexity (a hot head, a
compressed tail, a hash index to answer "was this visited" without inflating)
would sit in front of every visit and every keystroke of history search.

Recorded rather than done, with the numbers, so it can be picked up if the cap
ever rises or the entry shape grows.

**The preset dictionary bought nothing** (14.91x vs 14.88x). It is the right
tool for many small payloads, not for one 2 MB payload where deflate builds a
better dictionary from the data itself in its own window. Worth knowing before
reaching for it.

### 3. The renderers themselves — the only place left, and not ours to compress.

Per the model above, a live renderer is 13.2 MB and everything else is fixed.
No userspace program can compress another process's pages: the only mechanisms
are the kernel's (zram/zswap on Linux, Windows Memory Compression on Windows),
which is what the HIBERNATED tier already drives. What *is* ours is the policy
and the verification, and both had a hole.

### 4. What was actually wrong, and is now fixed

**The tier was Linux-only.** Windows was an honest stub. It is implemented now:
`SetProcessWorkingSetSizeEx(h, -1, -1)` empties a renderer's working set and
Windows Memory Compression takes what it can. It needs `PROCESS_SET_QUOTA`,
which one process holds over another of the same user with no elevation and no
one-time setup — unlike the Linux half, which needs `setcap cap_sys_nice+ep`.
That is why this half could be written without a machine to run it on. It is
compiled on a real Windows runner in CI, and the suite's checks run there.

**The self-disable was measuring the wrong thing.** It compared a renderer's
private bytes before and after the trim — which is the syscall agreeing with
itself. Pages leaving a process reappear as the compressor's own allocation, at
about 2:1, so on a host where compression achieved nothing the per-process drop
would still have been large and the tier would have stayed on forever. This is
the project's own named worst case ("a syscall returning success is not
evidence it did anything") and it was sitting in the one place that decides
whether the feature keeps running.

The gate is now the machine's own figure — `MemAvailable` on Linux,
`GlobalMemoryStatusEx` on Windows, read through the same helper on both — taken
immediately before and after each trim. That is the reading which caught M4b's
first two false positives by hand; it is automatic now. The panel reports both
numbers side by side ("~270 MB left the renderers, ~146 MB back to the
machine"), because quoting only the first is how a compressor that achieved
nothing reads as a saving.

---

## The browser's own pages were loading through the network stack

`debrowser://` is served by a handler in `pages.js`. It answered every request
with `net.fetch(pathToFileURL(full))` — which sends a request for a file on the
local disk out through the network service and back. Measured by opening the new
tab page cold, the new tab page warm, and Settings, with the real partition,
preload and protocol registration:

```
                       before          after
cold new tab         1758.0 ms        80.1 ms
warm new tab           97.4 ms        81.0 ms
settings, warm        449.1 ms        94.1 ms
in the handler        997.5 ms         8.3 ms   (15 sub-resource requests)
```

Per sub-resource the handler cost 2–6 ms once warm and **60–270 ms on the first
touch of each file**, five requests per page. The new tab page is the
most-opened page in the browser and it paid that every time.

The fix is `fs.readFileSync` and a `Response` with the content type we name.

**A cache was built on top of this and then deleted**, which is the more useful
finding. Reading a page's five files costs **0.040 ms**; a `Map` lookup costs
0.0003 ms. Saving four hundredths of a millisecond is not worth 47 KB per page
held for the life of the browser, nor serving a stale stylesheet after an edit.
The win was never the cache — it was not using the network stack to read a local
file.

## Initial memory: 2.5% of it is ours

Asked whether the memory a freshly-started browser holds could be reduced. One
tab, settled, on Linux:

```
total                285 MB
  Browser            112 MB     of which our JavaScript: 7 MB heap + 4 MB external
  Tab (1 renderer)    93 MB
  Utility             28 MB     network.mojom.NetworkService
  zygote              28 MB
  GPU                 23 MB
```

M1 measured a bare Electron app with one `about:blank` view at 82 MB in its
browser process before any of this project's code runs. So of the 112 MB, about
30 MB is attributable to us, and V8's own accounting puts our JavaScript at 7 MB
of heap plus 4 MB external. **Deleting every line of this project's main-process
code would save ~11 MB of 285.**

The Windows figure a user reported — 312 MB with the new tab page open, one tab —
is the same shape: no zygote, a larger browser and GPU process, and a 43 MB
renderer for the page itself.

The network service starts at launch regardless of what is open; serving our own
pages off the disk avoids *using* it, not starting it. Confirmed by listing the
processes after opening only internal pages: `network.mojom.NetworkService` is
there either way.

This is the same conclusion 8b and 8c reached from other directions, now stated
for the startup case specifically: **initial memory is Electron's and Chromium's,
not this project's.** The bench prints the breakdown and our own heap on every
run so the claim can be rechecked rather than believed.

## Startup memory, attacked directly: one lever, worth 9MB, with a cost

"Can the initial memory be smaller?" — asked after the breakdown above showed
2.5% of it is ours. Four configurations, three runs each, GPU pinned off because
SwiftShader under xvfb swings the total by 70MB and would swamp the comparison.
The chrome view and the new tab page are both up, which is what a freshly
started browser has.

```
baseline                                    235 MB   2 renderers
--process-per-site alone                    235 MB   2 renderers   no change
--js-flags=--optimize-for-size (browser)    235 MB   2 renderers   no change
chrome on debrowser:// + process-per-site   226 MB   1 renderer    -9 MB
```

Only the last one moves, and it needs both halves. The chrome is loaded from
`file://` and the pages from `debrowser://`, which are two sites, so no process
model can merge them; and same-site pages only share a renderer under
`--process-per-site`, because Chromium's default is a process per site
*instance*. With both, the chrome and the new tab page share one renderer: the
renderer total falls 66MB → 49MB while the browser process grows ~3MB.

**Not taken, and the reason is not the 9MB.** Merging them makes the chrome
same-origin with the new tab page and puts them in one process. The chrome holds
the command bridge; every other page in this browser is deliberately kept out of
that process, and privilege here is decided from the sender's live URL precisely
so that a compromised renderer cannot borrow it. Trading a boundary that exists
on purpose for 3% of startup memory is the wrong way round. It also requires
`process-per-site` globally, which the config already documents as a
crash-isolation trade offered in the economy profile rather than by default.

Recorded because the number is real and someone will ask again.

### A stale claim found on the way

`prewarm.js` documented that the tab created after a warmed renderer "lands in
the same process", with two pids as evidence. Re-measured: warmer pid 2092, the
tab that follows pid 2106 — a process of its own. Two views on the same host do
not share one either, by default. The *timing* claim holds exactly (79.3ms cold,
46.1ms warmed), so prewarming works; what buys it is the work a first renderer
pays for once — the zygote fork path, scheme and partition setup, V8's code
cache — not process reuse. The comment has been corrected, because a wrong
mechanism invites the wrong fix next time.
