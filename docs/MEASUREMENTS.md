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
