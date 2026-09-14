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
canvas, an open socket. Those are capped at FROZEN and hold their full footprint
indefinitely because discarding them would lose state. Hibernation returns ~half
of that, losslessly, for a 4-12ms resume - and it is the only lever that works on
them at all.
